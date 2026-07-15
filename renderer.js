// ==========================================
// 【全局状态管理】
// ==========================================
let currentTab = 'download-hub';
let currentDownloadType = 'sra_raw';
let currentUser = null;
let currentQueue = [];
let defaultDir = '';
let currentOrderId = null;
let isDownloading = false;

// 传输列表状态
let activeDownloads = [];
let completedDownloads = [];
let maxConcurrentDownloadsSetting = 3;

// 存储下载中心不同 Tab 的独立状态，防止切换时状态丢失与互相覆盖
const tabStates = {
  sra_raw: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  ebi_raw: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  geo_suppl: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  links: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' }
};

function saveCurrentTabState() {
  if (!currentDownloadType || !tabStates[currentDownloadType]) return;
  tabStates[currentDownloadType] = {
    queue: [...currentQueue],
    checkSizeBtnDisabled: document.getElementById('checkSizeBtn').disabled,
    downloadBtnDisabled: document.getElementById('downloadBtn').disabled,
    downloadBtnDisplay: document.getElementById('downloadBtn').style.display,
    cancelBtnDisplay: document.getElementById('cancelBtn').style.display,
    totalQueueSize: document.getElementById('totalQueueSize').innerText,
    queueHTML: document.getElementById('queueList').innerHTML
  };
}

function restoreTabState(type) {
  const state = tabStates[type];
  if (!state) return;
  currentQueue = [...state.queue];
  document.getElementById('checkSizeBtn').disabled = state.checkSizeBtnDisabled;
  document.getElementById('downloadBtn').disabled = state.downloadBtnDisabled;
  document.getElementById('downloadBtn').style.display = state.downloadBtnDisplay || 'block';
  document.getElementById('cancelBtn').style.display = state.cancelBtnDisplay || 'none';
  document.getElementById('totalQueueSize').innerText = state.totalQueueSize || '共 0 字节';
  document.getElementById('queueList').innerHTML = state.queueHTML || '';
}

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
  // 初始化登录/注册表单显示状态
  switchAuthTab('login');

  // 加载并渲染版本号
  try {
    const version = await window.api.getAppVersion();
    const logoEl = document.querySelector('.logo');
    if (logoEl) {
      logoEl.innerHTML = `BioDownloader Pro <span style="font-size: 0.7rem; vertical-align: middle; opacity: 0.75; font-weight: normal; margin-left: 0.25rem;">v${version}</span>`;
    }
    const versionEl = document.getElementById('settingsAppVersion');
    if (versionEl) versionEl.innerText = 'v' + version;
    const sidebarVerEl = document.getElementById('sidebarVersion');
    if (sidebarVerEl) sidebarVerEl.innerText = 'v' + version;
  } catch (e) {
    console.error('获取版本号失败:', e);
  }

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

  // 4. 初始化传输中心历史记录与并发限制
  initTransfersAndSettings(settings);

  // 5. 定时更新加速器状态
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
  // 如果用户未登录，界面状态由手动控制，不需要后台状态覆盖
  if (!currentUser) return;

  try {
    const isRunning = await window.api.getClashStatus();
    const dot = document.getElementById('clashDot');
    const text = document.getElementById('clashStatusText');
    const toggle = document.getElementById('clashToggle');
    
    if (isRunning) {
      dot.className = 'dot active';
      text.innerText = '加速器已开启';
      toggle.checked = true;
      document.getElementById('clashConfigInfo').innerText = '高速加速通道已建立。';
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
  const dot = document.getElementById('clashDot');
  const text = document.getElementById('clashStatusText');

  if (toggle.checked) {
    if (!currentUser) {
      // 未登录时允许开启，但显示黄色警示/待激活状态
      showToast('请先登录账户，获取您的专属加速服务', 'error');
      dot.className = 'dot warning';
      text.innerText = '未激活加速服务';
      document.getElementById('clashConfigInfo').innerText = '未登录账户，加速通道未激活。';
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
      dot.className = 'dot';
      text.innerText = '加速器已关闭';
    }
  } else {
    if (currentUser) {
      await window.api.stopClash();
    }
    showToast('下载加速器已关闭');
    dot.className = 'dot';
    text.innerText = '加速器已关闭';
    if (currentUser) {
      document.getElementById('clashConfigInfo').innerText = '尚未启动下载加速器。启动下载时会自动开启。';
    } else {
      document.getElementById('clashConfigInfo').innerText = '未登录账户，加速通道未激活。';
    }
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
    'transfers-tab': '传输列表',
    'store-tab': '流量商店',
    'profile-tab': '个人中心',
    'settings-tab': '全局设置'
  };
  document.getElementById('tabTitle').innerText = titles[tabId] || '下载中心';
}

function switchDownloadType(btn, type) {
  if (isDownloading) {
    showToast('下载正在进行中，请先取消当前下载或等待其完成再切换', 'warning');
    return;
  }

  // 1. 保存当前 Tab 状态
  saveCurrentTabState();

  // 2. 切换按钮激活样式
  const buttons = btn.parentElement.querySelectorAll('.pill-btn');
  buttons.forEach(b => b.classList.remove('active'));
  btn.classList.add('active');

  currentDownloadType = type;

  // 3. 切换输入框的可见性
  const types = ['sra_raw', 'ebi_raw', 'geo_suppl', 'links'];
  types.forEach(t => {
    const el = document.getElementById('group-' + t);
    if (el) el.style.display = t === type ? 'flex' : 'none';
  });
  
  // 4. 恢复目标 Tab 状态
  restoreTabState(type);
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
// 【软件自动更新与版本控制】
// ==========================================
let updateInfoGlobal = null;

async function triggerCheckForUpdates() {
  showToast('正在检查服务器最新版本...', 'info');
  try {
    const res = await window.api.checkForUpdates();
    if (res.success) {
      if (res.hasUpdate) {
        updateInfoGlobal = res;
        document.getElementById('updateLatestVersion').innerText = res.latestVersion;
        document.getElementById('updateReleaseNotes').innerText = res.releaseNotes;
        document.getElementById('updateCard').style.display = 'block';
        showToast('检测到新版本，请及时更新', 'success');
      } else {
        showToast(`当前已是最新版本 (v${res.currentVersion})`, 'success');
      }
    } else {
      showToast('无法连接到版本更新服务器: ' + (res.message || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('检查更新时出错: ' + err.message, 'error');
  }
}

function closeUpdateCard() {
  document.getElementById('updateCard').style.display = 'none';
}

let isUpdating = false;

async function downloadUpdate(platform) {
  if (isUpdating) {
    showToast('正在下载更新中，请勿重复点击', 'warning');
    return;
  }
  if (!updateInfoGlobal) return;

  const url = platform === 'win' ? updateInfoGlobal.winUrl : updateInfoGlobal.macUrl;
  const fileName = url.substring(url.lastIndexOf('/') + 1);
  const btnId = platform === 'win' ? 'downloadWinUpdateBtn' : 'downloadMacUpdateBtn';
  const otherBtnId = platform === 'win' ? 'downloadMacUpdateBtn' : 'downloadWinUpdateBtn';
  
  const btn = document.getElementById(btnId);
  const otherBtn = document.getElementById(otherBtnId);
  const originalText = btn.innerText;

  try {
    isUpdating = true;
    btn.disabled = true;
    otherBtn.disabled = true;
    btn.innerText = '正在启动加速下载...';
    showToast('正在通过加速通道下载软件更新，本下载完全免费（不计流量限额）...', 'info');

    // 监听下载进度
    window.api.onUpdateProgress((data) => {
      const { percentage, speed } = data;
      let statusText = '正在加速下载...';
      if (percentage !== null) statusText += ` [${percentage}%]`;
      if (speed !== null) statusText += ` (${speed})`;
      btn.innerText = statusText;
    });

    const res = await window.api.downloadAppUpdate(url, fileName);
    if (res && res.success) {
      btn.innerText = '下载成功！已在文件夹中选中';
      showToast('更新包下载完成！已在系统下载目录中选中，双击即可安装更新。', 'success');
    }
  } catch (err) {
    btn.innerText = originalText;
    showToast('加速下载更新包失败，已自动为您打开默认浏览器下载...', 'error');
    // 发生任何异常，自动降级回退到系统浏览器下载
    window.api.openExternalUrl(url);
  } finally {
    isUpdating = false;
    btn.disabled = false;
    otherBtn.disabled = false;
  }
}

async function openReleasePage() {
  const backendUrl = await window.api.getBackendUrl();
  window.api.openExternalUrl(backendUrl);
}

// ==========================================
// 【文件大小校验与渲染】
// ==========================================
async function checkSizes() {
  const inputVal = document.getElementById('accInput-' + currentDownloadType).value.trim();
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
    currentQueue.forEach((file, idx) => {
      file.originalIndex = idx;
    });
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

    let threads = 16;
    if (file.size) {
      if (file.size < 500 * 1024) {
        threads = 1;
      } else if (file.size < 5 * 1024 * 1024) {
        threads = 4;
      } else if (file.size < 50 * 1024 * 1024) {
        threads = 8;
      }
    }

    itemEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div class="item-meta" style="flex-grow:1;">
          <span class="item-name" title="${file.name}">${file.name}</span>
          <div class="item-info">
            ${folderStr}
            <span>${sizeStr}</span>
            <span class="item-status status-pending" id="status-text-${index}">准备就绪</span>
          </div>
        </div>
        <div style="display:flex; gap:0.5rem; flex-shrink:0; align-items:center;">
          <button class="btn btn-secondary" style="font-size:0.75rem; padding: 2px 6px;" onclick="renameFile(${index})">改名</button>
          <button class="btn btn-primary" id="btn-single-dl-${index}" style="font-size:0.75rem; padding: 2px 6px;" onclick="downloadSingle(${index})">单项下载</button>
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
        <span>Axel ${threads} 线程</span>
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
    switchTab('profile-tab');
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
    switchTab('store-tab');
    return;
  }

  // 初始化传输任务属性与正在下载队列
  currentQueue.forEach((file, index) => {
    file.originalIndex = index;
    file.percentage = 0;
    file.status = 'waiting';
    file.speed = '排队中...';
  });

  activeDownloads = [...currentQueue];
  renderDownloadingList();
  updateTransferCounts();

  // 锁定控制按钮状态
  isDownloading = true;
  document.getElementById('checkSizeBtn').disabled = true;
  document.getElementById('downloadBtn').style.display = 'none';
  document.getElementById('cancelBtn').style.display = 'block';

  // 自动切换至传输列表 tab
  switchTab('transfers-tab');
  switchTransferSubTab('downloading');

  try {
    showToast('已加入传输中心，开始并行下载生信数据包...', 'info');
    await window.api.startDownload(currentQueue, defaultDir, currentUser.token, maxConcurrentDownloadsSetting);
    showToast('生信数据包下载任务运行结束', 'info');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    isDownloading = false;
    // 清空下载中的残留
    activeDownloads = [];
    renderDownloadingList();
    updateTransferCounts();

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
  showToast('正在发送全局取消下载信号...');
  window.api.cancelAllDownloadsSignal();
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
  const emailInput = document.getElementById('authEmail');
  const email = emailInput ? emailInput.value.trim() : '';

  if (!user || !pass) {
    showToast('账号和密码不能为空', 'error');
    return;
  }

  try {
    const res = await window.api.register(user, pass, email);
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
      
      // 登录之后自动把这个按钮自动关掉（防止残留黄色模拟状态）
      const toggle = document.getElementById('clashToggle');
      const clashDot = document.getElementById('clashDot');
      const clashStatusText = document.getElementById('clashStatusText');
      if (toggle && toggle.checked) {
        toggle.checked = false;
        clashDot.className = 'dot';
        clashStatusText.innerText = '加速器已关闭';
      }

      // 显示登录后的界面
      document.getElementById('authFormCard').style.display = 'none';
      document.getElementById('loggedInProfile').style.display = 'grid';
      document.getElementById('userInfoBadge').style.display = 'flex';
      
      // 更新文字
      document.getElementById('headerUsername').innerText = res.username;
      document.getElementById('profUsername').innerText = res.username;
      
      const profUidEl = document.getElementById('profUid');
      if (profUidEl) profUidEl.innerText = res.uid || '无';
      
      document.getElementById('profToken').value = res.token;
      
      const expiryDate = new Date(res.expireAt);
      // 如果是至少 50 年后，显示“永久”
      const isUnlimited = expiryDate.getFullYear() >= new Date().getFullYear() + 50;
      if (isUnlimited) {
        document.getElementById('profExpiry').innerText = '永久有效 ✅';
      } else {
        document.getElementById('profExpiry').innerText = expiryDate.toLocaleString() + (res.isActive ? ' (激活中)' : ' (已过期)');
      }
      
      // 更新邮箱绑定状态与界面显示
      const emailBindStatus = document.getElementById('emailBindStatus');
      const emailBindForm = document.getElementById('emailBindForm');
      if (emailBindStatus && emailBindForm) {
        if (res.email) {
          const parts = res.email.split('@');
          const hiddenEmail = parts[0].length > 3 
            ? parts[0].substring(0, 3) + '***@' + parts[1]
            : parts[0] + '***@' + parts[1];
          emailBindStatus.innerHTML = `已绑定邮箱：<span style="color:#10b981;font-weight:bold;">${hiddenEmail}</span>`;
          emailBindForm.style.display = 'none';
        } else {
          emailBindStatus.innerHTML = `<span style="color:var(--text-muted);">未绑定邮箱 (绑定后可用于自助重置密码)</span>`;
          emailBindForm.style.display = 'flex';
        }
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
  
  const authEmail = document.getElementById('authEmail');
  if (authEmail) authEmail.value = '';
  const authCode = document.getElementById('authCode');
  if (authCode) authCode.value = '';
  const bindEmailInput = document.getElementById('bindEmailInput');
  if (bindEmailInput) bindEmailInput.value = '';
  const bindCodeInput = document.getElementById('bindCodeInput');
  if (bindCodeInput) bindCodeInput.value = '';
  
  // 确保切回登录 Tab
  switchAuthTab('login');
  
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
          <div style="margin-top:0.5rem;">
            <button class="btn btn-primary" style="width:100%;padding:0.5rem;" onclick="buyPackage('${pkg.id}', 'alipay')">立即购买（支付宝）</button>
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
    switchTab('profile-tab');
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

// ==========================================
// 【邮箱与密码找回交互逻辑】
// ==========================================

let activeAuthTab = 'login';
function switchAuthTab(tab) {
  activeAuthTab = tab;
  
  const tabLogin = document.getElementById('tab-btn-login');
  const tabRegister = document.getElementById('tab-btn-register');
  const tabForgot = document.getElementById('tab-btn-forgot');
  
  const groupUsername = document.getElementById('group-username');
  const groupEmail = document.getElementById('group-email');
  const groupCode = document.getElementById('group-code');
  const groupPassword = document.getElementById('group-password');
  
  const labelEmail = document.getElementById('label-email');
  const labelPassword = document.getElementById('label-password');
  
  const btnLoginSubmit = document.getElementById('btn-login-submit');
  const btnRegisterSubmit = document.getElementById('btn-register-submit');
  const btnForgotSubmit = document.getElementById('btn-forgot-submit');
  
  if (!tabLogin || !tabRegister || !tabForgot) return;

  // Reset active classes
  tabLogin.style.fontWeight = 'normal';
  tabLogin.style.color = 'var(--text-muted)';
  tabRegister.style.fontWeight = 'normal';
  tabRegister.style.color = 'var(--text-muted)';
  tabForgot.style.fontWeight = 'normal';
  tabForgot.style.color = 'var(--text-muted)';
  
  // Set target tab active
  const activeBtn = tab === 'login' ? tabLogin : (tab === 'register' ? tabRegister : tabForgot);
  activeBtn.style.fontWeight = 'bold';
  activeBtn.style.color = '#6366f1';
  
  // Toggle form groups
  if (tab === 'login') {
    if (groupUsername) groupUsername.style.display = 'flex';
    if (groupEmail) groupEmail.style.display = 'none';
    if (groupCode) groupCode.style.display = 'none';
    if (groupPassword) groupPassword.style.display = 'flex';
    if (labelPassword) labelPassword.innerText = '登录密码';
    
    if (btnLoginSubmit) btnLoginSubmit.style.display = 'block';
    if (btnRegisterSubmit) btnRegisterSubmit.style.display = 'none';
    if (btnForgotSubmit) btnForgotSubmit.style.display = 'none';
  } else if (tab === 'register') {
    if (groupUsername) groupUsername.style.display = 'flex';
    if (groupEmail) groupEmail.style.display = 'flex';
    if (groupCode) groupCode.style.display = 'none';
    if (groupPassword) groupPassword.style.display = 'flex';
    if (labelEmail) labelEmail.innerText = '绑定邮箱 (选填，用于密码找回)';
    if (labelPassword) labelPassword.innerText = '设置密码';
    
    if (btnLoginSubmit) btnLoginSubmit.style.display = 'none';
    if (btnRegisterSubmit) btnRegisterSubmit.style.display = 'block';
    if (btnForgotSubmit) btnForgotSubmit.style.display = 'none';
  } else if (tab === 'forgot') {
    if (groupUsername) groupUsername.style.display = 'none';
    if (groupEmail) groupEmail.style.display = 'flex';
    if (groupCode) groupCode.style.display = 'flex';
    if (groupPassword) groupPassword.style.display = 'flex';
    if (labelEmail) labelEmail.innerText = '已绑定的电子邮箱';
    if (labelPassword) labelPassword.innerText = '设置新密码 (最少 8 位)';
    
    if (btnLoginSubmit) btnLoginSubmit.style.display = 'none';
    if (btnRegisterSubmit) btnRegisterSubmit.style.display = 'none';
    if (btnForgotSubmit) btnForgotSubmit.style.display = 'block';
  }
}

// 绑定邮箱验证码发送
async function sendBindEmailCode() {
  const emailInput = document.getElementById('bindEmailInput');
  const email = emailInput.value.trim();
  if (!email) {
    showToast('请输入邮箱地址', 'error');
    return;
  }
  
  const sendBtn = document.getElementById('sendBindCodeBtn');
  sendBtn.disabled = true;
  sendBtn.innerText = '正在发送...';
  
  try {
    const res = await window.api.requestEmailBindCode(currentUser.token, email);
    if (res.success) {
      showToast(res.message || '验证码发送成功，请检查收件箱', 'success');
      startCountdown(sendBtn, 60, () => {
        sendBtn.disabled = false;
        sendBtn.innerText = '获取验证码';
      });
    } else {
      showToast(res.error || '验证码发送失败', 'error');
      sendBtn.disabled = false;
      sendBtn.innerText = '获取验证码';
    }
  } catch (err) {
    showToast('发送失败: ' + (err.response?.data?.error || err.message), 'error');
    sendBtn.disabled = false;
    sendBtn.innerText = '获取验证码';
  }
}

// 提交确认绑定邮箱
async function submitEmailBind() {
  const email = document.getElementById('bindEmailInput').value.trim();
  const code = document.getElementById('bindCodeInput').value.trim();
  
  if (!email || !code) {
    showToast('邮箱和验证码不能为空', 'error');
    return;
  }
  
  try {
    const res = await window.api.confirmEmailBind(currentUser.token, email, code);
    if (res.success) {
      showToast('邮箱绑定成功！', 'success');
      await verifyToken(currentUser.token);
    } else {
      showToast(res.error || '绑定失败', 'error');
    }
  } catch (err) {
    showToast('绑定失败: ' + (err.response?.data?.error || err.message), 'error');
  }
}

// 找回密码验证码发送
async function sendResetEmailCode() {
  const email = document.getElementById('authEmail').value.trim();
  if (!email) {
    showToast('请输入电子邮箱地址', 'error');
    return;
  }
  
  const sendBtn = document.getElementById('sendResetCodeBtn');
  sendBtn.disabled = true;
  sendBtn.innerText = '正在发送...';
  
  try {
    const res = await window.api.requestPasswordReset(email);
    if (res.success) {
      showToast('如果该邮箱已注册，验证码邮件已发出', 'success');
      startCountdown(sendBtn, 60, () => {
        sendBtn.disabled = false;
        sendBtn.innerText = '获取验证码';
      });
    } else {
      showToast(res.error || '获取验证码失败', 'error');
      sendBtn.disabled = false;
      sendBtn.innerText = '获取验证码';
    }
  } catch (err) {
    showToast('发送失败: ' + (err.response?.data?.error || err.message), 'error');
    sendBtn.disabled = false;
    sendBtn.innerText = '获取验证码';
  }
}

// 确认重置密码并提交
async function submitPasswordReset() {
  const email = document.getElementById('authEmail').value.trim();
  const code = document.getElementById('authCode').value.trim();
  const newPassword = document.getElementById('authPassword').value.trim();
  
  if (!email || !code || !newPassword) {
    showToast('所有字段均不能为空', 'error');
    return;
  }
  
  if (newPassword.length < 8) {
    showToast('密码长度至少为 8 位', 'error');
    return;
  }
  
  try {
    const res = await window.api.confirmPasswordReset(email, code, newPassword);
    if (res.success) {
      showToast('密码重置成功，请重新登录', 'success');
      document.getElementById('authEmail').value = '';
      document.getElementById('authCode').value = '';
      document.getElementById('authPassword').value = '';
      switchAuthTab('login');
    } else {
      showToast(res.error || '重置密码失败', 'error');
    }
  } catch (err) {
    showToast('重置失败: ' + (err.response?.data?.error || err.message), 'error');
  }
}

// 统一倒计时工具函数
function startCountdown(buttonEl, seconds, onComplete) {
  let remaining = seconds;
  const interval = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(interval);
      if (onComplete) onComplete();
    } else {
      buttonEl.innerText = `${remaining}秒后重新获取`;
    }
  }, 1000);
}

// 队列文件重命名
function renameFile(index) {
  const file = currentQueue[index];
  if (!file) return;
  const newName = prompt('请输入新的文件名：', file.name);
  if (newName && newName.trim()) {
    file.name = newName.trim();
    renderQueue();
  }
}

// 单个文件独立加速下载
async function downloadSingle(index) {
  const file = currentQueue[index];
  if (!file) return;

  if (!currentUser) {
    showToast('请登录账户后开始下载，未登录无法连接代理加速', 'error');
    switchTab('profile-tab');
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
  const totalBytes = file.size || 0;
  const remaining = currentUser.trafficLimit - currentUser.trafficConsumed;
  
  if (remaining < totalBytes) {
    showToast(`您的额度不足！剩余流量: ${formatBytes(remaining)}，所需流量: ${formatBytes(totalBytes)}，请充值后下载`, 'error');
    switchTab('store-tab');
    return;
  }

  // 初始化属性
  file.originalIndex = index;
  file.percentage = 0;
  file.status = 'waiting';
  file.speed = '排队中...';

  // 加入正在下载列表
  if (!activeDownloads.find(d => d.originalIndex === index)) {
    activeDownloads.push(file);
    renderDownloadingList();
    updateTransferCounts();
  }

  // 锁定相关按钮防止二次并发操作
  const singleBtn = document.getElementById(`btn-single-dl-${index}`);
  if (singleBtn) singleBtn.disabled = true;
  document.getElementById('checkSizeBtn').disabled = true;
  document.getElementById('downloadBtn').disabled = true;

  try {
    showToast(`文件 ${file.name} 独立多线程加速下载已启动，请在「传输列表」查看进度...`);
    await window.api.startDownload([file], defaultDir, currentUser.token, maxConcurrentDownloadsSetting);
    showToast(`文件 ${file.name} 下载任务运行完毕！`, 'info');
  } catch (e) {
    showToast(e.message, 'error');
  } finally {
    if (singleBtn) singleBtn.disabled = false;
    document.getElementById('checkSizeBtn').disabled = false;
    document.getElementById('downloadBtn').disabled = false;
    
    // 刷新
    activeDownloads = activeDownloads.filter(d => d.originalIndex !== index);
    renderDownloadingList();
    updateTransferCounts();
    await refreshUserInfo();
  }
}

// ==========================================
// 【传输列表与排队管理控制器】
// ==========================================
let currentTransferSubTab = 'downloading';

function switchTransferSubTab(subTab) {
  currentTransferSubTab = subTab;
  const btnDownloading = document.getElementById('tabBtnDownloading');
  const btnCompleted = document.getElementById('tabBtnCompleted');
  const listDownloading = document.getElementById('transferDownloadingList');
  const listCompleted = document.getElementById('transferCompletedList');
  const btnClear = document.getElementById('btnClearCompleted');

  if (subTab === 'downloading') {
    if (btnDownloading) btnDownloading.classList.add('active');
    if (btnCompleted) btnCompleted.classList.remove('active');
    if (listDownloading) listDownloading.style.display = 'flex';
    if (listCompleted) listCompleted.style.display = 'none';
    if (btnClear) btnClear.style.display = 'none';
  } else {
    if (btnDownloading) btnDownloading.classList.remove('active');
    if (btnCompleted) btnCompleted.classList.add('active');
    if (listDownloading) listDownloading.style.display = 'none';
    if (listCompleted) listCompleted.style.display = 'flex';
    if (btnClear) btnClear.style.display = 'block';
  }
}

function updateTransferCounts() {
  const downloadingCount = activeDownloads.length;
  const downloadingCountEl = document.getElementById('downloadingCount');
  const completedCountEl = document.getElementById('completedCount');
  if (downloadingCountEl) downloadingCountEl.innerText = downloadingCount;
  if (completedCountEl) completedCountEl.innerText = completedDownloads.length;

  const badge = document.getElementById('activeDownloadsBadge');
  if (badge) {
    if (downloadingCount > 0) {
      badge.innerText = downloadingCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }
}

function renderDownloadingList() {
  const container = document.getElementById('transferDownloadingList');
  if (!container) return;

  const emptyState = document.getElementById('emptyDownloadingState');
  const cards = container.querySelectorAll('.transfer-item');
  cards.forEach(c => c.remove());

  if (activeDownloads.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  activeDownloads.forEach((file) => {
    const fileId = file.originalIndex;
    const itemEl = document.createElement('div');
    itemEl.className = 'transfer-item';
    itemEl.id = `transfer-card-${fileId}`;

    const totalSizeStr = formatBytes(file.size || 0);
    const speedText = file.speed || '排队中...';
    const percentage = file.percentage || 0;
    const statusText = file.status === 'waiting' ? '排队中...' : '正在高速下载';

    itemEl.innerHTML = `
      <div class="transfer-item-info">
        <div class="transfer-item-name-row">
          <span class="transfer-item-name">${file.name}</span>
          <span class="transfer-item-badge">${getFileTypeBadge(file.url || '')}</span>
        </div>
        <div class="transfer-item-meta">
          <span class="transfer-item-size" id="trans-size-${fileId}">${formatBytes((file.size * percentage) / 100)} / ${totalSizeStr}</span>
          <span class="transfer-item-speed" id="trans-speed-${fileId}">${speedText}</span>
          <span class="transfer-item-status" id="trans-status-${fileId}">${statusText}</span>
        </div>
      </div>
      <div class="transfer-progress-bar">
        <div class="transfer-progress-fill" id="trans-progress-fill-${fileId}" style="width: ${percentage}%"></div>
      </div>
      <div class="transfer-item-actions">
        <button class="action-btn cancel-btn" onclick="cancelSingleDownload(${fileId})">取消任务</button>
      </div>
    `;
    container.appendChild(itemEl);
  });
}

function renderCompletedList() {
  const container = document.getElementById('transferCompletedList');
  if (!container) return;

  const emptyState = document.getElementById('emptyCompletedState');
  const cards = container.querySelectorAll('.transfer-item');
  cards.forEach(c => c.remove());

  if (completedDownloads.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  completedDownloads.forEach((item, index) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'transfer-item completed';
    itemEl.innerHTML = `
      <div class="transfer-item-info">
        <div class="transfer-item-name-row">
          <span class="transfer-item-name">${item.name}</span>
          <span class="transfer-item-badge">${getFileTypeBadge(item.url || '')}</span>
        </div>
        <div class="transfer-item-meta">
          <span class="transfer-item-size">${formatBytes(item.size || 0)}</span>
          <span class="transfer-item-status completed">${item.skip ? '已校验 (跳过)' : '下载完成'}</span>
          <span class="transfer-item-time">${item.completedAt}</span>
        </div>
      </div>
      <div class="transfer-item-actions">
        <button class="action-btn open-file-btn" onclick="openCompletedFile('${item.savePath || ''}')">📂 打开文件</button>
        <button class="action-btn" onclick="deleteCompletedRecord(${index})">✕ 删除记录</button>
      </div>
    `;
    container.appendChild(itemEl);
  });
}

function getFileTypeBadge(url) {
  if (url.includes('sra_raw') || url.includes('sra-pub-run-odp')) return 'SRA Raw';
  if (url.includes('ebi.ac.uk')) return 'EBI Raw';
  if (url.includes('geo/series')) return 'GEO Suppl';
  return 'Direct Link';
}

function openCompletedFile(savePath) {
  if (!savePath) {
    showToast('该任务无文件存储路径', 'error');
    return;
  }
  window.api.openDownloadsFolder(savePath);
}

function deleteCompletedRecord(index) {
  completedDownloads.splice(index, 1);
  localStorage.setItem('completed_downloads', JSON.stringify(completedDownloads));
  renderCompletedList();
  updateTransferCounts();
}

function clearCompletedDownloads() {
  completedDownloads = [];
  localStorage.setItem('completed_downloads', JSON.stringify([]));
  renderCompletedList();
  updateTransferCounts();
}

async function cancelSingleDownload(fileId) {
  try {
    showToast('正在取消下载任务...');
    const res = await window.api.cancelDownload(fileId);
    if (res) {
      showToast('任务已取消', 'success');
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== fileId);
      renderDownloadingList();
      updateTransferCounts();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function changeMaxConcurrent(val) {
  maxConcurrentDownloadsSetting = parseInt(val, 10) || 3;
  try {
    const settings = await window.api.getSettings();
    settings.maxConcurrent = maxConcurrentDownloadsSetting;
    await window.api.saveSettings(settings);
    showToast(`同时下载数量已修改为：${maxConcurrentDownloadsSetting}`, 'success');
  } catch (err) {
    console.error('保存并发设置失败:', err);
  }
}

// 载入已下载历史与并发数
function initTransfersAndSettings(settings) {
  // 1. 载入已完成历史
  try {
    const stored = localStorage.getItem('completed_downloads');
    if (stored) {
      completedDownloads = JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load completed history:', e);
  }

  // 2. 载入并发数量设置
  if (settings && settings.maxConcurrent) {
    maxConcurrentDownloadsSetting = parseInt(settings.maxConcurrent, 10) || 3;
    const select = document.getElementById('settingsMaxConcurrent');
    if (select) select.value = maxConcurrentDownloadsSetting;
  }

  renderCompletedList();
  renderDownloadingList();
  updateTransferCounts();
}

// ==========================================
// 【全局 IPC 进度监听事件绑定】
// ==========================================
window.api.onDownloadStatus((data) => {
  const { index, status, fileName, savePath } = data;
  
  // 1. 更新下载中心的队列 UI
  const fill = document.getElementById(`progress-fill-${index}`);
  const pct = document.getElementById(`progress-pct-${index}`);
  const txt = document.getElementById(`status-text-${index}`);
  
  if (txt) {
    if (status === 'downloading') {
      txt.className = 'item-status status-downloading';
      txt.innerText = '正在高速下载';
      if (data.speed && data.speed.includes('重试')) {
        const speedEl = document.getElementById(`speed-text-${index}`);
        if (speedEl) speedEl.innerText = data.speed;
      }
    } else if (status === 'completed') {
      txt.className = 'item-status status-completed';
      txt.innerText = '下载完成';
      if (fill) fill.style.width = '100%';
      if (pct) pct.innerText = '100%';
      const speedEl = document.getElementById(`speed-text-${index}`);
      if (speedEl) speedEl.innerText = data.speed || '已保存';
    } else if (status === 'failed') {
      txt.className = 'item-status status-failed';
      txt.innerText = '下载失败';
      const speedEl = document.getElementById(`speed-text-${index}`);
      if (speedEl) speedEl.innerText = data.speed || '下载失败';
    } else if (status === 'cancelled') {
      txt.className = 'item-status status-failed';
      txt.innerText = '已取消';
      const speedEl = document.getElementById(`speed-text-${index}`);
      if (speedEl) speedEl.innerText = '已取消';
    }
  }

  // 2. 更新传输中心的正在下载/已完成任务状态
  const activeItem = activeDownloads.find(d => d.originalIndex === index);
  if (activeItem) {
    activeItem.status = status;
    if (data.speed) activeItem.speed = data.speed;
    
    if (status === 'completed') {
      activeItem.percentage = 100;
      const completedItem = {
        name: activeItem.name,
        url: activeItem.url,
        size: activeItem.size,
        savePath: savePath || '',
        completedAt: new Date().toLocaleString(),
        skip: (data.speed && data.speed.includes('跳过'))
      };
      completedDownloads.unshift(completedItem);
      localStorage.setItem('completed_downloads', JSON.stringify(completedDownloads));
      
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== index);
      renderCompletedList();
      renderDownloadingList();
    } else if (status === 'failed' || status === 'cancelled') {
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== index);
      renderDownloadingList();
    } else {
      const transStatus = document.getElementById(`trans-status-${index}`);
      const transSpeed = document.getElementById(`trans-speed-${index}`);
      if (transStatus) {
        transStatus.innerText = status === 'waiting' ? '排队中...' : '正在高速下载';
      }
      if (transSpeed && data.speed) {
        transSpeed.innerText = data.speed;
      }
    }
    updateTransferCounts();
  }
});

window.api.onDownloadProgress((data) => {
  const { index, percentage, speed } = data;
  
  // 1. 更新下载中心的队列 UI
  if (percentage !== null) {
    const fill = document.getElementById(`progress-fill-${index}`);
    const pct = document.getElementById(`progress-pct-${index}`);
    if (fill) fill.style.width = percentage + '%';
    if (pct) pct.innerText = percentage + '%';
  }
  if (speed !== null) {
    const speedEl = document.getElementById(`speed-text-${index}`);
    if (speedEl) speedEl.innerText = '当前速度: ' + speed;
  }

  // 2. 更新传输中心 UI
  const activeItem = activeDownloads.find(d => d.originalIndex === index);
  if (activeItem) {
    if (percentage !== null) {
      activeItem.percentage = percentage;
      const fill = document.getElementById(`trans-progress-fill-${index}`);
      const sizeEl = document.getElementById(`trans-size-${index}`);
      if (fill) fill.style.width = percentage + '%';
      if (sizeEl) {
        const totalSizeStr = formatBytes(activeItem.size || 0);
        sizeEl.innerText = `${formatBytes((activeItem.size * percentage) / 100)} / ${totalSizeStr}`;
      }
    }
    if (speed !== null) {
      activeItem.speed = speed;
      const speedEl = document.getElementById(`trans-speed-${index}`);
      if (speedEl) speedEl.innerText = '当前速度: ' + speed;
    }
  }
});

// 绑定到 window 暴露给 HTML 属性
window.switchTransferSubTab = switchTransferSubTab;
window.changeMaxConcurrent = changeMaxConcurrent;
window.openCompletedFile = openCompletedFile;
window.deleteCompletedRecord = deleteCompletedRecord;
window.clearCompletedDownloads = clearCompletedDownloads;
window.cancelSingleDownload = cancelSingleDownload;
window.initTransfersAndSettings = initTransfersAndSettings;
