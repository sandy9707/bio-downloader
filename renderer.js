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

        const btnHot = document.getElementById('btnHotPatchUpdate');
        if (btnHot) {
          if (res.patchUrl) {
            btnHot.style.display = 'inline-block';
          } else {
            btnHot.style.display = 'none';
          }
        }

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

async function startHotPatchUpdate() {
  if (isUpdating) {
    showToast('正在应用热更新中，请勿重复点击', 'warning');
    return;
  }
  if (!updateInfoGlobal || !updateInfoGlobal.patchUrl) return;

  const btn = document.getElementById('btnHotPatchUpdate');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ 正在下载应用代码补丁 (3MB)...';
  }
  isUpdating = true;
  showToast('正在高速下载应用代码补丁包 (3MB)...', 'info');

  try {
    const res = await window.api.applyHotPatch(updateInfoGlobal.patchUrl);
    if (res.success) {
      showToast(res.message || '热更新成功！应用即将重启...', 'success');
    }
  } catch (err) {
    showToast('热更新应用失败: ' + err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerText = '⚡ 极速平滑热更新 (仅 3MB)';
    }
    isUpdating = false;
  }
}

window.startHotPatchUpdate = startHotPatchUpdate;

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

  const backendUrl = platform === 'win' ? updateInfoGlobal.winUrl : updateInfoGlobal.macUrl;
  const fileName = backendUrl.substring(backendUrl.lastIndexOf('/') + 1);
  const btnId = platform === 'win' ? 'downloadWinUpdateBtn' : 'downloadMacUpdateBtn';
  
  const btn = document.getElementById(btnId);
  const originalText = btn ? btn.innerText : '下载';

  // 根据当前版本号动态生成 GitHub Release 下载直链
  const githubUrl = platform === 'win'
    ? `https://github.com/sandy9707/bio-downloader/releases/download/v${updateInfoGlobal.latestVersion}/BioDownloader.${updateInfoGlobal.latestVersion}.exe`
    : `https://github.com/sandy9707/bio-downloader/releases/download/v${updateInfoGlobal.latestVersion}/BioDownloader-${updateInfoGlobal.latestVersion}-arm64.dmg`;

  // 检测 Clash 内置加速代理是否启动
  const clashRunning = await window.api.clashStatus();
  let targetUrl = backendUrl;
  let usingGithub = false;

  if (clashRunning) {
    console.log('检测到加速通道已开启，优先使用 GitHub Releases 下载源:', githubUrl);
    targetUrl = githubUrl;
    usingGithub = true;
  } else {
    console.log('使用默认发布站下载源:', backendUrl);
  }

  const updateFile = {
    name: fileName,
    url: targetUrl,
    size: 150 * 1024 * 1024, // 150MB placeholder
    originalIndex: 9999, // Special index for update
    percentage: 0,
    status: 'waiting',
    speed: '排队中...',
    isUpdate: true
  };

  // 写入正在下载队列
  if (!activeDownloads.find(d => d.originalIndex === 9999)) {
    activeDownloads.push(updateFile);
    renderDownloadingList();
    updateTransferCounts();
  }

  showToast('更新包已加入传输列表！开始高速通道免费下载更新...', 'success');
  
  // 切换至传输中心
  switchTab('transfers-tab');
  switchTransferSubTab('downloading');

  try {
    isUpdating = true;
    if (btn) {
      btn.disabled = true;
      btn.innerText = '已加入传输列表下载...';
    }
    
    // 执行第一次下载尝试
    await window.api.startDownload([updateFile], defaultDir, currentUser ? currentUser.token : '', maxConcurrentDownloadsSetting);
    
    if (btn) {
      btn.innerText = '下载完成！已在文件夹中高亮';
    }
  } catch (err) {
    // 如果是 GitHub 源下载失败，自动降级切换至发布页自建源重试
    if (usingGithub) {
      console.warn('GitHub 下载失败，自动回退到自建发布站下载源重试:', backendUrl);
      showToast('加速通道连接超时，已自动为您切换到发布站下载源重新下载...', 'warning');
      updateFile.url = backendUrl;
      try {
        await window.api.startDownload([updateFile], defaultDir, currentUser ? currentUser.token : '', maxConcurrentDownloadsSetting);
        if (btn) {
          btn.innerText = '下载完成！已在文件夹中高亮';
        }
        return;
      } catch (err2) {
        console.error('自建发布站下载源也重试失败:', err2.message);
      }
    }

    if (btn) btn.innerText = originalText;
    showToast('加速下载更新包失败，已自动为您打开浏览器下载...', 'error');
    window.api.openExternalUrl(backendUrl);
  } finally {
    isUpdating = false;
    if (btn) btn.disabled = false;
    activeDownloads = activeDownloads.filter(d => d.originalIndex !== 9999);
    renderDownloadingList();
    updateTransferCounts();
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
  const inviteCodeInput = document.getElementById('authInviteCode');
  const inviteCode = inviteCodeInput ? inviteCodeInput.value.trim() : '';

  if (!user || !pass) {
    showToast('账号和密码不能为空', 'error');
    return;
  }

  try {
    const res = await window.api.register(user, pass, email, inviteCode);
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
      
      // 更新邀请与返利信息
      const inviteCodeEl = document.getElementById('profInviteCode');
      if (inviteCodeEl) inviteCodeEl.innerText = res.inviteCode || '无';
      const inviteUrlEl = document.getElementById('profInviteUrl');
      if (inviteUrlEl) inviteUrlEl.value = res.inviteCode ? `https://biodown.yeyeziblog.eu.org/?aff=${res.inviteCode}` : '无';
      const balanceEl = document.getElementById('profBalance');
      if (balanceEl) balanceEl.innerText = (res.balance || 0).toFixed(2);
      
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
        const priceHtml = pkg.originalPrice
          ? `<span style="text-decoration: line-through; font-size: 0.9rem; color: var(--text-muted); margin-right: 0.5rem; font-weight: normal;">¥ ${pkg.originalPrice.toFixed(2)}</span>¥ ${pkg.price.toFixed(2)}`
          : `¥ ${pkg.price.toFixed(2)}`;
        
        card.innerHTML = `
          <h4 style="font-weight:bold;">${pkg.name}</h4>
          <div style="font-size:0.85rem;color:var(--text-muted);">有效期: ${pkg.days} 天 | 纯流量包</div>
          <div class="package-price">${priceHtml}</div>
          <div style="font-size:1.1rem;font-weight:bold;color:#10b981;margin-bottom:0.5rem;">高速流量: ${trafficStr}</div>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-top:0.5rem; margin-bottom:0.75rem; background:rgba(255,255,255,0.03); padding:0.4rem 0.6rem; border-radius:6px; border:1px solid var(--border-color);">
            <span style="font-size:0.85rem; color:var(--text-muted);">选择购买数量:</span>
            <input type="number" id="qty-${pkg.id}" value="1" min="1" max="99" style="width:60px; background:var(--bg-input); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px; padding:0.2rem; text-align:center; outline:none; font-weight:bold;">
          </div>
          <div style="margin-top:0.5rem; display:flex; gap:0.5rem;">
            <button class="btn btn-primary" style="flex:1; padding:0.5rem; font-size:0.85rem;" onclick="buyPackage('${pkg.id}', 'alipay')">支付宝</button>
            <button class="btn btn-success" style="flex:1; padding:0.5rem; font-size:0.85rem; background:#10b981;" onclick="buyPackage('${pkg.id}', 'balance')">余额支付</button>
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
  
  const qtyInput = document.getElementById(`qty-${packageId}`);
  const quantity = qtyInput ? parseInt(qtyInput.value, 10) || 1 : 1;
  
  try {
    showToast('正在创建交易订单...');
    const res = await window.api.createOrder(currentUser.token, packageId, payType, quantity);
    if (res.success) {
      if (res.isBalancePay) {
        showToast(res.message || '余额支付成功，高速流量已即时到账！', 'success');
        refreshUserInfo();
        return;
      }
      currentOrderId = res.checkoutUrl.match(/orderId=(ORD_\w+)/)?.[1] || 'MOCK';
      
      // 显示支付模态框
      document.getElementById('checkoutLink').href = res.checkoutUrl;
      document.getElementById('payModal').style.display = 'flex';
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
  const groupInvite = document.getElementById('group-invite');
  
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
    if (groupInvite) groupInvite.style.display = 'none';
    if (labelPassword) labelPassword.innerText = '登录密码';
    
    if (btnLoginSubmit) btnLoginSubmit.style.display = 'block';
    if (btnRegisterSubmit) btnRegisterSubmit.style.display = 'none';
    if (btnForgotSubmit) btnForgotSubmit.style.display = 'none';
  } else if (tab === 'register') {
    if (groupUsername) groupUsername.style.display = 'flex';
    if (groupEmail) groupEmail.style.display = 'flex';
    if (groupCode) groupCode.style.display = 'none';
    if (groupPassword) groupPassword.style.display = 'flex';
    if (groupInvite) groupInvite.style.display = 'flex';
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
    if (groupInvite) groupInvite.style.display = 'none';
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

  // 3. 载入诊断日志开关设置
  const toggle = document.getElementById('settingsLoggingToggle');
  if (toggle) {
    toggle.checked = (settings && settings.loggingEnabled) || false;
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

// ==========================================
// 【节点诊断与测速功能 (v1.4.5)】
// ==========================================

function runUstcSpeedTest() {
  window.api.openExternalUrl('https://test.ustc.edu.cn/');
}

async function checkNodeConnection() {
  const statusEl = document.getElementById('diagStatus');
  const btn = document.getElementById('diagBtn');
  const icon = document.getElementById('diagIcon');
  
  statusEl.innerText = '正在测速诊断中...';
  statusEl.style.color = 'var(--text-muted)';
  btn.disabled = true;
  icon.innerText = '🔄';

  try {
    const res = await window.api.testNodeConnection();
    if (res.proxy.ok) {
      statusEl.innerHTML = `<span style="color:#10b981;">🟢 加速节点连通正常 (${res.proxy.time}ms)</span><br>` + 
                           `<span style="font-size:0.75rem;color:var(--text-muted);">本地直连结果: ${res.direct.ok ? `已连通 (${res.direct.time}ms)` : '❌ 无法连通'}</span>`;
      icon.innerText = '✅';
    } else {
      statusEl.innerHTML = `<span style="color:#ef4444;">❌ 加速节点连接异常</span><br>` +
                           `<span style="font-size:0.75rem;color:var(--text-muted);">请核对是否已登录账户且开启了加速通道</span>`;
      icon.innerText = '⚠️';
    }
  } catch (err) {
    statusEl.innerHTML = `<span style="color:#ef4444;">诊断出错: ${err.message}</span>`;
    icon.innerText = '⚠️';
  } finally {
    btn.disabled = false;
  }
}

// ==========================================
// 【诊断日志系统管理 (v1.4.5)】
// ==========================================

async function toggleLogging(checked) {
  try {
    const oldSettings = await window.api.getSettings();
    await window.api.saveSettings({ loggingEnabled: checked });
    
    // 如果是关闭日志，且之前是开启状态，主动提示用户上报刚刚生成的错误日志
    if (!checked && oldSettings.loggingEnabled) {
      const logs = await window.api.getLogsList();
      if (logs && logs.length > 0) {
        setTimeout(() => {
          if (confirm('检测到您刚刚关闭了日志记录。是否需要打开日志管理器，查看刚刚捕获的下载错误日志并一键上传给开发者排查？')) {
            openLogManagerModal();
          }
        }, 300);
      }
    }
    showToast(checked ? '已启用详细下载诊断日志' : '已关闭下载诊断日志');
  } catch (err) {
    console.error('Failed to toggle logging settings:', err);
  }
}

let localLogsList = [];
let selectedLogFilename = '';

async function openLogManagerModal() {
  document.getElementById('logManagerModal').style.display = 'flex';
  hideLogPreview();
  await loadLocalLogsList();
}

function closeLogManagerModal() {
  document.getElementById('logManagerModal').style.display = 'none';
}

async function loadLocalLogsList() {
  try {
    localLogsList = await window.api.getLogsList();
    renderLocalLogsTable(localLogsList);
  } catch (err) {
    console.error('Failed to load local logs:', err);
  }
}

function renderLocalLogsTable(list) {
  const tbody = document.getElementById('localLogsTableBody');
  tbody.innerHTML = '';
  
  if (list.length === 0) {
    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 1rem; color: var(--text-muted);">暂无捕获的下载诊断日志</td></tr>';
    return;
  }
  
  list.forEach(log => {
    const tr = document.createElement('tr');
    tr.style.borderBottom = '1px solid rgba(255,255,255,0.02)';
    
    const timeStr = new Date(log.time).toLocaleString();
    const sizeKB = (log.size / 1024).toFixed(2) + ' KB';
    
    tr.innerHTML = `
      <td style="padding: 0.5rem; text-align: left; font-family: monospace; font-size: 0.8rem; word-break: break-all;">
        ${log.name}<br>
        <span style="font-size: 0.7rem; color: var(--text-muted); font-family: inherit;">时间: ${timeStr}</span>
      </td>
      <td style="padding: 0.5rem; text-align: right; color: var(--text-muted);">${sizeKB}</td>
      <td style="padding: 0.5rem; text-align: center; white-space: nowrap;">
        <button class="btn btn-secondary" style="font-size:0.75rem; padding: 0.2rem 0.4rem; margin-right: 0.25rem;" onclick="viewLocalLogDetail('${log.name}')">查看</button>
        <button class="btn btn-danger" style="font-size:0.75rem; padding: 0.2rem 0.4rem;" onclick="deleteLocalLog('${log.name}')">删除</button>
      </td>
    `;
    tbody.appendChild(tr);
  });
}

async function viewLocalLogDetail(filename) {
  try {
    selectedLogFilename = filename;
    const content = await window.api.readLogContent(filename);
    document.getElementById('previewLogName').innerText = filename;
    document.getElementById('logPreviewContent').innerText = content || '(空日志文件)';
    document.getElementById('logPreviewSection').style.display = 'flex';
  } catch (err) {
    showToast('读取日志文件失败: ' + err.message, 'error');
  }
}

function hideLogPreview() {
  document.getElementById('logPreviewSection').style.display = 'none';
  selectedLogFilename = '';
}

async function deleteLocalLog(filename) {
  if (!confirm(`确定删除本地日志文件 ${filename} 吗？`)) return;
  try {
    const ok = await window.api.deleteLog(filename);
    if (ok) {
      showToast('日志文件已删除');
      if (selectedLogFilename === filename) {
        hideLogPreview();
      }
      await loadLocalLogsList();
    } else {
      showToast('删除失败', 'error');
    }
  } catch (err) {
    showToast('删除出错: ' + err.message, 'error');
  }
}

async function uploadSelectedLog() {
  if (!selectedLogFilename) return;
  if (!currentUser) {
    showToast('上报日志前请先登录您的账户！', 'error');
    return;
  }
  
  const content = document.getElementById('logPreviewContent').innerText;
  const btn = document.getElementById('btnUploadLog');
  btn.disabled = true;
  btn.innerText = '正在上报中...';
  
  try {
    const res = await window.api.uploadLogContent(currentUser.token, selectedLogFilename, content);
    if (res.success) {
      showToast(res.message || '诊断日志已成功上报，非常感谢您的反馈！');
      hideLogPreview();
    } else {
      showToast('日志上报失败: ' + (res.error || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('网络请求失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerText = '📤 上传日志至云端';
  }
}

// 绑定到 window 暴露给 HTML 属性
window.runUstcSpeedTest = runUstcSpeedTest;
window.checkNodeConnection = checkNodeConnection;
window.toggleLogging = toggleLogging;
window.openLogManagerModal = openLogManagerModal;
window.closeLogManagerModal = closeLogManagerModal;
window.viewLocalLogDetail = viewLocalLogDetail;
window.hideLogPreview = hideLogPreview;
window.deleteLocalLog = deleteLocalLog;
window.uploadSelectedLog = uploadSelectedLog;

// 邀请功能复制逻辑
function copyInviteCode() {
  const codeEl = document.getElementById('profInviteCode');
  const code = codeEl ? codeEl.innerText : '';
  if (code && code !== '-' && code !== '无') {
    navigator.clipboard.writeText(code);
    showToast('邀请码已复制！', 'success');
  } else {
    showToast('无可用的邀请码进行复制', 'error');
  }
}

function copyInviteUrl() {
  const urlEl = document.getElementById('profInviteUrl');
  const url = urlEl ? urlEl.value : '';
  if (url && url !== '-' && url !== '无') {
    navigator.clipboard.writeText(url);
    showToast('邀请链接已复制！', 'success');
  } else {
    showToast('无可用的邀请链接进行复制', 'error');
  }
}

window.copyInviteCode = copyInviteCode;
window.copyInviteUrl = copyInviteUrl;

// 优化连接/刷新通道方法
async function optimizeConnections() {
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户后再执行优化连接', 'error');
    switchTab('profile-tab');
    return;
  }

  const btn = document.getElementById('btnOptimizeConn');
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span>⏳ 正在优化...</span>';
  }

  try {
    const res = await window.api.optimizeClash(currentUser.token);
    if (res.success) {
      showToast(res.message || '网络通道优化成功，已重置所有连接！', 'success');
    }
  } catch (err) {
    showToast('连接优化失败: ' + (err.message || '未知错误'), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<span>⚡ 优化连接</span>';
    }
  }
}

window.optimizeConnections = optimizeConnections;
