const express = require('express');
const axios = require('axios');
const yaml = require('js-yaml');
const Redis = require('ioredis');
const bcrypt = require('bcryptjs');
const md5 = require('md5');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 加载 .env 文件 (兼容本地开发与远程部署路径)
function loadEnv() {
  const possiblePaths = [
    path.join(__dirname, '../.env'),
    path.join(__dirname, '.env')
  ];
  for (const envPath of possiblePaths) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (match) {
          const key = match[1];
          let val = match[2].trim();
          if (val.startsWith('"') && val.endsWith('"')) {
            val = val.substring(1, val.length - 1);
          } else if (val.startsWith("'") && val.endsWith("'")) {
            val = val.substring(1, val.length - 1);
          }
          process.env[key] = val;
        }
      }
    }
  }
}
loadEnv();

const app = express();
const port = 13000;
const isTestEnv = process.env.NODE_ENV === 'test';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

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
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: parseInt(process.env.REDIS_PORT || '6379', 10),
  password: process.env.REDIS_PASSWORD || 'redis_Kesx3B',
  db: parseInt(process.env.REDIS_DB || '5', 10)
};

// 键名前缀，确保完全隔离
const KEY_PREFIX = 'biodl:';
function getRedisKey(key) {
  return KEY_PREFIX + key;
}

// 根服务 URL 配置
const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'http://107.175.142.245:13000';

// 易支付 (Epay) 配置
const EPAY_CONFIG = {
  apiUrl: process.env.EPAY_API_URL || 'https://zpayz.cn',
  pid: process.env.EPAY_PID || '2026070118081518',
  key: process.env.EPAY_KEY || 'G3VCP7yRRKPlvDf3LLx5GGEf2oh64OU8',
  notifyUrl: `${BACKEND_BASE_URL}/api/pay/notify`,
  returnUrl: `${BACKEND_BASE_URL}/pay-success` // 页面由客户端捕获或显示
};

// 开启模拟支付模式 (方便开发调试)
const ENABLE_MOCK_PAYMENT = false;

// 开发者持有的高速度 Clash 订阅链接
const DEVELOPER_SUBSCRIBE_URL = process.env.DEVELOPER_SUBSCRIBE_URL || 'https://subbind.yeyeziblog.eu.org/speedup?token=MyqjIpxrzA8WCUCM';

// 价格与流量套餐配置
// 流量单位: 字节 (Bytes). 100G = 100 * 1024 * 1024 * 1024 = 107374182400
const PRICING_PACKAGES = [
  { id: 'pkg_test', name: '100MB 测试包', days: 1, price: 2.00, trafficBytes: 104857600 },
  { id: 'pkg_100g', name: '100GB 高速流量包', days: 60, price: 10.00, trafficBytes: 107374182400 }
];

// 管理员密钥 (仅供后台使用)
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'biodl_admin_2026';

// Resend 邮件服务与验证码配置
const MAIL_FROM = process.env.MAIL_FROM || 'BioDownloader <no-reply@auth.yeyeziblog.eu.org>';
const PASSWORD_RESET_SECRET = process.env.PASSWORD_RESET_SECRET || 'biodl_password_reset_secret_default_2026';

// 邮箱格式验证
function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

// 邮件发送工具函数
async function sendEmail({ to, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[Email] Failed to send email: RESEND_API_KEY is not configured.');
    throw new Error('Resend API key is not configured');
  }
  try {
    const res = await axios.post('https://api.resend.com/emails', {
      from: MAIL_FROM,
      to,
      subject,
      html
    }, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      timeout: 15000
    });
    console.log(`[Email] Email sent successfully to ${to}, Resend ID: ${res.data.id}`);
    return res.data;
  } catch (error) {
    const errMsg = error.response ? JSON.stringify(error.response.data) : error.message;
    console.error(`[Email] Failed to send email to ${to}:`, errMsg);
    throw new Error(`Email sending failed: ${errMsg}`);
  }
}

// 哈希验证码（避免明文在 Redis 泄露）
function hashVerificationCode(code) {
  return crypto.createHmac('sha256', PASSWORD_RESET_SECRET).update(code).digest('hex');
}

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
  const { username, password, email } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '用户名和密码不能为空' });
  }

  // 验证邮箱格式并确保唯一性
  let normalizedEmail = '';
  if (email) {
    normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      return res.status(400).json({ error: '邮箱格式不正确' });
    }
  }

  try {
    const userKey = getRedisKey(`user:${username}`);
    const exists = await redis.get(userKey);
    if (exists) {
      return res.status(400).json({ error: '用户名已存在' });
    }

    if (normalizedEmail) {
      const emailExists = await redis.get(getRedisKey(`email:${normalizedEmail}`));
      if (emailExists) {
        return res.status(400).json({ error: '该邮箱已被注册' });
      }
    }

    const token = generateToken();
    const passwordHash = await hashPassword(password);

    // 新注册用户初始化：赠送 200MB 测试流量，有效期 2 天
    const trialExpireDate = new Date();
    trialExpireDate.setDate(trialExpireDate.getDate() + 2);

    const userObj = { username, passwordHash, token, role: 'user' };
    if (normalizedEmail) {
      userObj.email = normalizedEmail;
    }
    const tokenObj = {
      token,
      username,
      expireAt: trialExpireDate.toISOString(),
      trafficLimit: 209715200, // 200MB
      trafficConsumed: 0
    };

    await redis.set(userKey, JSON.stringify(userObj));
    await redis.set(getRedisKey(`token:${token}`), JSON.stringify(tokenObj));
    if (normalizedEmail) {
      await redis.set(getRedisKey(`email:${normalizedEmail}`), username);
    }

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

    // 获取邮箱绑定状态
    let email = '';
    const userKey = getRedisKey(`user:${tokenObj.username}`);
    const userStr = await redis.get(userKey);
    if (userStr) {
      const userObj = JSON.parse(userStr);
      email = userObj.email || '';
    }

    res.json({
      success: true,
      token: tokenObj.token,
      username: tokenObj.username,
      email: email,
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
// 【邮箱绑定与密码重置接口】
// ==========================================

// 1. 请求绑定邮箱验证码
app.post('/api/user/email/request-code', authLimiter, redisHealthCheck, async (req, res) => {
  const { token, email } = req.body;
  if (!token || !email) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  try {
    // 验证 token
    const tokenKey = getRedisKey(`token:${token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      return res.status(401).json({ error: '无效Token，请先登录' });
    }
    const tokenObj = JSON.parse(tokenObjStr);
    const username = tokenObj.username;

    // 检查邮箱是否已被其他账号绑定
    const emailExists = await redis.get(getRedisKey(`email:${normalizedEmail}`));
    if (emailExists && emailExists !== username) {
      return res.status(400).json({ error: '该邮箱已被其他账号绑定' });
    }

    // 限流保护：60 秒内同一邮箱不可重复发送
    const rateKey = getRedisKey(`rate:email-bind:${normalizedEmail}`);
    const isRateLimited = await redis.get(rateKey);
    if (isRateLimited) {
      return res.status(429).json({ error: '获取验证码过于频繁，请在 60 秒后重试' });
    }

    // 生成 6 位随机验证码
    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = hashVerificationCode(code);

    const bindData = {
      username,
      codeHash,
      attempts: 0,
      createdAt: new Date().toISOString()
    };

    // 写入 Redis 并设置 15 分钟过期
    const bindKey = getRedisKey(`email-bind:${normalizedEmail}`);
    await redis.setex(bindKey, 900, JSON.stringify(bindData));

    // 设置 60 秒限流 key
    await redis.setex(rateKey, 60, '1');

    // 发送邮件
    const emailHtml = `
      <div style="font-family: sans-serif; padding: 20px; color: #333;">
        <h2>您好 ${username}，</h2>
        <p>您正在为您的 BioDownloader 账号绑定邮箱，您的绑定验证码为：</p>
        <div style="font-size: 24px; font-weight: bold; background-color: #f0f4f8; padding: 15px; border-radius: 5px; text-align: center; color: #0070f3; letter-spacing: 5px; margin: 20px 0;">
          ${code}
        </div>
        <p>验证码在 15 分钟内有效，请勿将验证码泄露给他人。如果您没有进行此操作，请忽略本邮件。</p>
        <hr style="border: 0; border-top: 1px solid #eaeaea; margin: 30px 0;" />
        <p style="font-size: 12px; color: #666;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>
    `;
    await sendEmail({
      to: normalizedEmail,
      subject: 'BioDownloader 邮箱绑定验证码',
      html: emailHtml
    });

    res.json({ success: true, message: '验证码已发送至您的邮箱，请查收' });
  } catch (error) {
    console.error('发送绑定验证码失败:', error);
    res.status(500).json({ error: '发送失败，请重试' });
  }
});

// 2. 确认绑定邮箱
app.post('/api/user/email/confirm', authLimiter, redisHealthCheck, async (req, res) => {
  const { token, email, code } = req.body;
  if (!token || !email || !code) {
    return res.status(400).json({ error: '参数不完整' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    // 验证 token
    const tokenKey = getRedisKey(`token:${token}`);
    const tokenObjStr = await redis.get(tokenKey);
    if (!tokenObjStr) {
      return res.status(401).json({ error: '无效Token，请先登录' });
    }
    const tokenObj = JSON.parse(tokenObjStr);
    const username = tokenObj.username;

    // 获取绑定验证码缓存
    const bindKey = getRedisKey(`email-bind:${normalizedEmail}`);
    const bindDataStr = await redis.get(bindKey);
    if (!bindDataStr) {
      return res.status(400).json({ error: '验证码不存在或已过期' });
    }

    const bindData = JSON.parse(bindDataStr);

    // 检查验证码的用户名匹配
    if (bindData.username !== username) {
      return res.status(400).json({ error: '验证码与当前账号不匹配' });
    }

    // 验证哈希
    const codeHash = hashVerificationCode(code);
    if (bindData.codeHash !== codeHash) {
      bindData.attempts += 1;
      if (bindData.attempts >= 5) {
        await redis.del(bindKey); // 输错 5 次直接失效
        return res.status(400).json({ error: '验证码输入错误次数过多，已失效，请重新获取' });
      }
      await redis.setex(bindKey, 900, JSON.stringify(bindData));
      return res.status(400).json({ error: '验证码错误' });
    }

    // 验证成功，删除验证码记录
    await redis.del(bindKey);

    // 检查该邮箱是否已被其他用户绑定（双重保障）
    const emailExists = await redis.get(getRedisKey(`email:${normalizedEmail}`));
    if (emailExists && emailExists !== username) {
      return res.status(400).json({ error: '该邮箱已被其他账号绑定' });
    }

    // 更新用户 JSON 对象中的 email 字段
    const userKey = getRedisKey(`user:${username}`);
    const userStr = await redis.get(userKey);
    if (!userStr) {
      return res.status(404).json({ error: '用户不存在' });
    }

    const userObj = JSON.parse(userStr);
    userObj.email = normalizedEmail;

    await redis.set(userKey, JSON.stringify(userObj));
    await redis.set(getRedisKey(`email:${normalizedEmail}`), username);

    res.json({ success: true, message: '邮箱绑定成功' });
  } catch (error) {
    console.error('确认绑定邮箱错误:', error);
    res.status(500).json({ error: '服务器错误，请重试' });
  }
});

// 3. 忘记密码：申请密码重置
app.post('/api/auth/password-reset/request', authLimiter, redisHealthCheck, async (req, res) => {
  const { email } = req.body;
  if (!email) {
    return res.status(400).json({ error: '邮箱地址不能为空' });
  }

  const normalizedEmail = email.trim().toLowerCase();
  if (!isValidEmail(normalizedEmail)) {
    return res.status(400).json({ error: '邮箱格式不正确' });
  }

  // 安全要求：通用响应消息，防止账号枚举
  const successResponse = {
    success: true,
    message: '如果您的邮箱已在系统中注册，重置验证码已发送，请检查收件箱（包含垃圾箱）。'
  };

  try {
    // 限制发送频次
    const rateKey = getRedisKey(`rate:password-reset:${normalizedEmail}`);
    const isRateLimited = await redis.get(rateKey);
    if (isRateLimited) {
      return res.status(429).json({ error: '获取验证码过于频繁，请在 60 秒后重试' });
    }

    // 查找邮箱对应的用户名
    const username = await redis.get(getRedisKey(`email:${normalizedEmail}`));
    if (!username) {
      // 邮箱未注册，不发送邮件，但返回通用成功响应，保护隐私
      console.log(`[PasswordReset] Request for non-registered email: ${normalizedEmail}`);
      return res.json(successResponse);
    }

    // 生成 6 位重置验证码
    const code = crypto.randomInt(100000, 1000000).toString();
    const codeHash = hashVerificationCode(code);

    const resetData = {
      username,
      codeHash,
      attempts: 0,
      createdAt: new Date().toISOString()
    };

    // 写入 Redis 并设置 15 分钟过期
    const resetKey = getRedisKey(`password-reset:${normalizedEmail}`);
    await redis.setex(resetKey, 900, JSON.stringify(resetData));

    // 设置 60 秒限流
    await redis.setex(rateKey, 60, '1');

    // 发送重置密码邮件
    const emailHtml = `
      <div style="font-family: sans-serif; padding: 20px; color: #333;">
        <h2>您好 ${username}，</h2>
        <p>我们收到了您重置 BioDownloader 账号密码的请求。您的密码重置验证码为：</p>
        <div style="font-size: 24px; font-weight: bold; background-color: #fdf2f2; padding: 15px; border-radius: 5px; text-align: center; color: #dc2626; letter-spacing: 5px; margin: 20px 0;">
          ${code}
        </div>
        <p>验证码在 15 分钟内有效，请勿将验证码泄露给他人。如果您没有请求重置密码，请忽略此邮件，您的账号依然是安全的。</p>
        <hr style="border: 0; border-top: 1px solid #eaeaea; margin: 30px 0;" />
        <p style="font-size: 12px; color: #666;">此邮件由系统自动发送，请勿直接回复。</p>
      </div>
    `;

    await sendEmail({
      to: normalizedEmail,
      subject: 'BioDownloader 密码重置验证码',
      html: emailHtml
    });

    res.json(successResponse);
  } catch (error) {
    console.error('发送密码重置验证码失败:', error);
    res.status(500).json({ error: '请求失败，请稍后重试' });
  }
});

// 4. 确认密码重置
app.post('/api/auth/password-reset/confirm', authLimiter, redisHealthCheck, async (req, res) => {
  const { email, code, newPassword } = req.body;
  if (!email || !code || !newPassword) {
    return res.status(400).json({ error: '参数不完整' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: '新密码长度至少为 8 位' });
  }

  const normalizedEmail = email.trim().toLowerCase();

  try {
    const resetKey = getRedisKey(`password-reset:${normalizedEmail}`);
    const resetDataStr = await redis.get(resetKey);
    if (!resetDataStr) {
      return res.status(400).json({ error: '验证码已过期或不存在' });
    }

    const resetData = JSON.parse(resetDataStr);
    const username = resetData.username;

    // 验证哈希
    const codeHash = hashVerificationCode(code);
    if (resetData.codeHash !== codeHash) {
      resetData.attempts += 1;
      if (resetData.attempts >= 5) {
        await redis.del(resetKey); // 输错 5 次强制销毁
        return res.status(400).json({ error: '验证码输入错误次数过多，已失效，请重新获取' });
      }
      await redis.setex(resetKey, 900, JSON.stringify(resetData));
      return res.status(400).json({ error: '验证码不正确' });
    }

    // 验证成功，删除验证码记录
    await redis.del(resetKey);

    // 更新用户密码哈希，并废弃旧 Token
    const userKey = getRedisKey(`user:${username}`);
    const userStr = await redis.get(userKey);
    if (!userStr) {
      return res.status(404).json({ error: '该账户不存在' });
    }

    const userObj = JSON.parse(userStr);
    const oldToken = userObj.token;

    // 生成新 Token
    const newToken = generateToken();
    const newPasswordHash = await hashPassword(newPassword);

    userObj.passwordHash = newPasswordHash;
    userObj.token = newToken; // 废弃旧登录 token

    // 迁移或保留已有的 Token 资源 (流量限制与到期时间)
    const oldTokenKey = getRedisKey(`token:${oldToken}`);
    const oldTokenObjStr = await redis.get(oldTokenKey);
    let tokenObj;

    if (oldTokenObjStr) {
      tokenObj = JSON.parse(oldTokenObjStr);
      tokenObj.token = newToken; // 绑定到新 token
    } else {
      // 容错：初始化默认试用额度
      const trialExpireDate = new Date();
      trialExpireDate.setDate(trialExpireDate.getDate() + 2);
      tokenObj = {
        token: newToken,
        username,
        expireAt: trialExpireDate.toISOString(),
        trafficLimit: 209715200,
        trafficConsumed: 0
      };
    }

    // 保存更新
    await redis.set(userKey, JSON.stringify(userObj));
    await redis.set(getRedisKey(`token:${newToken}`), JSON.stringify(tokenObj));
    // 删除旧 Token 记录
    await redis.del(oldTokenKey);

    res.json({ success: true, message: '您的密码已成功重置，请使用新密码重新登录。' });
  } catch (error) {
    console.error('确认密码重置错误:', error);
    res.status(500).json({ error: '密码重置失败，请重试' });
  }
});

// ==========================================
// 【支付模块】
// ==========================================

// 获取最新客户端版本与更新配置
app.get('/api/client/version', (req, res) => {
  res.json({
    version: '1.2.3',
    winUrl: '/downloads/BioDownloader-1.2.3.exe',
    macUrl: '/downloads/BioDownloader-1.2.3-arm64.dmg',
    releaseNotes: '1. 修复 Windows 端子进程启动 ENOENT 报错；\n2. 优化 Clash 与 Axel 二进制文件存放至 AppData\\Roaming 用户高权限目录；\n3. 增加子进程生命周期启动报错安全守护。'
  });
});

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
        checkoutUrl: `${BACKEND_BASE_URL}/mock-pay.html?orderId=${orderId}`
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
// 【官方安装包下载与软件介绍首页】
// ==========================================
app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BioDownloader Pro - 生信数据多线程加速下载器</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-dark: #090d16;
      --card-bg: rgba(17, 25, 40, 0.75);
      --card-border: rgba(255, 255, 255, 0.08);
      --primary: #4f46e5;
      --primary-glow: rgba(79, 70, 229, 0.4);
      --accent: #06b6d4;
      --accent-glow: rgba(6, 182, 212, 0.4);
      --baidu: #10b981;
      --baidu-glow: rgba(16, 185, 129, 0.4);
      --quark: #f97316;
      --quark-glow: rgba(249, 115, 22, 0.4);
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: 'Outfit', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg-dark);
      color: var(--text);
      line-height: 1.6;
      overflow-x: hidden;
      background-image: 
        radial-gradient(circle at 10% 20%, rgba(79, 70, 229, 0.15) 0%, transparent 40%),
        radial-gradient(circle at 90% 80%, rgba(6, 182, 212, 0.15) 0%, transparent 40%);
      background-attachment: fixed;
    }

    .container {
      max-width: 1000px;
      margin: 0 auto;
      padding: 3rem 1.5rem;
    }

    header {
      text-align: center;
      margin-bottom: 4rem;
      animation: fadeInDown 0.8s ease-out;
    }

    .logo-container {
      display: inline-flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1rem;
    }

    .logo-icon {
      font-size: 2.5rem;
      animation: spin 10s linear infinite;
    }

    .logo-text {
      font-size: 2.2rem;
      font-weight: 800;
      letter-spacing: -0.05em;
      background: linear-gradient(135deg, #a5b4fc, #22d3ee);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }

    h1 {
      font-size: 2.8rem;
      font-weight: 800;
      letter-spacing: -0.03em;
      margin-bottom: 1rem;
      line-height: 1.2;
    }

    .subtitle {
      font-size: 1.25rem;
      color: var(--text-muted);
      max-width: 600px;
      margin: 0 auto;
    }

    /* Glassmorphism Card */
    .glass-card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--card-border);
      border-radius: 20px;
      padding: 2.5rem;
      margin-bottom: 2.5rem;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
      animation: fadeInUp 0.8s ease-out;
    }

    .download-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 1.5rem;
      margin-top: 1rem;
    }

    @media (max-width: 768px) {
      .download-grid {
        grid-template-columns: 1fr;
      }
    }

    .download-card {
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(255, 255, 255, 0.05);
      border-radius: 16px;
      padding: 2.2rem 2rem 2rem;
      text-align: center;
      transition: all 0.3s ease;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      height: 100%;
      position: relative;
      overflow: hidden;
    }

    .download-card:hover {
      transform: translateY(-5px);
      border-color: rgba(6, 182, 212, 0.3);
      box-shadow: 0 10px 25px rgba(6, 182, 212, 0.15);
    }

    .card-badge {
      position: absolute;
      top: 0.75rem;
      right: 0.75rem;
      font-size: 0.7rem;
      font-weight: 700;
      padding: 0.25rem 0.65rem;
      border-radius: 20px;
      letter-spacing: 0.03em;
    }

    .card-badge.recommend {
      background: rgba(16, 185, 129, 0.12);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.25);
    }

    .card-badge.direct {
      background: rgba(99, 102, 241, 0.12);
      color: #a5b4fc;
      border: 1px solid rgba(99, 102, 241, 0.25);
    }

    .os-badge {
      font-size: 3rem;
      margin-bottom: 0.5rem;
    }

    .os-name {
      font-size: 1.4rem;
      font-weight: 700;
      margin-bottom: 0.75rem;
      color: #f1f5f9;
    }

    .file-desc {
      font-size: 0.9rem;
      color: var(--text-muted);
      margin-bottom: 1.5rem;
      line-height: 1.5;
      min-height: 3rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .download-btn {
      display: block;
      width: 100%;
      padding: 0.85rem 1.25rem;
      border-radius: 10px;
      font-weight: 700;
      text-decoration: none;
      transition: all 0.25s ease;
      text-align: center;
      font-size: 0.95rem;
    }

    .card-actions {
      display: flex;
      gap: 0.5rem;
      width: 100%;
      margin-top: auto;
    }

    .code-box {
      display: flex;
      align-items: center;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 10px;
      padding: 0.25rem 0.5rem 0.25rem 0.85rem;
      font-size: 0.95rem;
      gap: 0.5rem;
    }

    .code-label {
      color: var(--text-muted);
      font-size: 0.8rem;
      white-space: nowrap;
      user-select: none;
    }

    .code-text {
      color: #38bdf8;
      font-weight: 700;
      font-family: monospace;
      letter-spacing: 0.05em;
      cursor: text;
      user-select: text;
      -webkit-user-select: text;
      background: rgba(255, 255, 255, 0.05);
      padding: 0.15rem 0.4rem;
      border-radius: 4px;
    }

    .mini-copy-btn {
      background: rgba(255, 255, 255, 0.08);
      border: 1px solid rgba(255, 255, 255, 0.1);
      color: #f8fafc;
      padding: 0.4rem 0.75rem;
      border-radius: 6px;
      font-size: 0.8rem;
      font-weight: 700;
      cursor: pointer;
      transition: all 0.2s ease;
      user-select: none;
      white-space: nowrap;
    }

    .mini-copy-btn:hover {
      background: var(--primary);
      border-color: var(--primary);
      transform: translateY(-1px);
    }

    /* Toast Notification */
    .toast {
      position: fixed;
      bottom: 2rem;
      right: 2rem;
      background: rgba(16, 185, 129, 0.9);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(16, 185, 129, 0.2);
      color: white;
      padding: 0.85rem 1.5rem;
      border-radius: 12px;
      font-weight: 700;
      box-shadow: 0 10px 30px rgba(16, 185, 129, 0.3);
      transform: translateY(100px);
      opacity: 0;
      transition: all 0.3s cubic-bezier(0.68, -0.55, 0.27, 1.55);
      z-index: 9999;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      user-select: none;
    }

    .toast.show {
      transform: translateY(0);
      opacity: 1;
    }

    .download-btn.baidu {
      background: linear-gradient(135deg, #10b981, #059669);
      color: white;
      box-shadow: 0 4px 12px var(--baidu-glow);
    }

    .download-btn.baidu:hover {
      background: linear-gradient(135deg, #059669, #047857);
      box-shadow: 0 6px 18px var(--baidu-glow);
    }

    .download-btn.quark {
      background: linear-gradient(135deg, #f97316, #ea580c);
      color: white;
      box-shadow: 0 4px 12px var(--quark-glow);
    }

    .download-btn.quark:hover {
      background: linear-gradient(135deg, #ea580c, #c2410c);
      box-shadow: 0 6px 18px var(--quark-glow);
    }

    .download-btn.primary {
      background: linear-gradient(135deg, #6366f1, #4f46e5);
      color: white;
      box-shadow: 0 4px 12px var(--primary-glow);
    }

    .download-btn.primary:hover {
      background: linear-gradient(135deg, #4f46e5, #3730a3);
      box-shadow: 0 6px 18px var(--primary-glow);
    }

    .download-btn.accent {
      background: linear-gradient(135deg, #06b6d4, #0891b2);
      color: white;
      box-shadow: 0 4px 12px var(--accent-glow);
    }

    .download-btn.accent:hover {
      background: linear-gradient(135deg, #0891b2, #0e7490);
      box-shadow: 0 6px 18px var(--accent-glow);
    }

    .features-list {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 1.5rem;
      margin-top: 1rem;
    }

    @media (max-width: 768px) {
      .features-list {
        grid-template-columns: 1fr;
      }
    }

    .feature-item {
      background: rgba(255, 255, 255, 0.01);
      border: 1px solid rgba(255, 255, 255, 0.03);
      padding: 1.5rem;
      border-radius: 12px;
      text-align: center;
    }

    .feature-icon {
      font-size: 2rem;
      margin-bottom: 0.5rem;
    }

    .feature-title {
      font-weight: 600;
      margin-bottom: 0.25rem;
      color: #38bdf8;
    }

    .feature-text {
      font-size: 0.875rem;
      color: var(--text-muted);
    }

    h3 {
      font-size: 1.5rem;
      font-weight: 600;
      margin-bottom: 1.25rem;
      color: #a5b4fc;
      border-left: 4px solid var(--primary);
      padding-left: 0.75rem;
    }

    .guide-step {
      margin-bottom: 1.5rem;
    }

    .guide-step:last-child {
      margin-bottom: 0;
    }

    .step-num {
      display: inline-block;
      width: 24px;
      height: 24px;
      border-radius: 50%;
      background: var(--accent);
      color: #090d16;
      font-weight: 700;
      text-align: center;
      line-height: 24px;
      margin-right: 0.5rem;
      font-size: 0.875rem;
    }

    .step-title {
      font-weight: 600;
      display: inline-block;
    }

    .step-content {
      margin-left: 2rem;
      margin-top: 0.35rem;
      font-size: 0.95rem;
      color: var(--text-muted);
    }

    code {
      background: rgba(0, 0, 0, 0.4);
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
      color: #fb7185;
      font-size: 0.9rem;
    }

    pre {
      background: rgba(0, 0, 0, 0.4);
      padding: 0.75rem 1rem;
      border-radius: 8px;
      font-family: monospace;
      color: #fb7185;
      font-size: 0.9rem;
      overflow-x: auto;
      margin-top: 0.5rem;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    /* Keyframes */
    @keyframes spin {
      from { transform: rotate(0deg); }
      to { transform: rotate(360deg); }
    }

    @keyframes fadeInDown {
      from { opacity: 0; transform: translateY(-30px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes fadeInUp {
      from { opacity: 0; transform: translateY(30px); }
      to { opacity: 1; transform: translateY(0); }
    }
  </style>
</head>
<body>

  <!-- 页面头部 -->
  <header style="text-align: center; margin-bottom: 3rem; margin-top: 3rem; animation: fadeInDown 0.8s ease-out;">
    <div class="logo-container" style="display: inline-flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;">
      <img src="/downloads/logo.png" alt="Logo" style="height: 52px; width: 52px; border-radius: 12px; box-shadow: 0 4px 15px rgba(99, 102, 241, 0.4);">
      <span class="logo-text" style="font-size: 2.2rem; font-weight: 800; letter-spacing: -0.05em; background: linear-gradient(135deg, #a5b4fc, #22d3ee); -webkit-background-clip: text; -webkit-text-fill-color: transparent;">BioDownloader</span>
    </div>
    <h1 style="font-size: 1.5rem; font-weight: 600; color: var(--text-muted); margin-top: 0.25rem;">生信数据多线程加速下载器</h1>
  </header>

  <!-- 下载面板 -->
  <div class="glass-card">
    <h3>📥 官方安装包下载</h3>
      
      <div class="download-grid">
        <!-- Baidu Netdisk -->
        <div class="download-card">
          <span class="card-badge recommend">推荐 - 免代理</span>
          <div>
            <div class="os-badge">☁️</div>
            <div class="os-name">百度网盘镜像</div>
            <div class="file-desc">官方高速云端镜像。国内直连网络环境首选，下载速度最快。</div>
          </div>
          <div class="card-actions">
            <a href="https://pan.baidu.com/s/1qKabwrWXufIEjHhOcXW-Rw?pwd=7pug" class="download-btn baidu" style="flex: 2;" target="_blank">百度网盘下载</a>
            <div class="code-box">
              <span class="code-label">提取码:</span>
              <span class="code-text" onclick="selectText(this)">7pug</span>
              <button onclick="copyToClipboard('7pug', this)" class="mini-copy-btn">复制</button>
            </div>
          </div>
        </div>
        <!-- Quark Netdisk -->
        <div class="download-card">
          <span class="card-badge recommend">推荐 - 免代理</span>
          <div>
            <div class="os-badge">⚡</div>
            <div class="os-name">夸克网盘镜像</div>
            <div class="file-desc">官方高速云端镜像。支持极速秒传，支持手机与PC快速保存。</div>
          </div>
          <div class="card-actions">
            <a href="https://pan.quark.cn/s/1ca20a8200d3" class="download-btn quark" style="flex: 2;" target="_blank">夸克网盘下载</a>
            <div class="code-box">
              <span class="code-label">提取码:</span>
              <span class="code-text" onclick="selectText(this)">ELQk</span>
              <button onclick="copyToClipboard('ELQk', this)" class="mini-copy-btn">复制</button>
            </div>
          </div>
        </div>
        <!-- Mac -->
        <div class="download-card">
          <span class="card-badge direct">直连下载</span>
          <div>
            <div class="os-badge">🍏</div>
            <div class="os-name">macOS 客户端</div>
            <div class="file-desc">标准 DMG 磁盘映像。支持 Apple Silicon (M1-M4) 及 Intel 芯片。</div>
          </div>
          <div class="card-actions">
            <a href="/downloads/BioDownloader-1.2.3-arm64.dmg" class="download-btn primary">下载 Mac 安装包 (.dmg)</a>
          </div>
        </div>
        <!-- Win -->
        <div class="download-card">
          <span class="card-badge direct">直连下载</span>
          <div>
            <div class="os-badge">🪟</div>
            <div class="os-name">Windows 客户端</div>
            <div class="file-desc">单文件绿色免安装版。支持 64位 Windows 10/11 系统，即开即用.</div>
          </div>
          <div class="card-actions">
            <a href="/downloads/BioDownloader-1.2.3.exe" class="download-btn accent">下载 Windows 绿色版 (.exe)</a>
          </div>
        </div>
      </div>
    </div>

    <!-- 特性展示 -->
    <div class="glass-card">
      <h3>⚡ 软件核心优势</h3>
      <div class="features-list">
        <div class="feature-item">
          <div class="feature-icon">🛡️</div>
          <div class="feature-title">安全加密隧道</div>
          <div class="feature-text">云端智能分配高带宽动态加速节点，多重安全隧道加密，全面保障数据传输稳定性。</div>
        </div>
        <div class="feature-item">
          <div class="feature-icon">🚀</div>
          <div class="feature-title">Axel 16 线程</div>
          <div class="feature-text">内置超高速多线程 Axel 下载引擎，突破服务器单连接限速，跑满您的家庭宽带。</div>
        </div>
        <div class="feature-item">
          <div class="feature-icon">📁</div>
          <div class="feature-title">多数据源整合</div>
          <div class="feature-text">支持输入 SRA/EBI 原始测序数据编号、GEO 系列号，并自动解析全部补充文件.</div>
        </div>
      </div>
    </div>

    <!-- 运行说明 -->
    <div class="glass-card">
      <h3>⚙️ 安装与使用教程</h3>
      
      <div class="guide-step">
        <div class="step-num">1</div>
        <div class="step-title">macOS 首次打开提示“已损坏，打不开”？</div>
        <div class="step-content">
          由于软件未向 Apple 申请官方付费签名证书，macOS 系统的 Gatekeeper 会进行拦截并报此提示。属于正常拦截，请执行以下命令解除限制：
          <br>
          1. 打开 Mac 系统自带的 <strong>终端 (Terminal)</strong> 程序。
          <br>
          2. 复制并执行以下命令（输入电脑开机密码回车即可）：
          <pre>sudo xattr -cr /Applications/BioDownloader.app</pre>
        </div>
      </div>

      <div class="guide-step">
        <div class="step-num">2</div>
        <div class="step-title">快速启动与下载</div>
        <div class="step-content">
          1. 打开软件，进入「我的」页面注册并登录您的账户。
          <br>
          2. 在「下载中心」选择相应的数据源类型，输入需要下载的编号（已默认填入测试编号）。
          <br>
          3. 选择“下载目标文件夹”，点击“检验下载大小”。
          <br>
          4. 点击“开始加速下载”或“单项下载”，加速通道将自动建立，多线程引擎自动接管。
        </div>
      </div>
    </div>
  </div>

  <div id="toast" class="toast">
    <span>✅</span>
    <span id="toast-message">复制成功！</span>
  </div>

  <script>
    function showToast(message) {
      const toast = document.getElementById('toast');
      const toastMsg = document.getElementById('toast-message');
      toastMsg.textContent = message;
      toast.classList.add('show');
      setTimeout(() => {
        toast.classList.remove('show');
      }, 2500);
    }

    function copyToClipboard(text, btn) {
      function success() {
        showToast('提取码 ' + text + ' 已成功复制！');
        const originalText = btn.textContent;
        btn.textContent = '已复制';
        btn.style.background = '#10b981';
        btn.style.borderColor = '#10b981';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
          btn.style.borderColor = '';
        }, 1500);
      }

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(success).catch(err => {
          fallbackCopy(text, success);
        });
      } else {
        fallbackCopy(text, success);
      }
    }

    function fallbackCopy(text, callback) {
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        const successful = document.execCommand('copy');
        if (successful) {
          callback();
        } else {
          console.error('Fallback copy failed');
        }
      } catch (err) {
        console.error('Fallback copy error:', err);
      }
      document.body.removeChild(textarea);
    }

    function selectText(element) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
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
