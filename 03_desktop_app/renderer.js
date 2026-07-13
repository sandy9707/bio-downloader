// ==========================================
// 【全局状态管理】
// ==========================================
let currentTab = 'download-hub';
let currentDownloadType = 'sra_raw';
let currentUser = null;
let currentQueue = [];
let defaultDir = '';
let currentOrderId = null;

// ==========================================
// 【辅助与初始化函数】
// ==========================================
function formatBytes(bytes, decimals = 2) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('notificationToast');
  toast.innerText = message;
  toast.style.display = 'block';
  
  if (type === 'success') {
    toast.style.background = 'var(--success-grad)';
  } else if (type === 'error') {
    toast.style.background = 'var(--danger-grad)';
  } else {
    toast.style.background = 'var(--primary-grad)';
  }

  setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

// 初始化加载 settings 和验证登录
window.addEventListener('DOMContentLoaded', async () => {
  // 0. 加载主题偏好
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'dark') {
    document.body.classList.add('dark-mode');
    document.getElementById('themeIcon').innerText = '☀️';
    document.getElementById('themeLabel').innerText = '亮色模式';
  }

  // 1. 获取本地设置
  const settings = await window.api.getSettings();
  if (settings.defaultDir) {
    defaultDir = settings.defaultDir;
    document.getElementById('targetDirInput').value = defaultDir;
    // 同步到设置页面
    const settingsInput = document.getElementById('settingsDefaultDirInput');
    if (settingsInput) settingsInput.value = defaultDir;
  }
  
  // 2. 检查是否有本地 Token 并自动登录验证
  if (settings.token) {
    await verifyToken(settings.token, true); // true = 来自自动登录，失败不强制退出
  }

  // 3. 渲染充値包
  loadPackages();

  // 4. 定时更新加速器状态
  updateClashUIState();
  setInterval(updateClashUIState, 3000);
});

// ==========================================
// 【主题切换】
// ==========================================
function toggleDarkMode() {
  const isDark = document.body.classList.toggle('dark-mode');
  const icon = document.getElementById('themeIcon');
  const label = document.getElementById('themeLabel');
  if (isDark) {
    icon.innerText = '☀️';
    label.innerText = '亮色模式';
    localStorage.setItem('theme', 'dark');
  } else {
    icon.innerText = '🌙';
    label.innerText = '夜间模式';
    localStorage.setItem('theme', 'light');
  }
}

// ==========================================
// 【下载加速器开关逻辑】
// ==========================================
async function updateClashUIState() {
  try {
    const isRunning = await window.api.getClashStatus();
    const dot = document.getElementById('clashDot');
    const text = document.getElementById('clashStatusText');
    const toggle = document.getElementById('clashToggle');
    
    if (isRunning) {
      dot.className = 'dot active';
      text.innerText = '加速器已开启';
      toggle.checked = true;
      document.getElementById('clashConfigInfo').innerText = '正在本地监听端口 7890，高速加速通道已建立。';
    } else {
      dot.className = 'dot';
      text.innerText = '加速器已关闭';
      toggle.checked = false;
      document.getElementById('clashConfigInfo').innerText = '尚未启动下载加速器。启动下载时会自动开启。';
    }
  } catch (e) {
    console.error('获取加速器状态错误:', e);
  }
}

async function toggleClash() {
  const toggle = document.getElementById('clashToggle');
  if (toggle.checked) {
    if (!currentUser) {
      showToast('请先登录账户，获取您的专属加速服务', 'error');
      toggle.checked = false;
      return;
    }
    try {
      showToast('正在初始化下载加速器...');
      await window.api.startClash(currentUser.token);
      showToast('下载加速器启动成功', 'success');
      updateClashUIState();
    } catch (err) {
      showToast(err.message, 'error');
      toggle.checked = false;
    }
  } else {
    await window.api.stopClash();
    showToast('下载加速器已关闭');
    updateClashUIState();
  }
}

// ==========================================
// 【导航与视图切换】
// ==========================================
function switchTab(tabId) {
  // 切换菜单栏激活状态
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(item => item.classList.remove('active'));
  
  // 查找对应的菜单项目
  const activeNavItem = Array.from(navItems).find(item => item.getAttribute('onclick').includes(tabId));
  if (activeNavItem) activeNavItem.classList.add('active');

  // 切换视图显示
  const tabViews = document.querySelectorAll('.tab-view');
  tabViews.forEach(view => view.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');

  currentTab = tabId;
  const titles = {
    'download-hub': '下载中心',
    'billing-tab': '账户充值',
    'settings-tab': '设置中心'
  };
  document.getElementById('tabTitle').innerText = titles[tabId] || '下载中心';
}

function switchDownloadType(btn, type) {
  // 切换按钮激活样式
  const buttons = btn.parentElement.querySelectorAll('.pill-btn');
  buttons.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  currentDownloadType = type;

  // 修改对应的输入指示和 placeholder
  const labels = {
    'sra_raw': '请输入 SRA 原始数据编号 (例如: SRR1234567，多项使用换行或空格分隔)',
    'ebi_raw': '请输入 EBI 原始数据编号 (例如: ERR1234567，优先拉取 EBI 高速 Fastq，无则回退 SRA)',
    'geo_suppl': '请输入 GEO 系列号 (例如: GSE123456，将自动提取页面下的全部补充文件)',
    'links': '请输入直接下载链接 (每行一个下载链接)'
  };
  const placeholders = {
    'sra_raw': 'SRR1234567\nSRR1234568',
    'ebi_raw': 'ERR1234567\nSRR1234567',
    'geo_suppl': 'GSE123456',
    'links': 'https://example.com/data/sample1.fq.gz\nhttps://example.com/data/sample2.fq.gz'
  };

  document.getElementById('inputLabel').innerText = labels[type] || '请输入编号/链接';
  document.getElementById('accInput').placeholder = placeholders[type] || '';
  
  // 改变类型时清空上一轮的校验状态与下载按钮
  currentQueue = [];
  document.getElementById('downloadBtn').disabled = true;
  document.getElementById('totalQueueSize').innerText = '共 0 字节';
  document.getElementById('queueList').innerHTML = '';
}

// 选择下载文件夹 (下载中心页)
async function chooseDir() {
  const dir = await window.api.selectDirectory();
  if (dir) {
    defaultDir = dir;
    document.getElementById('targetDirInput').value = dir;
    // 同步到设置页面
    const settingsInput = document.getElementById('settingsDefaultDirInput');
    if (settingsInput) settingsInput.value = dir;
    await window.api.saveSettings({ defaultDir: dir });
    showToast('下载路径已保存为默认', 'success');
  }
}

// 选择默认下载文件夹 (设置页面)
async function chooseDefaultDir() {
  const dir = await window.api.selectDirectory();
  if (dir) {
    defaultDir = dir;
    document.getElementById('settingsDefaultDirInput').value = dir;
    // 同步到下载中心页
    const mainInput = document.getElementById('targetDirInput');
    if (mainInput) mainInput.value = dir;
    await window.api.saveSettings({ defaultDir: dir });
    showToast('默认下载文件夹已更新并保存', 'success');
  }
}

// ==========================================
// 【文件大小校验与渲染】
// ==========================================
async function checkSizes() {
  const inputVal = document.getElementById('accInput').value.trim();
  if (!inputVal) {
    showToast('请输入有效的原始编号或下载链接', 'error');
    return;
  }

  const checkBtn = document.getElementById('checkSizeBtn');
  const downloadBtn = document.getElementById('downloadBtn');
  
  checkBtn.disabled = true;
  checkBtn.innerText = '正在核对校验中...';
  
  try {
    // 自动判断并提前开启 Clash 代理以支持校验
    if (currentUser) {
      const isClashRunning = await window.api.getClashStatus();
      if (!isClashRunning) {
        await window.api.startClash(currentUser.token);
        updateClashUIState();
      }
    }

    currentQueue = await window.api.checkSize(currentDownloadType, inputVal);
    renderQueue();
    
    // 计算总大小并更新
    const totalBytes = currentQueue.reduce((acc, f) => acc + (f.size || 0), 0);
    document.getElementById('totalQueueSize').innerText = '预计共 ' + formatBytes(totalBytes);
    
    if (currentQueue.length > 0) {
      downloadBtn.disabled = false;
      showToast(`扫描完毕！共发现 ${currentQueue.length} 个可下载任务`, 'success');
    } else {
      showToast('未发现任何对应的数据文件，请核对输入', 'error');
    }
  } catch (err) {
    showToast('校验失败: ' + err.message, 'error');
  } finally {
    checkBtn.disabled = false;
    checkBtn.innerText = '检验下载大小';
  }
}

function renderQueue() {
  const listEl = document.getElementById('queueList');
  listEl.innerHTML = '';

  currentQueue.forEach((file, index) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'queue-item';
    itemEl.id = `queue-item-${index}`;
    
    const sizeStr = file.size > 0 ? formatBytes(file.size) : '未知大小';
    const folderStr = file.folder ? `<span style="background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:4px;font-size:0.75rem;">目录: ${file.folder}</span>` : '';

    itemEl.innerHTML = `
      <div class="item-meta">
        <span class="item-name" title="${file.name}">${file.name}</span>
        <div class="item-info">
          ${folderStr}
          <span>${sizeStr}</span>
          <span class="item-status status-pending" id="status-text-${index}">准备就绪</span>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:1rem;margin-top:0.25rem;">
        <div class="item-progress-bar" style="flex-grow:1;">
          <div class="item-progress-fill" id="progress-fill-${index}" style="width: 0%"></div>
        </div>
        <span id="progress-pct-${index}" style="font-size:0.8rem;width:35px;text-align:right;">0%</span>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:var(--text-muted);">
        <span id="speed-text-${index}">-</span>
        <span>Axel 16 线程</span>
      </div>
    `;
    listEl.appendChild(itemEl);
  });
}

// ==========================================
// 【加速下载调度逻辑】
// ==========================================
async function startDownload() {
  if (!currentUser) {
    showToast('请登录账户后开始下载，未登录无法连接代理加速', 'error');
    switchTab('billing-tab');
    return;
  }

  if (!defaultDir) {
    showToast('请先选择下载的保存目标路径', 'error');
    return;
  }

  const isClashRunning = await window.api.getClashStatus();
  if (!isClashRunning) {
    try {
      showToast('正在自动建立高速下载加速通道...');
      await window.api.startClash(currentUser.token);
      updateClashUIState();
    } catch (e) {
      showToast(e.message, 'error');
      return;
    }
  }

  // 校验当前流量剩余额度是否充足
  const totalBytes = currentQueue.reduce((acc, f) => acc + (f.size || 0), 0);
  const remaining = currentUser.trafficLimit - currentUser.trafficConsumed;
  
  if (remaining < totalBytes) {
    showToast(`您的额度不足！剩余流量: ${formatBytes(remaining)}，所需流量: ${formatBytes(totalBytes)}，请充值后下载`, 'error');
    switchTab('billing-tab');
    return;
  }

  // 锁定控制按钮状态
  document.getElementById('checkSizeBtn').disabled = true;
  document.getElementById('downloadBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'block';

  // 绑定进度事件回调
  window.api.onDownloadStatus((data) => {
    const { index, status, fileName } = data;
    const fill = document.getElementById(`progress-fill-${index}`);
    const pct = document.getElementById(`progress-pct-${index}`);
    const txt = document.getElementById(`status-text-${index}`);
    
    if (status === 'downloading') {
      txt.className = 'item-status status-downloading';
      txt.innerText = '正在高速下载';
      if (data.speed && data.speed.includes('重试')) {
        document.getElementById(`speed-text-${index}`).innerText = data.speed;
      }
    } else if (status === 'completed') {
      txt.className = 'item-status status-completed';
      txt.innerText = '下载完成';
      fill.style.width = '100%';
      pct.innerText = '100%';
      document.getElementById(`speed-text-${index}`).innerText = '已保存';
    } else if (status === 'failed') {
      txt.className = 'item-status status-failed';
      txt.innerText = '下载失败';
      if (data.speed && data.speed.includes('失败')) {
        document.getElementById(`speed-text-${index}`).innerText = data.speed;
      }
    }
  });

  window.api.onDownloadProgress((data) => {
    const { index, percentage, speed } = data;
    
    if (percentage !== null) {
      document.getElementById(`progress-fill-${index}`).style.width = percentage + '%';
      document.getElementById(`progress-pct-${index}`).innerText = percentage + '%';
    }
    if (speed !== null) {
      document.getElementById(`speed-text-${index}`).innerText = '当前速度: ' + speed;
    }
  });

  try {
    showToast('生信原始数据多线程加速下载已开始...');
    await window.api.startDownload(currentQueue, defaultDir, currentUser.token);
    showToast('恭喜，所有生信数据包下载完毕！', 'success');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    // 恢复按钮状态
    document.getElementById('checkSizeBtn').disabled = false;
    document.getElementById('downloadBtn').style.display = 'block';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('downloadBtn').disabled = true; // 需重新进行下一轮校验大小才能再次下载
    
    // 同步刷新最新的流量限额信息
    await refreshUserInfo();
  }
}

async function cancelDownload() {
  const cancelled = await window.api.cancelDownload();
  if (cancelled) {
    showToast('下载已被用户中断取消');
  }
}

// ==========================================
// 【用户认证交互逻辑】
// ==========================================
async function handleLogin() {
  const user = document.getElementById('authUsername').value.trim();
  const pass = document.getElementById('authPassword').value.trim();

  if (!user || !pass) {
    showToast('账号和密码不能为空', 'error');
    return;
  }

  try {
    const res = await window.api.login(user, pass);
    if (res.success) {
      showToast('账户登录成功', 'success');
      await window.api.saveSettings({ token: res.token });
      await verifyToken(res.token);
    }
  } catch (err) {
    showToast('登录失败: ' + (err.response?.data?.error || err.message), 'error');
  }
}

async function handleRegister() {
  const user = document.getElementById('authUsername').value.trim();
  const pass = document.getElementById('authPassword').value.trim();

  if (!user || !pass) {
    showToast('账号和密码不能为空', 'error');
    return;
  }

  try {
    const res = await window.api.register(user, pass);
    if (res.success) {
      showToast('账户秒速注册成功', 'success');
      await window.api.saveSettings({ token: res.token });
      await verifyToken(res.token);
    }
  } catch (err) {
    showToast('注册失败: ' + (err.response?.data?.error || err.message), 'error');
  }
}

async function verifyToken(token, isAutoLogin = false) {
  try {
    const res = await window.api.getUserInfo(token);
    if (res.success) {
      currentUser = res;
      
      // 显示登录后的界面
      document.getElementById('authFormCard').style.display = 'none';
      document.getElementById('loggedInProfile').style.display = 'grid';
      document.getElementById('userInfoBadge').style.display = 'flex';
      
      // 更新文字
      document.getElementById('headerUsername').innerText = res.username;
      document.getElementById('profUsername').innerText = res.username;
      document.getElementById('profToken').value = res.token;
      
      const expiryDate = new Date(res.expireAt);
      // 如果是至少 50 年后，显示“永久”
      const isUnlimited = expiryDate.getFullYear() >= new Date().getFullYear() + 50;
      if (isUnlimited) {
        document.getElementById('profExpiry').innerText = '永久有效 ✅';
      } else {
        document.getElementById('profExpiry').innerText = expiryDate.toLocaleString() + (res.isActive ? ' (激活中)' : ' (已过期)');
      }
      
      // 更新流量条进度
      updateTrafficProgressBar(res.trafficConsumed, res.trafficLimit);

      // 如果加速器没开，则为其自动开启
      try {
        const isClashRunning = await window.api.getClashStatus();
        if (!isClashRunning) {
          await window.api.startClash(token);
          updateClashUIState();
        }
      } catch (clashErr) {
        console.error('自动开启加速器失败:', clashErr.message);
        showToast('加速器自动开启失败，请手动尝试', 'error');
      }
    }
  } catch (e) {
    console.error('Token验证失败', e);
    // 如果是自动登录尝试，不强制退出登录状态，只静默删除本地 Token
    if (isAutoLogin) {
      console.warn('自动登录 Token 失败，将清除并保持退出状态');
      await window.api.saveSettings({ token: null });
    } else {
      // 手动登录验证失败才退出
      await handleLogout();
    }
  }
}

async function refreshUserInfo() {
  if (currentUser) {
    await verifyToken(currentUser.token);
  }
}

function updateTrafficProgressBar(consumed, limit) {
  const isUnlimited = limit >= 100 * 1024 * 1024 * 1024 * 1024 * 0.9; // > 90TB 认为无限
  if (isUnlimited) {
    document.getElementById('headerTrafficText').innerText = '无限流量 ⭐';
    document.getElementById('headerTrafficProgress').style.width = '100%';
    document.getElementById('headerTrafficProgress').style.background = 'var(--success-grad)';
    return;
  }
  const ratio = limit > 0 ? (consumed / limit) * 100 : 0;
  const remainText = formatBytes(limit - consumed);
  const totalText = formatBytes(limit);
  
  document.getElementById('headerTrafficText').innerText = `${remainText} / ${totalText}`;
  document.getElementById('headerTrafficProgress').style.width = Math.min(100, Math.max(0, 100 - ratio)) + '%';
}

async function handleLogout() {
  currentUser = null;
  await window.api.saveSettings({ token: null });
  await window.api.stopClash();
  
  // 隐藏个人中心
  document.getElementById('authFormCard').style.display = 'block';
  document.getElementById('loggedInProfile').style.display = 'none';
  document.getElementById('userInfoBadge').style.display = 'none';
  
  // 重置输入框
  document.getElementById('authUsername').value = '';
  document.getElementById('authPassword').value = '';
  
  updateClashUIState();
  showToast('账号已安全退出并关闭加速器');
}

// ==========================================
// 【充值套餐与易支付】
// ==========================================
async function loadPackages() {
  try {
    const res = await window.api.getPackages();
    if (res.success) {
      const container = document.getElementById('packageList');
      container.innerHTML = '';
      
      res.packages.forEach(pkg => {
        const card = document.createElement('div');
        card.className = 'package-card';
        
        const trafficStr = formatBytes(pkg.trafficBytes);
        
        card.innerHTML = `
          <h4 style="font-weight:bold;">${pkg.name}</h4>
          <div style="font-size:0.85rem;color:var(--text-muted);">有效期: ${pkg.days} 天 | 纯流量包</div>
          <div class="package-price">¥ ${pkg.price.toFixed(2)}</div>
          <div style="font-size:1.1rem;font-weight:bold;color:#10b981;">高速流量: ${trafficStr}</div>
          <div style="display:flex;gap:0.5rem;margin-top:0.5rem;">
            <button class="btn btn-primary" style="flex:1;padding:0.5rem;" onclick="buyPackage('${pkg.id}', 'alipay')">支付宝</button>
            <button class="btn btn-accent" style="flex:1;padding:0.5rem;" onclick="buyPackage('${pkg.id}', 'wxpay')">微信支付</button>
          </div>
        `;
        container.appendChild(card);
      });
    }
  } catch (e) {
    console.error('载入套餐失败:', e);
  }
}

async function buyPackage(packageId, payType) {
  if (!currentUser) {
    showToast('充值前请先注册登录账号！', 'error');
    return;
  }
  
  try {
    showToast('正在创建交易订单...');
    const res = await window.api.createOrder(currentUser.token, packageId, payType);
    if (res.success) {
      currentOrderId = res.checkoutUrl.match(/orderId=(ORD_\w+)/)?.[1] || 'MOCK';
      
      // 显示支付模态框
      document.getElementById('checkoutLink').href = res.checkoutUrl;
      document.getElementById('payModal').style.display = 'flex';
      
      // 如果链接是模拟链接，显示模拟支付按钮
      if (res.checkoutUrl.includes('mock-pay.html')) {
        document.getElementById('mockPayBtn').style.display = 'block';
        currentOrderId = res.checkoutUrl.substring(res.checkoutUrl.lastIndexOf('=') + 1);
      } else {
        document.getElementById('mockPayBtn').style.display = 'none';
      }
    }
  } catch (err) {
    showToast('创建订单失败: ' + err.message, 'error');
  }
}

function closePayModal() {
  document.getElementById('payModal').style.display = 'none';
  // 确认完毕后更新一次数据
  refreshUserInfo();
}

async function confirmMockPayment() {
  if (!currentOrderId) return;
  try {
    const res = await window.api.mockConfirm(currentOrderId);
    if (res.success) {
      showToast('模拟充值到账成功！', 'success');
      closePayModal();
    }
  } catch (e) {
    showToast('模拟充值失败，请检查订单是否存在', 'error');
  }
}

// ==========================================
// 【系统设置管理】
// ==========================================
async function clearSettings() {
  if (confirm('确定要清除所有本地信息吗？这会关闭客户端并清除本地偏好和缓存。')) {
    await window.api.saveSettings({ token: null, defaultDir: null });
    await window.api.stopClash();
    alert('配置已全部重置，应用即将退出。请手动重新运行程序。');
    window.close();
  }
}
