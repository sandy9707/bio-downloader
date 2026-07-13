const express = require('express');
const axios = require('axios');
const yaml = require('js-yaml');
const Redis = require('ioredis');
const bcrypt = require('bcryptjs');
const md5 = require('md5');
const cors = require('cors');
const rateLimit = require('express-rate-limit');

const app = express();
const port = 13000;
const isTestEnv = process.env.NODE_ENV === 'test';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// ==========================================
// 【安全与限流配置】
// ==========================================
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isTestEnv ? 10000 : 100, // relaxed for tests
  message: { error: '请求过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

const payLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: isTestEnv ? 10000 : 10,
  message: { error: '创建订单过于频繁，请稍后再试' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Redis 状态检查中间件
function redisHealthCheck(req, res, next) {
  if (isTestEnv) return next(); // Bypass in test if redis is mocked or handled
  if (redis.status !== 'ready') {
    return res.status(503).json({ error: '数据库服务当前不可用，请稍后重试' });
  }
  next();
}

// ==========================================
// 【配置区】
// ==========================================
// Redis 数据库配置 (使用 db 5 保证不干扰其他服务)
const REDIS_CONFIG = {
  host: '127.0.0.1',
  port: 6379,
  password: 'redis_Kesx3B',
  db: 5
};

// 键名前缀，确保完全隔离
const KEY_PREFIX = 'biodl:';
function getRedisKey(key) {
  return KEY_PREFIX + key;
}

// 易支付 (Epay) 配置
const EPAY_CONFIG = {
  apiUrl: 'https://zpayz.cn',
  pid: '2026070118081518',
  key: 'G3VCP7yRRKPlvDf3LLx5GGEf2oh64OU8',
  notifyUrl: 'http://107.175.142.245:13000/api/pay/notify',
  returnUrl: 'http://107.175.142.245:13000/pay-success' // 页面由客户端捕获或显示
};

// 开启模拟支付模式 (方便开发调试)
const ENABLE_MOCK_PAYMENT = false;

// 开发者持有的高速度 Clash 订阅链接
const DEVELOPER_SUBSCRIBE_URL = 'https://subbind.yeyeziblog.eu.org/speedup?token=MyqjIpxrzA8WCUCM';

// 价格与流量套餐配置
// 流量单位: 字节 (Bytes). 100G = 100 * 1024 * 1024 * 1024 = 107374182400
const PRICING_PACKAGES = [
  { id: 'pkg_test', name: '100MB 测试包', days: 1, price: 2.00, trafficBytes: 104857600 },
  { id: 'pkg_100g', name: '100GB 高速流量包', days: 60, price: 10.00, trafficBytes: 107374182400 }
];

// 管理员密钥 (仅供后台使用)
const ADMIN_SECRET = 'biodl_admin_2026';

// ==========================================
// 【Redis 初始化与工具函数】
// ==========================================
const redis = new Redis({
  host: REDIS_CONFIG.host,
  port: REDIS_CONFIG.port,
  password: REDIS_CONFIG.password,
  db: REDIS_CONFIG.db,
  retryStrategy: (times) => Math.min(times * 100, 2000)
});

redis.on('connect', () => console.log('Redis 连接成功，使用 DB 5!'));
redis.on('error', (err) => console.error('Redis 发生错误:', err));

// 辅助函数: 生成随机16位 Token
function generateToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 16; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// 密码加盐哈希
async function hashPassword(password) {
  return await bcrypt.hash(password, 10);
}

async function verifyPassword(password, hash) {
  return await bcrypt.compare(password, hash);
}

// ==========================================
// 【用户认证接口】
// ==========================================

// 注册
app.post('/api/auth/register', authLimiter, redisHealthCheck, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  try {
    const userKey = getRedisKey(`user:${username}`);
    const exists = await redis.get(userKey);
    if (exists) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    const token = generateToken();
    const passwordHash = await hashPassword(password);

    // 新注册用户初始化：赠送 200MB 测试流量，有效期 2 天
    const trialExpireDate = new Date();
    trialExpireDate.setDate(trialExpireDate.getDate() + 2);

    const userObj = { username, passwordHash, token, role: 'user' };
    const tokenObj = {
      token,
      username,
      expireAt: trialExpireDate.toISOString(),
      trafficLimit: 209715200, // 200MB
      trafficConsumed: 0
    };

    await redis.set(userKey, JSON.stringify(userObj));
    await redis.set(getRedisKey(`token:${token}`), JSON.stringify(tokenObj));

    res.json({
      success: true,
      token,
      expireAt: tokenObj.expireAt,
      trafficLimit: tokenObj.trafficLimit,
      trafficConsumed: tokenObj.trafficConsumed
    });
  } catch (error) {
    console.error('注册错误:', error);
    res.status(500).json({ error: '服务器错误，请稍后再试' });
  }
});

// 登录
app.post('/api/auth/login', authLimiter, redisHealthCheck, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  try {
    const userKey = getRedisKey(`user:${username}`);
    const userStr = await redis.get(userKey);
    if (!userStr) {
      return res.status(400).json({ error: '用户不存在' });
    }

    const userObj = JSON.parse(userStr);
    const valid = await verifyPassword(password, userObj.passwordHash);
    if (!valid) {
      return res.status(400).json({ error: '密码错误' });
    }

    const tokenKey = getRedisKey(`token:${userObj.token}`);
    const tokenObjStr = await redis.get(tokenKey);
    let tokenObj = tokenObjStr ? JSON.parse(tokenObjStr) : null;

    // 容错：若 token 记录在 Redis 中不存在，重新创建
    if (!tokenObj) {
      const trialExpireDate = new Date();
      trialExpireDate.setDate(trialExpireDate.getDate() + 2);
      tokenObj = {
        token: userObj.token,
        username,
        expireAt: trialExpireDate.toISOString(),
        trafficLimit: 209715200, // 200MB
        trafficConsumed: 0
      };
      await redis.set(tokenKey, JSON.stringify(tokenObj));
    }

    res.json({
      success: true,
      token: userObj.token,
      expireAt: tokenObj.expireAt,
      trafficLimit: tokenObj.trafficLimit,
      trafficConsumed: tokenObj.trafficConsumed,
      isAdmin: userObj.role === 'admin'
    });
  } catch (error) {
    console.error('登录错误:', error);
    res.status(500).json({ error: '服务器错误，请稍后再试' });
  }
});

// ==========================================
// 【管理员接口：设置用户无限流量和时间】
// ==========================================
app.post('/api/admin/set-unlimited', redisHealthCheck, async (req, res) => {
  const { secret, username } = req.body;
  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: '无效的管理员密钥' });
  }
  if (!username) {
    return res.status(400).json({ error: '缺少用户名参数' });
  }

  try {
    const userKey = getRedisKey(`user:${username}`);
    const userStr = await redis.get(userKey);
    if (!userStr) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const userObj = JSON.parse(userStr);
    const tokenKey = getRedisKey(`token:${userObj.token}`);
    const tokenObjStr = await redis.get(tokenKey);
    let tokenObj = tokenObjStr ? JSON.parse(tokenObjStr) : null;

    if (!tokenObj) {
      return res.status(404).json({ error: 'Token不存在' });
    }

    // 设置极大的流量额度 (100TB) 和超长到期时间 (100年)
    const farFuture = new Date();
    farFuture.setFullYear(farFuture.getFullYear() + 100);
    tokenObj.expireAt = farFuture.toISOString();
    tokenObj.trafficLimit = 100 * 1024 * 1024 * 1024 * 1024; // 100TB
    tokenObj.trafficConsumed = 0;

    await redis.set(tokenKey, JSON.stringify(tokenObj));

    console.log(`[Admin] 已为用户 ${username} 设置无限流量和时间`);
    res.json({
      success: true,
      message: `用户 ${username} 已设置为无限流量，到期时间: ${farFuture.toISOString()}`,
      expireAt: tokenObj.expireAt,
      trafficLimit: tokenObj.trafficLimit
    });
  } catch (error) {
    console.error('设置无限流量出错:', error);
    res.status(500).json({ error: '服务器错误' });
  }
});

// ==========================================
// 【用户业务接口】
// ==========================================

// 获取用户信息
app.get('/api/user/info', redisHealthCheck, async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(401).json({ error: '未提供Token' });

  try {
    const tokenKey = getRedisKey(`token:${token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      return res.status(401).json({ error: '无效Token' });
    }

    const tokenObj = JSON.parse(tokenObjStr);
    const now = new Date();
    const expireDate = new Date(tokenObj.expireAt);
    const isActive = expireDate > now && tokenObj.trafficConsumed < tokenObj.trafficLimit;

    res.json({
      success: true,
      token: tokenObj.token,
      username: tokenObj.username,
      expireAt: tokenObj.expireAt,
      trafficLimit: tokenObj.trafficLimit,
      trafficConsumed: tokenObj.trafficConsumed,
      isActive
    });
  } catch (error) {
    res.status(500).json({ error: '查询失败' });
  }
});

// 流量消耗统计接口 (由客户端在成功下载后调用汇报)
app.post('/api/user/consume', async (req, res) => {
  const { token, bytes } = req.body;
  if (!token || bytes === undefined) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const bytesVal = parseInt(bytes);
  if (isNaN(bytesVal) || bytesVal < 0) {
    return res.status(400).json({ error: '无效的流量值' });
  }

  try {
    const tokenKey = getRedisKey(`token:${token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      return res.status(401).json({ error: '无效Token' });
    }

    const tokenObj = JSON.parse(tokenObjStr);
    tokenObj.trafficConsumed += bytesVal;

    await redis.set(tokenKey, JSON.stringify(tokenObj));

    res.json({
      success: true,
      trafficLimit: tokenObj.trafficLimit,
      trafficConsumed: tokenObj.trafficConsumed
    });
  } catch (error) {
    console.error('更新流量消耗出错:', error);
    res.status(500).json({ error: '更新流量消耗失败' });
  }
});

// ==========================================
// 【支付模块】
// ==========================================

// 获取套餐价格列表
app.get('/api/pay/packages', (req, res) => {
  res.json({ success: true, packages: PRICING_PACKAGES });
});

// 创建支付订单
app.post('/api/pay/create', async (req, res) => {
  const { token, packageId, payType } = req.body; // payType: 'alipay' | 'wxpay'
  if (!token || !packageId || !payType) {
    return res.status(400).json({ error: '参数不全' });
  }

  try {
    const tokenKey = getRedisKey(`token:${token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      return res.status(404).json({ error: 'Token不存在，无法支付' });
    }

    const selectedPkg = PRICING_PACKAGES.find(p => p.id === packageId);
    if (!selectedPkg) {
      return res.status(400).json({ error: '无效的套餐ID' });
    }

    const orderId = 'ORD_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const orderData = {
      orderId,
      token,
      packageId,
      days: selectedPkg.days,
      price: selectedPkg.price,
      trafficBytes: selectedPkg.trafficBytes,
      payType,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    // 存入 Redis 并设置 2小时 过期时间
    const orderKey = getRedisKey(`order:${orderId}`);
    await redis.setex(orderKey, 7200, JSON.stringify(orderData));

    // 模拟支付模式：如果启用，返回模拟支付 URL
    if (ENABLE_MOCK_PAYMENT) {
      return res.json({
        success: true,
        checkoutUrl: `http://107.175.142.245:13000/mock-pay.html?orderId=${orderId}`
      });
    }

    const host = req.headers.host;
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const notifyUrl = host ? `${proto}://${host}/api/pay/notify` : EPAY_CONFIG.notifyUrl;
    const returnUrl = host ? `${proto}://${host}/pay-success` : EPAY_CONFIG.returnUrl;

    // 易支付参数组装与签名
    const params = {
      pid: EPAY_CONFIG.pid,
      type: payType,
      out_trade_no: orderId,
      notify_url: notifyUrl,
      return_url: returnUrl,
      name: `Bio-Downloader ${selectedPkg.name}`,
      money: selectedPkg.price.toFixed(2),
      sign_type: 'MD5'
    };

    const sortedKeys = Object.keys(params).filter(k => k !== 'sign_type').sort();
    let signStr = sortedKeys.map(k => `${k}=${params[k]}`).join('&');
    signStr += EPAY_CONFIG.key;
    const sign = md5(signStr);

    const queryParts = [];
    for (const key of Object.keys(params).sort()) {
      queryParts.push(`${encodeURIComponent(key)}=${encodeURIComponent(params[key])}`);
    }
    queryParts.push(`sign=${sign}`);

    const checkoutUrl = `${EPAY_CONFIG.apiUrl}/submit.php?${queryParts.join('&')}`;

    res.json({
      success: true,
      checkoutUrl
    });
  } catch (error) {
    console.error('下单错误:', error);
    res.status(500).json({ error: '下单失败，请重试' });
  }
});

// 易支付异步回调验证
app.all('/api/pay/notify', async (req, res) => {
  const data = req.method === 'POST' ? req.body : req.query;
  const { out_trade_no, trade_no, trade_status, money, sign } = data;

  if (!out_trade_no || !sign) {
    return res.send('fail');
  }

  // 签名校验 (排除 sign, sign_type)
  const sortedKeys = Object.keys(data).filter(k => k !== 'sign' && k !== 'sign_type' && data[k] !== null && data[k] !== undefined && data[k] !== '').sort();
  let signStr = sortedKeys.map(k => `${k}=${data[k]}`).join('&');
  signStr += EPAY_CONFIG.key;

  if (md5(signStr) !== sign) {
    console.error('[易支付] 签名验证失败');
    return res.send('fail');
  }

  if (trade_status === 'TRADE_SUCCESS') {
    try {
      const orderKey = getRedisKey(`order:${out_trade_no}`);
      const orderStr = await redis.get(orderKey);
      if (!orderStr) {
        console.error(`[易支付] 未找到本地订单 ${out_trade_no}`);
        return res.send('success');
      }

      const orderObj = JSON.parse(orderStr);
      if (orderObj.status === 'paid') {
        return res.send('success');
      }

      // 安全校验：金额校验
      if (parseFloat(money) !== parseFloat(orderObj.price)) {
        console.error(`[易支付] 订单 ${out_trade_no} 金额不一致: 收到 ${money}, 期望 ${orderObj.price}`);
        return res.send('fail');
      }

      const tokenKey = getRedisKey(`token:${orderObj.token}`);
      const tokenObjStr = await redis.get(tokenKey);
      if (!tokenObjStr) {
        console.error(`[易支付] 该订单对应的Token已失效 ${orderObj.token}`);
        return res.send('fail');
      }

      const tokenObj = JSON.parse(tokenObjStr);
      let currentExpire = new Date(tokenObj.expireAt);
      const now = new Date();

      if (currentExpire < now) {
        currentExpire = now;
      }

      // 延长订阅时间并累加流量额度
      currentExpire.setTime(currentExpire.getTime() + orderObj.days * 24 * 60 * 60 * 1000);
      tokenObj.expireAt = currentExpire.toISOString();
      tokenObj.trafficLimit += orderObj.trafficBytes;

      // 回写状态到 Redis
      await redis.set(tokenKey, JSON.stringify(tokenObj));

      orderObj.status = 'paid';
      orderObj.trade_no = trade_no;
      await redis.setex(orderKey, 7200, JSON.stringify(orderObj));

      console.log(`[易支付] 订单 ${out_trade_no} 充值成功! Token: ${orderObj.token} 增加流量 ${orderObj.trafficBytes} Bytes, 延期至 ${tokenObj.expireAt}`);
      return res.send('success');
    } catch (error) {
      console.error('[易支付] 回调业务逻辑出错:', error);
      return res.send('fail');
    }
  }

  res.send('fail');
});

// 模拟支付确认接口
app.post('/api/pay/mock-confirm', async (req, res) => {
  if (!ENABLE_MOCK_PAYMENT) {
    return res.status(403).json({ error: '模拟支付模式未启用' });
  }

  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: '缺少订单号' });
  }

  try {
    const orderKey = getRedisKey(`order:${orderId}`);
    const orderStr = await redis.get(orderKey);
    if (!orderStr) {
      return res.status(404).json({ error: '订单不存在或已过期' });
    }

    const orderObj = JSON.parse(orderStr);
    if (orderObj.status === 'paid') {
      return res.json({ success: true, message: '该订单已支付完毕' });
    }

    const tokenKey = getRedisKey(`token:${orderObj.token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      return res.status(404).json({ error: '关联的 Token 账户已不存在' });
    }

    const tokenObj = JSON.parse(tokenObjStr);
    let currentExpire = new Date(tokenObj.expireAt);
    const now = new Date();

    if (currentExpire < now) {
      currentExpire = now;
    }

    // 延长订阅时间并累加流量
    currentExpire.setTime(currentExpire.getTime() + orderObj.days * 24 * 60 * 60 * 1000);
    tokenObj.expireAt = currentExpire.toISOString();
    tokenObj.trafficLimit += orderObj.trafficBytes;

    await redis.set(tokenKey, JSON.stringify(tokenObj));

    orderObj.status = 'paid';
    orderObj.trade_no = 'MOCK_' + Date.now();
    await redis.setex(orderKey, 7200, JSON.stringify(orderObj));

    console.log(`[模拟支付] 订单 ${orderId} 支付成功! Token: ${orderObj.token} 增加流量 ${orderObj.trafficBytes} Bytes, 延期至 ${tokenObj.expireAt}`);

    res.json({
      success: true,
      message: '模拟支付成功，已增加流量并延长您的订阅！',
      expireAt: tokenObj.expireAt,
      trafficLimit: tokenObj.trafficLimit,
      trafficConsumed: tokenObj.trafficConsumed
    });
  } catch (error) {
    console.error('模拟支付确认错误:', error);
    res.status(500).json({ error: '服务器内部错误' });
  }
});

// 获取订单详情接口 (用于模拟支付前端展示页面)
app.get('/api/pay/order-info', async (req, res) => {
  const orderId = req.query.orderId;
  if (!orderId) return res.status(400).json({ error: '参数不足' });

  try {
    const orderKey = getRedisKey(`order:${orderId}`);
    const orderStr = await redis.get(orderKey);
    if (!orderStr) return res.status(404).json({ error: '订单不存在或已过期' });

    const orderObj = JSON.parse(orderStr);
    const selectedPkg = PRICING_PACKAGES.find(p => p.id === orderObj.packageId);

    res.json({
      success: true,
      orderId: orderObj.orderId,
      packageName: selectedPkg ? selectedPkg.name : '未知套餐',
      price: orderObj.price,
      token: orderObj.token,
      status: orderObj.status
    });
  } catch (e) {
    res.status(500).json({ error: '查询失败' });
  }
});

// ==========================================
// 【订阅反代 /speedup 核心接口】
// ==========================================
app.get('/speedup', async (req, res) => {
  const token = req.query.token || "";

  if (!token) {
    return res.status(400).send("Error: Token parameter is required.");
  }

  try {
    // 1. 验证 Token 在 Redis DB 5 中是否存在
    const tokenKey = getRedisKey(`token:${token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      console.log(`[Sub] 拦截请求: Token不存在 (${token})`);
      return res.status(403).send("Error: Token not found / 错误：Token 不存在。");
    }

    const tokenObj = JSON.parse(tokenObjStr);
    const expireDate = new Date(tokenObj.expireAt);
    const now = new Date();

    // 4. 验证通过，反代拉取开发者提供的 Clash 订阅配置
    console.log(`[Sub] Token ${token} 验证通过。拉取真实加速配置中...`);
    const response = await axios.get(DEVELOPER_SUBSCRIBE_URL, {
      headers: { 'User-Agent': 'clash-verge/1.3.8' },
      timeout: 15000
    });

    // 5. 直接透传 YAML 给客户端
    res.header('Content-Type', 'text/yaml; charset=utf-8');
    res.send(response.data);

    console.log(`[Sub] 订阅分发成功 (Token: ${token})`);
  } catch (error) {
    console.error('订阅反代错误:', error.message);
    res.status(500).send("Error generating subscription config: " + error.message);
  }
});

// ==========================================
// 【极简模拟支付页面 (HTML/JS)】
// ==========================================
app.get('/mock-pay.html', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>模拟支付收银台</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #0f172a; color: #f8fafc; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
    .card { background: #1e293b; padding: 2.5rem; border-radius: 12px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); text-align: center; max-width: 400px; width: 100%; border: 1px solid #334155; }
    h2 { margin-top: 0; color: #38bdf8; }
    .info { margin: 1.5rem 0; padding: 1rem; background: #0f172a; border-radius: 8px; text-align: left; font-size: 0.9rem; line-height: 1.6; }
    .btn { background: #10b981; color: white; border: none; padding: 0.75rem 1.5rem; font-size: 1rem; border-radius: 6px; cursor: pointer; font-weight: bold; width: 100%; transition: background 0.2s; }
    .btn:hover { background: #059669; }
    .status { margin-top: 1rem; font-weight: bold; }
  </style>
</head>
<body>
  <div class="card">
    <h2>模拟收银台 (测试专用)</h2>
    <div class="info" id="info">正在获取订单信息...</div>
    <button class="btn" id="payBtn" style="display:none;" onclick="pay()">确认支付 (Mock)</button>
    <div class="status" id="status"></div>
  </div>

  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const orderId = urlParams.get('orderId');

    async function loadOrder() {
      if(!orderId) {
        document.getElementById('info').innerText = '缺少订单ID，无法加载';
        return;
      }
      try {
        const res = await fetch('/api/pay/order-info?orderId=' + orderId);
        const data = await res.json();
        if(data.success) {
          document.getElementById('info').innerHTML = 
            '<strong>订单号:</strong> ' + data.orderId + '<br>' +
            '<strong>套餐名称:</strong> ' + data.packageName + '<br>' +
            '<strong>实付金额:</strong> <span style="color:#f43f5e;font-weight:bold;font-size:1.2rem;">' + data.price.toFixed(2) + ' 元</span><br>' +
            '<strong>订单状态:</strong> ' + (data.status === 'paid' ? '✅ 已支付' : '⏳ 待支付');
          if(data.status !== 'paid') {
            document.getElementById('payBtn').style.display = 'block';
          } else {
            document.getElementById('status').innerHTML = '<span style="color:#10b981">该订单已支付成功，可以返回客户端！</span>';
          }
        } else {
          document.getElementById('info').innerText = '获取订单详情失败';
        }
      } catch(e) {
        document.getElementById('info').innerText = '网络连接错误';
      }
    }

    async function pay() {
      document.getElementById('payBtn').disabled = true;
      document.getElementById('status').innerText = '正在提交模拟支付...';
      try {
        const res = await fetch('/api/pay/mock-confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orderId })
        });
        const data = await res.json();
        if(data.success) {
          document.getElementById('status').innerHTML = '<span style="color:#10b981">模拟支付成功！流量已到账。请返回客户端。</span>';
          document.getElementById('payBtn').style.display = 'none';
          loadOrder();
        } else {
          document.getElementById('status').innerHTML = '<span style="color:#ef4444">模拟支付失败：' + data.error + '</span>';
          document.getElementById('payBtn').disabled = false;
        }
      } catch(e) {
        document.getElementById('status').innerHTML = '<span style="color:#ef4444">请求超时，请重试</span>';
        document.getElementById('payBtn').disabled = false;
      }
    }

    loadOrder();
  </script>
</body>
</html>
  `);
});

// ==========================================
// 【服务器启动与模块导出】
// ==========================================
if (require.main === module) {
  app.listen(port, '0.0.0.0', () => {
    console.log(`生信下载器后端启动成功：http://0.0.0.0:${port}`);
  });
}

module.exports = { app, redis, getRedisKey };
