// ==========================================
// 【全局状态管理】
// ==========================================
let currentTab = 'download-hub';
let currentDownloadType = 'bioproject';
let currentUser = null;
let clashToggleBusy = false; // 手动切换加速器期间,阻止 3s 轮询覆盖开关状态
let currentQueue = [];
let defaultDir = '';
let currentOrderId = null;
let isDownloading = false;
let editingIndex = -1; // 当前正在行内改名的队列下标(-1 表示无)

// HTML 转义:防止文件名中的特殊字符(如 <img onerror>、引号)破坏队列 DOM 或造成注入
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 队列空态提示文案(随数据源切换,避免 Zenodo/HuggingFace/直链 下仍提示 SRA/EBI/GEO)
function getQueueEmptyHint() {
  const sharedSource = window.BioDownloadSources?.byId?.[currentDownloadType];
  if (sharedSource) return `${sharedSource.placeholder}，点击“检验下载大小”后生成下载队列`;
  const hints = {
    sra_raw: '请输入 SRA 编号(如 SRR1234567),点击"检验下载大小"后自动生成下载队列',
    ebi_raw: '请输入 EBI / ENA 编号,点击"检验下载大小"后自动生成下载队列',
    geo_suppl: '请输入 GEO 编号(如 GSE12345),点击"检验下载大小"后自动生成下载队列',
    links: '请输入直链下载 URL(每行一个),点击"检验下载大小"后自动生成下载队列',
    zenodo: '请输入 Zenodo 记录号(如 1234567),点击"检验下载大小"后自动生成下载队列',
    huggingface: '请输入 Hugging Face 仓库(如 组织名/数据集名),点击"检验下载大小"后自动生成下载队列'
  };
  return hints[currentDownloadType] || hints.sra_raw;
}

function updateEmptyQueueHint() {
  const el = document.querySelector('#emptyQueueState p');
  if (el) el.innerText = getQueueEmptyHint();
}

// 传输列表状态
let activeDownloads = [];
let completedDownloads = [];
let failedDownloads = [];
var extractionJobs = {};
let currentTransferSubTab = 'downloading';
let transferSearchQuery = ''; // 传输列表搜索关键字(按任务名过滤,三个子页签通用)
const TRANSFER_PAGE_SIZE = 50; // 超过大批量（如上千条）时进行分页按需渲染，杜绝DOM过载卡死
let transferPages = {
  downloading: 1,
  completed: 1,
  failed: 1
};
let maxConcurrentDownloadsSetting = 3;
let lowPowerModeSetting = false;
let stableModeSetting = false;

// 存储下载中心不同 Tab 的独立状态，防止切换时状态丢失与互相覆盖
const tabStates = {
  bioproject: { queue: [], checkSizeBtnDisabled: true, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  sra_raw: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  ebi_raw: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  geo_suppl: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  zenodo: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
  huggingface: { queue: [], checkSizeBtnDisabled: false, downloadBtnDisabled: true, downloadBtnDisplay: 'block', cancelBtnDisplay: 'none', totalQueueSize: '共 0 字节', queueHTML: '' },
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
  bytes = Math.max(0, Number(bytes) || 0); // 防止负数/NaN 使 Math.log 得到 NaN(界面显示 "NaN undefined")
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = document.getElementById('notificationToast');
  toast.innerText = message;
  toast.style.display = 'block';

  if (type === 'success') {
    toast.style.background = 'var(--success-grad)';
  } else if (type === 'error') {
    toast.style.background = 'var(--danger-grad)';
  } else if (type === 'warning') {
    toast.style.background = 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)';
  } else {
    toast.style.background = 'var(--primary-grad)';
  }

  if (toastTimer) clearTimeout(toastTimer); // 连续 toast 时复位定时器,避免前一个提前隐藏后一个
  toastTimer = setTimeout(() => {
    toast.style.display = 'none';
  }, 4000);
}

// ESC 关闭弹窗 / 退出改名态(可访问性)
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const payModal = document.getElementById('payModal');
  if (payModal && payModal.style.display === 'flex') { closePayModal(); return; }
  const logModal = document.getElementById('logManagerModal');
  if (logModal && logModal.style.display === 'flex') { closeLogManagerModal(); return; }
  const infoModal = document.getElementById('infoModal');
  if (infoModal && infoModal.style.display === 'flex') { closeInfoModal(); return; }
  const curlModal = document.getElementById('curlModal');
  if (curlModal && curlModal.style.display === 'flex') { closeCurlModal(); return; }
  if (typeof editingIndex !== 'undefined' && editingIndex !== -1) { cancelRename(); }
});

// 初始化加载 settings 和验证登录
window.addEventListener('DOMContentLoaded', async () => {
  // Local history must be available even while authentication is offline or slow.
  let settings = {};
  try { settings = await window.api.getSettings() || {}; } catch (e) { console.warn('读取设置失败:', e.message); }
  window.BioUsageNotice?.mount({ choice: settings.usageChoice, onChange: value => window.api.setUsageChoice(value) });
  await initTransfersAndSettings(settings);
  renderLocalDownloadSources();
  // 初始化登录/注册表单显示状态
  switchAuthTab('login');

  // 初始化引导式提取(内置浏览器)模块
  initExtraction();

  // 加载并渲染版本号
  try {
    const version = await window.api.getAppVersion();
    window.__APP_VERSION__ = version;
    const logoEl = document.querySelector('.logo');
    if (logoEl) {
      logoEl.innerHTML = `BioDownloader Pro <span style="font-size: 0.7rem; vertical-align: middle; opacity: 0.75; font-weight: normal; margin-left: 0.25rem;">v${version}</span>`;
    }
    const versionEl = document.getElementById('settingsAppVersion');
    if (versionEl) versionEl.innerText = 'v' + version;
    const sidebarVerEl = document.getElementById('sidebarVersion');
    if (sidebarVerEl) sidebarVerEl.innerText = 'v' + version;
    // BioSample 查询随 2.0.44 转正式，保留预览版已确认的入口。
    const biosampleBtn = document.getElementById('biosampleBtn');
    if (biosampleBtn) biosampleBtn.style.display = 'inline-block';
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

  // 1. 获取本地设置（无自定义路径时用平台默认：Windows 桌面 / Mac Downloads）
  if (settings.defaultDir) {
    defaultDir = settings.defaultDir;
  } else if (settings.suggestedDefaultDir) {
    defaultDir = settings.suggestedDefaultDir;
  }
  if (defaultDir) {
    document.getElementById('targetDirInput').value = defaultDir;
    const settingsInput = document.getElementById('settingsDefaultDirInput');
    if (settingsInput) settingsInput.value = defaultDir;
  }

  // 2. 检查是否有本地 Token 并自动登录验证
  if (settings.token) {
    await verifyToken(settings.token, true); // true = 来自自动登录，失败不强制退出
  }

  // 3. 渲染充値包
  loadPackages();
  updateCheckinButton();


  // 4.5 恢复高级模式开关状态
  const advToggle = document.getElementById('settingsAdvancedModeToggle');
  if (advToggle) advToggle.checked = !!(settings && settings.advancedModeEnabled);

  // 5. 定时更新加速器状态
  updateClashUIState();
  setInterval(updateClashUIState, 3000);

  if (window.api && typeof window.api.onClashValidationProgress === 'function') {
    window.api.onClashValidationProgress(setClashValidationProgress);
  }
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
    // 用户正在手动切换时，轮询不要覆盖开关状态（否则刚点开会被 3s 轮询打回，表现为“无法开启开关”）
    if (clashToggleBusy) return;
    const isRunning = await window.api.getClashStatus();
    const dot = document.getElementById('clashDot');
    const text = document.getElementById('clashStatusText');
    const toggle = document.getElementById('clashToggle');

    if (isRunning) {
      dot.className = 'dot active';
      text.innerText = '加速器已开启';
      toggle.checked = true;
      const info = document.getElementById('clashConfigInfo'); if (info) info.innerText = '高速加速通道已建立。';
    } else {
      dot.className = 'dot';
      text.innerText = '加速器已关闭';
      toggle.checked = false;
      const info = document.getElementById('clashConfigInfo'); if (info) info.innerText = '尚未启动下载加速器。启动下载时会自动开启。';
    }
    try {
      const nodeInfo = await window.api.getNodeCount();
      if (nodeInfo && typeof nodeInfo === 'object') {
        updateNodeCountUI(nodeInfo.count, nodeInfo.tier);
      } else if (nodeInfo) {
        updateNodeCountUI(nodeInfo);
      }
    } catch(e) {}
  } catch (e) {
    console.error('获取加速器状态错误:', e);
  }
}

async function toggleClash() {
  const toggle = document.getElementById('clashToggle');
  if (toggle.checked && window.campusNotice && !(await window.campusNotice.beforeUse())) { toggle.checked = false; return; }
  const dot = document.getElementById('clashDot');
  const text = document.getElementById('clashStatusText');
  if (clashToggleBusy) return;
  clashToggleBusy = true;
  try {
    if (toggle.checked) {
      if (!currentUser) {
        showToast('请先登录账户，获取您的专属加速服务', 'error');
        dot.className = 'dot warning';
        text.innerText = '未激活加速服务';
        const info = document.getElementById('clashConfigInfo'); if (info) info.innerText = '未登录账户，加速通道未激活。';
        toggle.checked = false;
        return;
      }
      showToast('正在初始化下载加速器...');
      resetClashValidationProgress();
      const progressWrap = document.getElementById('clashValidationProgress');
      if (progressWrap) progressWrap.style.display = 'block';
      try {
        const startRes = await window.api.startClash(currentUser.token);
        if (startRes && startRes.nodeCount) updateNodeCountUI(startRes.nodeCount, startRes.nodeTier);
        const tierMsg = startRes?.nodeTier === 2
          ? `加速器已开启（自动放宽启用 ${startRes.nodeCount} 个二级连接节点）`
          : startRes?.nodeTier === 3
            ? `加速器已开启（弱网保底启用 ${startRes.nodeCount} 个三级连接节点）`
            : '下载加速器启动成功';
        showToast(tierMsg, 'success');
      } catch (err) {
        const msg = (err && err.message) || '未知错误';
        console.error('[toggleClash] startClash failed:', err);
        showToast('加速器启动失败: ' + msg, 'error');
        const info = document.getElementById('clashConfigInfo'); if (info) info.innerText = '启动失败: ' + msg;
        toggle.checked = false;
        dot.className = 'dot';
        text.innerText = '加速器已关闭';
        resetClashValidationProgress();
        return;
      }
    } else {
      if (currentUser) { try { await window.api.stopClash(); } catch (e) {} }
      showToast('下载加速器已关闭');
    }
  } finally {
    clashToggleBusy = false;
    // 以真实运行状态为准回写开关，避免开关与后台不一致
    try {
      const isRunning = await window.api.getClashStatus();
      toggle.checked = isRunning;
      dot.className = isRunning ? 'dot active' : 'dot';
      text.innerText = isRunning ? '加速器已开启' : '加速器已关闭';
    } catch (e) {}
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
  const activeNavItem = Array.from(navItems).find(item => item.getAttribute('onclick').includes(tabId === 'download-engines-tab' ? 'settings-tab' : tabId === 'ssh-tunnel-tab' ? 'plugins-tab' : tabId));
  if (activeNavItem) activeNavItem.classList.add('active');

  // 切换视图显示
  const tabViews = document.querySelectorAll('.tab-view');
  tabViews.forEach(view => view.classList.remove('active'));
  document.getElementById(tabId).classList.add('active');

  currentTab = tabId;
  const titles = {
    'download-hub': '下载中心',
    'extraction-tab': '引导式提取',
    'transfers-tab': '传输列表',
    'store-tab': '流量商店',
    'cloud-tab': '云下载',
    'profile-tab': '个人中心',
    'plugins-tab': '扩展插件',
    'ssh-tunnel-tab': '连接 Linux Web',
    'settings-tab': '全局设置',
    'download-engines-tab': '下载器配置'
  };
  document.getElementById('tabTitle').innerText = titles[tabId] || '下载中心';
  if (tabId === 'cloud-tab') {
    const guest = document.getElementById('cloudWorkspaceWebview') || document.getElementById('cloudWorkspaceFrame');
    if (guest && !guest.dataset.started) requestAnimationFrame(reloadCloudWorkspace);
    else syncCloudWorkspaceLogin();
  }
  if (tabId === 'plugins-tab') refreshPluginsList();
}

// 云下载只维护官网一套实现；Electron 用 webview，Linux Web 用 iframe + postMessage。
let cloudWorkspaceTimer;
function cloudWorkspaceState(state, message) {
  const status = document.getElementById('cloudWorkspaceStatus');
  if (!status) return;
  clearTimeout(cloudWorkspaceTimer);
  status.dataset.state = state;
  status.textContent = message || ({ loading:'正在加载云下载…', ready:'云下载已连接', error:'云下载加载失败，请重试或在浏览器打开。' }[state]);
  if (state === 'loading') cloudWorkspaceTimer = setTimeout(() => cloudWorkspaceState('error', '云下载加载超时，请重试或在浏览器打开。'), 20000);
}
function reloadCloudWorkspace() {
  const guest = document.getElementById('cloudWorkspaceWebview') || document.getElementById('cloudWorkspaceFrame');
  if (!guest) return;
  cloudWorkspaceState('loading');
  guest.dataset.started = 'true';
  guest.setAttribute('src', guest.dataset.src);
}
function openCloudWorkspaceInBrowser() {
  const guest = document.getElementById('cloudWorkspaceWebview') || document.getElementById('cloudWorkspaceFrame');
  if (guest) window.api.openExternalUrl(guest.dataset.src.replace('?embed=cloud', ''));
}
async function syncCloudWorkspaceLogin() {
  const webview = document.getElementById('cloudWorkspaceWebview');
  const frame = document.getElementById('cloudWorkspaceFrame');
  if (!currentUser?.token) return;
  if (frame) {
    try {
      frame.contentWindow.postMessage({ type: 'biodl-auth-token', token: currentUser.token }, 'https://biodown.ye.aimeals.cn');
    } catch (e) {
      console.warn('云下载 iframe 登录状态同步失败:', e.message);
    }
    return;
  }
  if (!webview || typeof webview.executeJavaScript !== 'function') return;
  // Never inject an account token after the guest has navigated off our page.
  try { if (new URL(webview.getURL()).origin !== new URL(webview.dataset.src).origin) return; } catch (_) { return; }
  const token = JSON.stringify(currentUser.token);
  try {
    const changed = await webview.executeJavaScript(`(() => { const next=${token}; if (localStorage.getItem('bd_token') === next) return false; localStorage.setItem('bd_token', next); return true; })()`);
    if (changed) webview.reload();
  } catch (e) { cloudWorkspaceState('error', '云下载登录同步失败，请重新加载。'); }
}

document.addEventListener('DOMContentLoaded', () => {
  const webview = document.getElementById('cloudWorkspaceWebview');
  if (webview) {
    webview.addEventListener('dom-ready', syncCloudWorkspaceLogin);
    webview.addEventListener('did-start-loading', () => cloudWorkspaceState('loading'));
    webview.addEventListener('did-fail-load', (event) => {
      if (event.isMainFrame && event.errorCode !== -3) cloudWorkspaceState('error', `云下载页面加载失败（${event.errorCode}），请重试或在浏览器打开。`);
    });
    webview.addEventListener('render-process-gone', () => cloudWorkspaceState('error'));
    webview.addEventListener('ipc-message', async (event) => {
      try { if (new URL(webview.getURL()).origin !== new URL(webview.dataset.src).origin) return; } catch (_) { return; }
      if (event.channel === 'biodl-cloud-state') cloudWorkspaceState(event.args[0] === 'ready' ? 'ready' : 'error');
      if (event.channel === 'biodl-cloud-open-external') {
        try {
          const url = new URL(event.args[0]);
          if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
          const result = await window.api.openExternalUrl(url.href);
          if (result && result.success === false) showToast('打开失败，请复制分享链接到浏览器。', 'error');
        } catch (_) { showToast('打开失败，请复制分享链接到浏览器。', 'error'); }
      }
    });
  }
  const frame = document.getElementById('cloudWorkspaceFrame');
  if (frame) {
    frame.addEventListener('load', syncCloudWorkspaceLogin);
    window.addEventListener('message', (event) => {
      if (event.source !== frame.contentWindow || event.origin !== new URL(frame.dataset.src).origin) return;
      if (event.data?.type === 'biodl-cloud-state') cloudWorkspaceState(event.data.status === 'ready' ? 'ready' : 'error');
    });
  }
  // Attach the guest only after the cloud tab is visible. Hidden webviews can
  // remain blank until navigation is restarted after attachment.
});

function toggleMoreMenu(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('moreDropdownMenu');
  if (menu) {
    menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
  }
}

document.addEventListener('click', () => {
  const menu = document.getElementById('moreDropdownMenu');
  if (menu) menu.style.display = 'none';
});

function selectMoreType(el, type, labelName) {
  const menu = document.getElementById('moreDropdownMenu');
  if (menu) menu.style.display = 'none';

  const btn = document.getElementById('moreDropdownBtn');
  const textEl = document.getElementById('moreDropdownText');
  
  if (btn && textEl) {
    textEl.innerText = `${labelName} ✨`;
  }
  
  switchDownloadType(btn, type);
}

function selectLocalSource(type, btn) {
  const otherContainer = document.getElementById('localOtherSources');
  if (type === 'other') {
    const isShown = otherContainer.style.display === 'inline-flex';
    otherContainer.style.display = isShown ? 'none' : 'inline-flex';
    document.querySelectorAll('#localSourceGrid .pill-btn').forEach(b => b.classList.toggle('active', b.dataset.type === 'other'));
    return;
  }
  otherContainer.style.display = BioDownloadSources.extras.some(s => s.id === type) ? 'inline-flex' : 'none';
  switchDownloadType(btn, type);
}

function renderLocalDownloadSources() {
  const grid = document.getElementById('localSourceGrid');
  if (!grid || !window.BioDownloadSources) return;
  grid.innerHTML = BioDownloadSources.renderPrimaryButtons('selectLocalSource', 'pill-btn');
  document.getElementById('localOtherSources').className = 'btn-group hub-secondary-row';
  document.getElementById('localOtherSources').innerHTML = BioDownloadSources.extras.map(s => `<button class="pill-btn" onclick="selectLocalSource('${s.id}',this)">${s.label}</button>`).join('');
  BioDownloadSources.all.filter(s => !s.project).forEach((source) => {
    const input = document.getElementById('accInput-' + source.id);
    if (!input) return;
    input.placeholder = source.placeholder;
    input.value = source.example;
  });
  const first = grid.querySelector('[data-type="bioproject"]');
  if (first) switchDownloadType(first, 'bioproject');
}

function switchDownloadType(btn, type) {
  if (isDownloading) {
    showToast('下载正在进行中，请先取消当前下载或等待其完成再切换', 'warning');
    return;
  }

  // 1. 保存当前 Tab 状态
  saveCurrentTabState();

  // 2. 切换按钮激活样式：清除所有数据源按钮的 active，仅激活当前被点击的按钮
  document.querySelectorAll('#localSourceGrid .pill-btn, #localOtherSources .pill-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  // 如果选的是子数据源，同时高亮父级「其他数据源」主按钮
  if (BioDownloadSources.extras.some(s => s.id === type)) {
    const parentBtn = document.querySelector('#localSourceGrid [data-type="other"]');
    if (parentBtn) parentBtn.classList.add('active');
  }

  // 如果选的不是更多菜单里的项，恢复更多按钮默认字样
  if (!['zenodo', 'huggingface', 'ftp', 'sftp'].includes(type)) {
    const textEl = document.getElementById('moreDropdownText');
    if (textEl) textEl.innerText = '更多数据源 ✨';
  }

  currentDownloadType = type;
  const checkBtn = document.getElementById('checkSizeBtn');
  if (checkBtn) checkBtn.style.display = type === 'bioproject' ? 'none' : 'block';

  // 3. 切换输入框的可见性
  const types = ['bioproject', 'sra_raw', 'ebi_raw', 'geo_suppl', 'links', 'zenodo', 'huggingface', 'ftp', 'sftp'];
  types.forEach(t => {
    const el = t === 'bioproject' ? document.getElementById('bioProjectPanel') : document.getElementById('group-' + t);
    if (el) el.style.display = t === type ? 'flex' : 'none';
  });
  
  // 4. 恢复目标 Tab 状态
  restoreTabState(type);
  updateEmptyQueueHint(); // 队列空态提示文案随数据源切换
}

function openDownloadsDirectory() {
  const dir = defaultDir || document.getElementById('targetDirInput')?.value || '';
  window.api.openDownloadsFolder(dir);
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
let upgrade2xInfoGlobal = null; // 2.x 升级桥接信息(来自 1.x 清单的 upgrade2x 块)
let previewInfoGlobal = null;   // Preview 预览版信息(高级模式开启时返回)

async function triggerCheckForUpdates() {
  showToast('正在检查服务器最新版本...', 'info');
  try {
    // 高级模式开启时,同时拉取正式版(channel=主版本)与预览版(channel=P2)
    const advancedMode = await isAdvancedModeEnabled();
    const res = await window.api.checkForUpdates(advancedMode);
    if (res.success) {
      // 正式版更新卡片:有正式版新版本 或 有稳定版回滚选项(预览版用户开高级模式回滚到正式版)时显示
      const stableRollback = res.stableRollback;
      const hasStableUpdate = res.hasUpdate && !res.isPreviewClient;
      document.getElementById('updateCard').style.display = 'none';
      if (hasStableUpdate || stableRollback) {
        updateInfoGlobal = hasStableUpdate ? res : { ...res, ...stableRollback };
        const stableVersion = hasStableUpdate ? res.latestVersion : stableRollback.version;
        const stableNotes = hasStableUpdate ? res.releaseNotes : stableRollback.releaseNotes;
        document.getElementById('updateLatestVersion').innerText = stableVersion;
        document.getElementById('updateReleaseNotes').innerText = stableNotes;

        const btnHot = document.getElementById('btnHotPatchUpdate');
        if (btnHot) {
          if (res.platform === 'linux' || (!window.api.isElectron && res.linuxUrl)) {
            btnHot.style.display = 'inline-block';
            btnHot.innerText = '⚡ 升级 Linux 服务端';
            btnHot.onclick = startLinuxSelfUpdate;
          } else if (res.patchUrl) {
            btnHot.style.display = 'inline-block';
            btnHot.innerText = hasStableUpdate ? '⚡ 下载并应用更新补丁' : '⚡ 回滚到正式版 (热更新)';
            btnHot.onclick = startHotPatchUpdate;
          } else {
            btnHot.style.display = 'none';
          }
        }

        document.getElementById('updateCard').style.display = 'block';
        const cardTitle = document.querySelector('#updateCard span');
        if (cardTitle) {
          cardTitle.innerHTML = hasStableUpdate
            ? `🎁 检测到新版本 v<span id="updateLatestVersion">${stableVersion}</span>`
            : `🔄 正式版 v<span id="updateLatestVersion">${stableVersion}</span> 可回滚`;
        }
        showToast(hasStableUpdate ? '检测到新版本，请及时更新' : '检测到正式版可回滚', hasStableUpdate ? 'success' : 'info');
      } else {
        // 正式版通道已是最新,但预览版通道可能仍有新版本:避免误导提示
        // (预览版客户端自动跟随 P2 通道;正式版用户需开启高级模式才能看到预览版)
        const pv = res.preview;
        if (pv && pv.version && pv.hasUpdate) {
          showToast(`正式版已是最新；预览版 v${pv.version} 可更新`, 'info');
        } else {
          showToast(`当前已是最新版本 (v${res.currentVersion})`, 'success');
        }
      }

      // 2.x 升级桥接:清单声明 2.x 可热更新时,在常规更新之后额外显示升级卡片(1.x 绝不强制)
      const card2x = document.getElementById('updateCard2x');
      if (card2x) {
        if (res.upgrade2x && res.upgrade2x.patchUrl) {
          document.getElementById('update2xVersion').innerText = res.upgrade2x.version;
          document.getElementById('update2xReleaseNotes').innerText = res.upgrade2x.releaseNotes || '';
          upgrade2xInfoGlobal = res.upgrade2x;
          card2x.style.display = 'block';
        } else {
          card2x.style.display = 'none';
        }
      }

      // Preview 预览版卡片:当前客户端是预览版(自动跟随)或高级模式开启、存在预览版、且版本确实高于当前时显示
      const cardPreview = document.getElementById('updateCardPreview');
      if (cardPreview) {
        const pv = res.preview;
        const showPreview = (res.isPreviewClient || advancedMode) && pv && pv.version && (pv.platform === 'linux' ? pv.linuxUrl : pv.patchUrl) && pv.hasUpdate;
        if (showPreview) {
          document.getElementById('updatePreviewVersion').innerText = pv.version;
          document.getElementById('updatePreviewReleaseNotes').innerText = pv.releaseNotes || '';
          previewInfoGlobal = pv;
          cardPreview.style.display = 'block';
        } else {
          cardPreview.style.display = 'none';
          previewInfoGlobal = null;
        }
      }
    } else {
      showToast('无法连接到版本更新服务器: ' + (res.message || '未知错误'), 'error');
    }
  } catch (err) {
    showToast('检查更新时出错: ' + err.message, 'error');
  }
}

if (window.api.onUpdateDownloadProgress) window.api.onUpdateDownloadProgress(data => {
  if (!isUpdating) return;
  const phase = { connecting: '正在连接', verifying: '正在校验更新包', retrying: '正在切换备用源' }[data.phase];
  const text = phase || `下载 ${data.percentage || 0}% · ${data.speed || '连接中'}`;
  for (const id of ['btnHotPatchUpdate', 'btnUpgrade2x', 'btnUpdatePreview']) {
    const button = document.getElementById(id);
    if (button?.disabled) button.innerText = `${data.source} · ${text}`;
  }
});

async function startHotPatchUpdate() {
  if (isUpdating) {
    showToast('正在应用热更新中，请勿重复点击', 'warning');
    return;
  }
  if (!updateInfoGlobal || !updateInfoGlobal.patchUrl) return;

  const btn = document.getElementById('btnHotPatchUpdate');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ 正在下载应用代码补丁...';
  }
  isUpdating = true;
  showToast('正在高速下载应用代码补丁包...', 'info');

  try {
    const res = await window.api.applyHotPatch(updateInfoGlobal.patchUrl);
    if (res.success) {
      showToast(res.message || '补丁已准备，退出后安装并重新启动…', 'success');
    }
  } catch (err) {
    showToast('热更新应用失败: ' + err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerText = '⚡ 下载并应用更新补丁';
    }
    isUpdating = false;
  }
}

window.startHotPatchUpdate = startHotPatchUpdate;

async function startLinuxSelfUpdate() {
  if (isUpdating) {
    showToast('正在更新中，请勿重复点击', 'warning');
    return;
  }
  if (!updateInfoGlobal || !updateInfoGlobal.linuxUrl) return;

  const btn = document.getElementById('btnHotPatchUpdate');
  if (btn) {
    btn.disabled = true;
    btn.innerText = '⏳ 正在下载并解压 Linux 服务端更新...';
  }
  isUpdating = true;
  showToast('正在下载 Linux 服务端程序包并自动部署...', 'info');

  try {
    const res = await window.api.linuxSelfUpdate({
      url: updateInfoGlobal.linuxUrl,
      sha256: updateInfoGlobal.sha256
    });
    if (!res?.success) throw new Error(res?.message || '更新未完成');
    showToast('升级完成。请在服务器重新运行 ./biodl start（或重启进程管理器），再刷新本页。', 'success');
    if (btn) btn.innerText = '升级完成，请重启服务后刷新';
  } catch (err) {
    showToast('Linux 自更新失败: ' + err.message, 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerText = '⚡ 升级 Linux 服务端';
    }
    isUpdating = false;
  }
}

window.startLinuxSelfUpdate = startLinuxSelfUpdate;

// 2.x 升级桥接:用 upgrade2x.patchUrl 走同一套签名热更新(applyHotPatch 会按补丁版本取对应通道清单校验)
async function startUpgrade2x() {
  if (isUpdating) {
    showToast('正在更新中，请勿重复点击', 'warning');
    return;
  }
  if (!upgrade2xInfoGlobal || !upgrade2xInfoGlobal.patchUrl) return;
  const btn = document.getElementById('btnUpgrade2x');
  if (btn) { btn.disabled = true; btn.innerText = '⏳ 正在升级到 2.x...'; }
  isUpdating = true;
  showToast('正在下载 2.x 热更新包...', 'info');
  try {
    const res = await window.api.applyHotPatch(upgrade2xInfoGlobal.patchUrl);
    if (res.success) showToast(res.message || '升级成功！应用即将重启...', 'success');
  } catch (err) {
    showToast('升级到 2.x 失败: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerText = '⚡ 热更新升级到 2.x'; }
    isUpdating = false;
  }
}
window.startUpgrade2x = startUpgrade2x;

// ---- 高级模式(Preview 预览版可选更新) ----
// 读取高级模式开关状态(持久化到 settings)
async function isAdvancedModeEnabled() {
  try {
    const s = await window.api.getSettings();
    return !!(s && s.advancedModeEnabled);
  } catch (e) {
    return false;
  }
}

// 切换高级模式开关
async function toggleAdvancedMode(checked) {
  try {
    await window.api.saveSettings({ advancedModeEnabled: !!checked });
    showToast(checked ? '已开启高级模式（检查更新将显示预览版）' : '已关闭高级模式');
  } catch (err) {
    console.error('Failed to toggle advanced mode:', err);
    showToast('设置保存失败: ' + err.message, 'error');
  }
}
window.toggleAdvancedMode = toggleAdvancedMode;

// Preview 预览版热更新:与正式版热更新同一套签名校验(applyHotPatch 按补丁版本取对应通道清单校验)
async function startPreviewUpdate() {
  if (isUpdating) {
    showToast('正在更新中，请勿重复点击', 'warning');
    return;
  }
  if (!previewInfoGlobal || !(previewInfoGlobal.platform === 'linux' ? previewInfoGlobal.linuxUrl : previewInfoGlobal.patchUrl)) return;
  const btn = document.getElementById('btnUpdatePreview');
  if (btn) { btn.disabled = true; btn.innerText = '⏳ 正在升级到预览版...'; }
  isUpdating = true;
  showToast('正在下载预览版热更新包...', 'info');
  try {
    const res = previewInfoGlobal.platform === 'linux'
      ? await window.api.linuxSelfUpdate({ url: previewInfoGlobal.linuxUrl, sha256: previewInfoGlobal.sha256 })
      : await window.api.applyHotPatch(previewInfoGlobal.patchUrl);
    if (res.success) showToast(res.message || '更新已准备，请按提示完成重启。', 'success');
  } catch (err) {
    showToast('升级到预览版失败: ' + err.message, 'error');
    if (btn) { btn.disabled = false; btn.innerText = '⚡ 热更新到预览版'; }
    isUpdating = false;
  }
}
window.startPreviewUpdate = startPreviewUpdate;

// 首页小入口 / File 菜单:打开引导式提取独立弹窗
function openExtraction() { window.api.openExtraction(); }
window.openExtraction = openExtraction;

// File →「添加链接」:切到下载中心直链页并聚焦输入框
function focusAddLink() {
  switchTab('download-hub');
  const pill = document.querySelector('.pill-btn[onclick*="links"]');
  if (pill) { try { switchDownloadType(pill, 'links'); } catch (e) {} }
  setTimeout(() => {
    const ta = document.getElementById('accInput-links') || document.getElementById('linkInput');
    if (ta) { try { ta.focus(); } catch (e) {} }
    showToast('请粘贴下载链接（每行一个），点击“检验下载大小”后开始加速下载', 'info');
  }, 80);
}
window.api.onMenuAddLink(focusAddLink);

// 传输列表右键菜单:任意状态(下载中/已完成/失败)均可复制下载链接,便于回溯
function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(text); return true; } } catch (e) {}
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.left = '-9999px'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) { return false; }
}
let _ctxMenu = null;
function hideContextMenu() { if (_ctxMenu) _ctxMenu.style.display = 'none'; }
function _ctxMenuItem(label, onClick, danger) {
  const it = document.createElement('div');
  it.textContent = label;
  it.style.cssText = 'padding:8px 14px;cursor:pointer;color:' + (danger ? '#ef4444' : 'var(--text-main)') + ';display:flex;align-items:center;gap:8px;transition:background .12s;white-space:nowrap;';
  it.onmouseenter = () => { it.style.background = 'var(--queue-item-bg)'; };
  it.onmouseleave = () => { it.style.background = 'transparent'; };
  it.onclick = () => { hideContextMenu(); try { onClick(); } catch (err) { console.warn(err); } };
  return it;
}
// 传输列表卡片右键菜单(参考成熟下载器:按任务状态动态给出操作)
function showContextMenu(x, y, ctx) {
  if (!_ctxMenu) {
    _ctxMenu = document.createElement('div');
    _ctxMenu.style.cssText = 'position:fixed;z-index:9999;min-width:172px;background:var(--modal-bg);border:1px solid var(--border-color);border-radius:10px;box-shadow:0 12px 32px rgba(0,0,0,0.28);padding:5px 0;font-size:0.85rem;';
    document.body.appendChild(_ctxMenu);
    document.addEventListener('click', hideContextMenu);
    document.addEventListener('scroll', hideContextMenu, true);
    window.addEventListener('blur', hideContextMenu);
  }
  _ctxMenu.innerHTML = '';
  const items = [];
  if (ctx.url) items.push(['📋 复制下载链接', () => { const ok = copyText(ctx.url); showToast(ok ? '已复制下载链接' : '复制失败', ok ? 'success' : 'error'); }]);
  if (ctx.savePath) items.push(['📂 打开文件所在位置', () => window.api.openDownloadsFolder(ctx.savePath)]);
  if (ctx.status === 'downloading') {
    items.push(['⏸ 暂停任务', () => ctx.isEx ? pauseExtractionDownload(ctx.jobId) : pauseSingleDownload(ctx.originalIndex)]);
    items.push(['🗑 取消/删除任务', () => ctx.isEx ? cancelExtractionDownload(ctx.jobId) : openDeleteTransferModal({ category: 'active', fileId: ctx.originalIndex }), true]);
  } else if (ctx.status === 'paused') {
    items.push(['▶ 恢复下载', () => ctx.isEx ? resumeExtractionDownload(ctx.jobId) : resumeSingleDownload(ctx.originalIndex)]);
    items.push(['🗑 取消/删除任务', () => ctx.isEx ? cancelExtractionDownload(ctx.jobId) : openDeleteTransferModal({ category: 'active', fileId: ctx.originalIndex }), true]);
  } else if (ctx.status === 'failed') {
    items.push(['🔄 立即重试', () => retryFailedDownload(ctx.index)]);
    items.push(['🗑 删除任务', () => openDeleteTransferModal({ category: 'failed', index: ctx.index }), true]);
  } else if (ctx.status === 'completed') {
    items.push(['🗑 删除任务', () => openDeleteTransferModal({ category: 'completed', index: ctx.index }), true]);
  }
  if (!items.length) return;
  items.forEach(([label, fn, danger]) => _ctxMenu.appendChild(_ctxMenuItem(label, fn, danger)));
  _ctxMenu.style.display = 'block';
  _ctxMenu.style.left = Math.min(x, window.innerWidth - 190) + 'px';
  _ctxMenu.style.top = Math.min(y, window.innerHeight - (_ctxMenu.offsetHeight + 8)) + 'px';
}
document.addEventListener('contextmenu', (e) => {
  const card = e.target.closest('.transfer-item');
  if (!card) return;
  const url = card.getAttribute('data-url') || '';
  const status = card.getAttribute('data-status') || '';
  const savePath = card.getAttribute('data-savepath') || '';
  if (!url && !savePath && !status) return;
  e.preventDefault();
  const isEx = card.getAttribute('data-ex') === '1';
  const ctx = { url, status, savePath, isEx };
  if (isEx) {
    ctx.jobId = card.getAttribute('data-jobid') || (card.id || '').replace(/^ex-card-/, '');
  } else if (card.id && card.id.startsWith('transfer-card-')) {
    ctx.originalIndex = parseInt(card.id.replace('transfer-card-', ''), 10);
  }
  const idxAttr = card.getAttribute('data-index');
  if (idxAttr !== null && idxAttr !== '') ctx.index = parseInt(idxAttr, 10);
  showContextMenu(e.clientX, e.clientY, ctx);
});

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
  isUpdating = true;

  const backendUrl = platform === 'win' ? updateInfoGlobal.winUrl : updateInfoGlobal.macUrl;
  let fileName = 'BioDownloader-update';
  try {
    const rawPath = new URL(backendUrl, window.location.href).pathname;
    fileName = rawPath.substring(rawPath.lastIndexOf('/') + 1) || fileName;
  } catch (e) {
    fileName = backendUrl.split('?')[0].split('#')[0].split('/').pop() || fileName;
  }
  const btnId = platform === 'win' ? 'downloadWinUpdateBtn' : 'downloadMacUpdateBtn';
  
  const btn = document.getElementById(btnId);
  const originalText = btn ? btn.innerText : '下载';

  // 根据当前版本号动态生成 GitHub Release 下载直链
  const githubUrl = platform === 'win'
    ? `https://github.com/sandy9707/bio-downloader/releases/download/v${updateInfoGlobal.latestVersion}/BioDownloader-Setup-${updateInfoGlobal.latestVersion}.exe`
    : `https://github.com/sandy9707/bio-downloader/releases/download/v${updateInfoGlobal.latestVersion}/BioDownloader-${updateInfoGlobal.latestVersion}-arm64.dmg`;

  // 检测 Clash 内置加速代理是否启动
  let clashRunning = false;
  try {
    clashRunning = await window.api.getClashStatus();
  } catch (e) {
    console.warn('getClashStatus error:', e);
  }
  let targetUrl = backendUrl;
  let usingGithub = false;

  if (clashRunning) {
    console.log('检测到加速通道已开启，优先使用 GitHub Releases 下载源:', githubUrl);
    targetUrl = githubUrl;
    usingGithub = true;
  } else {
    console.log('使用默认发布站下载源:', backendUrl);
  }

  let installerSize = 0;
  try {
    const metadata = await window.api.checkSize('links', backendUrl);
    installerSize = Number(metadata?.[0]?.size) || 0;
  } catch (err) { console.warn('更新包大小暂不可用:', err.message); }

  const updateFile = {
    name: fileName,
    url: targetUrl,
    size: installerSize, // Unknown stays unknown; never use a guessed integrity target.
    originalIndex: 9999, // Special index for update
    percentage: 0,
    status: 'waiting',
    speed: '排队中...',
    isUpdate: true
  };

  async function runInstallerDownload() {
    const result = await window.api.startDownload([updateFile], defaultDir, currentUser ? currentUser.token : '', maxConcurrentDownloadsSetting);
    for (const outcome of result?.outcomes || []) handleDownloadStatus(outcome);
    const failure = result?.outcomes?.find(item => item.status !== 'completed');
    if (failure) throw new Error(failure.speed || '安装包未完成下载');
  }

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
    await runInstallerDownload();
    
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
        await runInstallerDownload();
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
// BioProject 查询: PRJNA/PRJEB/PRJDB → Run 列表，可明确采用为 SRA 或 EBI 下载
async function queryBioProject() {
  const input = document.getElementById('bioProjectInput');
  const queryBtn = document.getElementById('bioProjectQueryBtn');
  const resultEl = document.getElementById('bioProjectResult');
  const runsInput = document.getElementById('bioProjectRunsInput');
  const project = String(input?.value || '').trim().toUpperCase();
  if (!project) {
    showToast('请输入 BioProject 编号', 'error');
    return;
  }
  if (input) input.value = project;
  if (queryBtn) queryBtn.disabled = true;
  if (resultEl) resultEl.textContent = `正在解析 ${project}...`;
  try {
    const res = await window.api.queryBioProject(project);
    window.bioProjectRuns = BioDownloadSources.applyRuns(runsInput, res.runs);
    if (runsInput) runsInput.style.display = 'block';
    if (resultEl) resultEl.textContent = `已解析 ${res.count} 个 Run。请选择采用为 SRA 或 EBI，随后可继续编辑编号并校验大小。`;
    document.getElementById('bioProjectAdoptActions').style.display = 'flex';
    showToast(`${project} 已解析 ${res.count} 个 Run`, 'success');
  } catch (e) {
    window.bioProjectRuns = [];
    if (runsInput) { runsInput.value = ''; runsInput.style.display = 'none'; }
    document.getElementById('bioProjectAdoptActions').style.display = 'none';
    if (resultEl) resultEl.textContent = '查询失败：' + e.message;
    showToast('BioProject 查询失败：' + e.message, 'error');
  } finally {
    if (queryBtn) queryBtn.disabled = false;
  }
}

async function adoptBioProjectRuns(targetType) {
  const runsInput = document.getElementById('bioProjectRunsInput');
  const runs = BioDownloadSources.normalizeList('sra_raw', runsInput?.value || '');
  if (!runs.length) {
    showToast('请先查询 BioProject', 'warning');
    return;
  }
  const target = document.getElementById('accInput-' + targetType);
  const pill = document.querySelector(`.pill-btn[data-download-type="${targetType}"]`);
  if (!target || !pill) return;
  BioDownloadSources.applyRuns(target, runs);
  switchDownloadType(pill, targetType);
  showToast(`已采用 ${runs.length} 个 Run，正在校验 ${targetType === 'ebi_raw' ? 'EBI' : 'SRA'} 文件`, 'success');
  await checkSizes();
}

// BioSample 查询: SAMN → SRA run 列表, 填入 SRA 输入框并核验大小
async function queryBioSample() {
  const biosample = prompt('请输入 BioSample 编号 (如 SAMN03174610):');
  if (!biosample || !biosample.trim()) return;
  const resultEl = document.getElementById('biosampleResult');
  if (resultEl) { resultEl.style.display = 'block'; resultEl.textContent = '正在查询 ' + biosample.trim() + ' 的 SRA run...'; }
  try {
    const res = await window.api.queryBioSample(biosample.trim());
    const sraInput = document.getElementById('accInput-sra_raw');
    if (!sraInput) return;
    // 填入输入框(追加, 保留已有编号), 用换行分隔
    const existing = sraInput.value.trim().split(/[\s\n,;]+/).filter(Boolean);
    const merged = [...new Set([...existing, ...res.runs])];
    sraInput.value = merged.join('\n');
    if (resultEl) resultEl.textContent = `✅ 已添加 ${res.count} 个 SRA run (${res.biosample})，正在核验大小...`;
    // 自动触发核验显示总大小
    await checkSizes();
    if (resultEl) resultEl.textContent = `✅ ${res.biosample} 已解析 ${res.count} 个 SRA run 并加入输入框。如需删除部分编号，可直接在输入框编辑。`;
    showToast(`已添加 ${res.count} 个 SRA run`, 'success');
  } catch (e) {
    if (resultEl) resultEl.textContent = '❌ 查询失败: ' + e.message;
    showToast('BioSample 查询失败: ' + e.message, 'error');
  }
}

async function checkSizes() {  const input = document.getElementById('accInput-' + currentDownloadType);
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return;
  if (input && window.BioDownloadSources) input.value = BioDownloadSources.normalizeList(currentDownloadType, input.value).join('\n');
  const inputVal = input?.value.trim() || '';
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

    const allFiles = await window.api.checkSize(currentDownloadType, inputVal);
    const blockedLinks = allFiles.filter((f) => f.blocked);
    currentQueue = allFiles.filter((f) => !f.blocked);
    currentQueue.forEach((file, idx) => {
      file.originalIndex = idx;
    });
    renderQueue();

    // 计算总大小并更新
    const totalBytes = currentQueue.reduce((acc, f) => acc + (f.size || 0), 0);
    const totalEl = document.getElementById('totalQueueSize');
    if (totalEl) totalEl.innerText = currentQueue.length > 0 ? '预计共 ' + formatBytes(totalBytes) : '共 0 字节';

    if (currentQueue.length > 0) {
      downloadBtn.disabled = false;
      showToast(`扫描完毕！共发现 ${currentQueue.length} 个可下载任务`, 'success');
    } else if (blockedLinks.length === 0) {
      showToast('未发现任何对应的数据文件，请核对输入', 'error');
    }
    if (blockedLinks.length) {
      showSessionLinkModal(blockedLinks.map((b) => b.url));
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

  if (currentQueue.length === 0) {
    listEl.innerHTML = `<div class="empty-state" id="emptyQueueState"><div class="empty-icon">📁</div><p>${escapeHtml(getQueueEmptyHint())}</p></div>`;
    return;
  }

  currentQueue.forEach((file, index) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'queue-item';
    itemEl.id = `queue-item-${index}`;
    
    const sizeStr = file.size > 0 ? formatBytes(file.size) : '未知大小';
    const folderStr = file.folder ? `<span style="background:var(--surface-subtle);padding:2px 6px;border-radius:4px;font-size:0.75rem;">目录: ${file.folder}</span>` : '';

    let threads = 16;
    if (file.size) {
      if (file.size < 500 * 1024) {
        threads = 1;
      } else if (file.size < 5 * 1024 * 1024) {
        threads = 4;
      } else if (file.size < 50 * 1024 * 1024) {
        threads = 8;
      } else if (file.size < 500 * 1024 * 1024) {
        threads = 16;
      } else if (file.size < 2 * 1024 * 1024 * 1024) {
        threads = 24;
      } else {
        threads = 32;
      }
    }
    if (lowPowerModeSetting) threads = Math.min(threads, 16);
    if (stableModeSetting) threads = 1;

    const threadHint = stableModeSetting ? '<span style="color:#ef4444; font-weight:bold;">稳定模式 (1线程)</span>' : `${file.engine === 'native' ? 'BioDownloader' : file.engine === 'axel' ? 'Axel' : file.engine === 'curl' ? 'curl' : 'aria2'} · 最多 ${file.engine === 'native' ? Math.min(16, threads) : file.engine === 'axel' ? threads : Math.min(16, threads)} 连接`;

    itemEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <div class="item-meta" style="flex-grow:1;">
          ${index === editingIndex
            ? `<input id="rename-input-${index}" class="rename-input" style="font-size:0.95rem;padding:2px 6px;border-radius:4px;border:1px solid var(--primary);background:rgba(255,255,255,0.1);color:inherit;width:100%;" value="${escapeHtml(file.name)}" onkeydown="if(event.key==='Enter'){commitRename(${index});}else if(event.key==='Escape'){cancelRename();}" onblur="commitRename(${index})" />`
            : `<span class="item-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>`}
          <div class="item-info">
            ${folderStr}
            <span>${sizeStr}</span>
            <span class="item-status status-pending" id="status-text-${index}">准备就绪</span>
            ${file.warning ? `<span style="color:#d97706;font-size:0.7rem;flex-basis:100%;margin-top:2px;">⚠ ${escapeHtml(file.warning)}</span>` : ''}
          </div>
        </div>
        <div style="display:flex; gap:0.5rem; flex-shrink:0; align-items:center;">
          <button class="btn btn-secondary" style="font-size:0.75rem; padding: 2px 6px;" onclick="renameFile(${index})">改名</button>
          <button class="btn btn-secondary" style="font-size:0.75rem; padding: 2px 6px;" onclick="removeFromQueue(${index})">移除</button>
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
        <span>${threadHint}</span>
      </div>
    `;
    listEl.appendChild(itemEl);
  });
}

// ==========================================
// 【加速下载调度逻辑】
// ==========================================
async function startDownload() {
  if (isDownloading) return;
  if (!currentUser) {
    showToast('请登录账户后开始下载，未登录无法连接代理加速', 'error');
    switchTab('profile-tab');
    return;
  }
  if (!defaultDir) return showToast('请先选择下载的保存目标路径', 'error');
  if (!currentQueue.length) return showToast('请先检验链接，生成下载队列', 'warning');

  // Capture before any asynchronous connection work or navigation. Keep unique
  // transfer IDs so old pause/cancel flags cannot affect a new batch.
  const dir = defaultDir, token = currentUser.token;
  const queue = currentQueue.filter(file => !activeDownloads.some(task =>
    task.url === file.url && task.name === file.name && task.targetDir === dir));
  if (!queue.length) return showToast('这些文件已在传输列表，请在那里继续或恢复下载', 'info');
  const totalBytes = queue.reduce((sum, file) => sum + (Number(file.size) || 0), 0);
  const remaining = currentUser.trafficLimit - currentUser.trafficConsumed;
  if (remaining < totalBytes) {
    showToast(`您的额度不足！剩余流量: ${formatBytes(remaining)}，所需流量: ${formatBytes(totalBytes)}，请充值后下载`, 'error');
    switchTab('store-tab');
    return;
  }

  isDownloading = true;
  const batch = [];
  let startupError = null, batchCancelled = false;
  const errorBox = document.getElementById('transferBatchError');
  if (errorBox) { errorBox.hidden = true; errorBox.textContent = ''; }
  try {
    document.getElementById('checkSizeBtn').disabled = true;
    document.getElementById('downloadBtn').disabled = true;
    if (!(await ensureTransferConnection())) return;
    for (const file of queue) {
      file.originalIndex = allocateTransferId();
      const task = { ...file, targetDir: dir, percentage: 0, status: 'waiting', speed: '排队中...' };
      batch.push(task);
    }
    activeDownloads.push(...batch);
    renderDownloadingList(); updateTransferCounts();
    document.getElementById('downloadBtn').style.display = 'none';
    document.getElementById('cancelBtn').style.display = 'block';
    switchTab('transfers-tab'); switchTransferSubTab('downloading');
    showToast(`已加入 ${batch.length} 个任务，正在启动下载...`, 'info');
    const result = await window.api.startDownload(batch, dir, token, maxConcurrentDownloadsSetting);
    batchCancelled = Boolean(result?.cancelled);
    // Electron's invoke reply can arrive before queued status notifications.
    // Reconcile authoritative outcomes first; the handler is idempotent.
    for (const outcome of result?.outcomes || []) handleDownloadStatus(outcome);
    if (result && result.success === false) throw new Error(result.error || '批量任务未能启动');
    const ids = new Set(batch.map(file => file.originalIndex));
    const completed = completedDownloads.filter(item => ids.has(item.fileObj?.originalIndex));
    const failed = failedDownloads.filter(item => ids.has(item.originalIndex));
    const warnings = completed.filter(item => ['unavailable', 'mismatch'].includes(item.verification?.status)).length;
    if (!result?.cancelled) showToast(`本批下载结束：完成 ${completed.length} · 失败 ${failed.length}${warnings ? ' · MD5 待核对 ' + warnings : ''}`, failed.length || warnings ? 'warning' : 'info');
  } catch (error) {
    startupError = error;
    const message = '批量下载未能启动，任务已保留，可点击恢复重试：' + error.message;
    if (errorBox) { errorBox.textContent = message; errorBox.hidden = false; }
    showToast(message, 'error');
  } finally {
    // Do not discard waiting tasks or overwrite a startup error with success.
    for (const task of batch) {
      if (activeDownloads.includes(task) && task.status === 'waiting') {
        if (batchCancelled) { activeDownloads = activeDownloads.filter(item => item !== task); continue; }
        task.status = 'paused'; task.speed = '';
        if (startupError) task.startupError = startupError.message;
      }
    }
    isDownloading = false;
    renderDownloadingList(); updateTransferCounts();
    document.getElementById('checkSizeBtn').disabled = false;
    document.getElementById('downloadBtn').style.display = 'block';
    document.getElementById('cancelBtn').style.display = 'none';
    document.getElementById('downloadBtn').disabled = !currentQueue.length;
    try { await refreshUserInfo(); } catch (_) {}
  }
}

async function cancelDownload() {
  showToast('正在发送全局取消下载信号...');
  window.api.cancelAllDownloadsSignal();
}

// ==========================================
// 【用户认证交互逻辑】
// ==========================================
// 登录/注册表单回车提交(可访问性):按当前所处的认证 Tab 调用对应提交
function submitAuthForm() {
  if (activeAuthTab === 'register') { handleRegister(); } else { handleLogin(); }
}

// 通用信息弹窗
function showInfoModal(title, html) {
  const t = document.getElementById('infoModalTitle');
  const b = document.getElementById('infoModalBody');
  if (t) t.innerText = title;
  if (b) b.innerHTML = html;
  const m = document.getElementById('infoModal');
  if (m) m.style.display = 'flex';
}
function closeInfoModal() {
  const m = document.getElementById('infoModal');
  if (m) m.style.display = 'none';
}
// NCBI 会话型动态导出链接无法直接下载:弹窗说明原因 + Copy as cURL / accession 方法
function showSessionLinkModal(urls) {
  const list = (urls || []).map((u) => `<li style="margin:3px 0;word-break:break-all;"><code style="font-size:0.72rem;">${escapeHtml(u)}</code></li>`).join('');
  const html = `
    <p>以下链接是 <b>NCBI 动态导出链接</b>(<code>sviewer/viewer.cgi?...&query_key=...</code>),它们依赖您当前浏览器中的检索会话(Cookie)。本下载器没有该会话、也无法在本地转换,因此<b>无法直接下载</b>(服务器通常返回 400),故未加入下载队列。</p>
    <ul style="margin:0.4rem 0 0.4rem 1.2rem;">${list}</ul>
    <p style="margin-top:0.6rem;"><b>解决方法:</b></p>
    <ol style="margin:0 0 0 1.2rem; line-height:1.7;">
      <li><b>推荐(长期可用)</b>:在 NCBI 页面导出 Accession 编号(如 <code>NM_007482.3</code>),粘贴到本下载器下载;或用 EFetch 接口 <code>efetch.fcgi?db=nuccore&id=编号&rettype=gb&retmode=text</code>。</li>
      <li><b>临时(仅本次文件)</b>:浏览器按 <b>F12</b> → <b>Network</b> → 重新触发一次下载 → 找到 <code>viewer.cgi</code> 请求 → 右键 <b>Copy as cURL</b> → 粘贴到终端(命令行)运行,即可带上 Cookie 下载。</li>
    </ol>
    <p style="margin-top:0.5rem; color:var(--text-muted); font-size:0.78rem;">提示:方法二依赖会话有效期,不适合长期或批量任务。</p>
  `;
  showInfoModal('该链接无法直接下载', html);
}

// ---------- 粘贴 cURL 下载 ----------
let curlParsed = null;
let curlSaveDir = '';

function openCurlModal() {
  curlParsed = null;
  const ta = document.getElementById('curlInput'); if (ta) ta.value = '';
  const pv = document.getElementById('curlPreview'); if (pv) { pv.style.display = 'none'; pv.innerHTML = ''; }
  const st = document.getElementById('curlStatus'); if (st) { st.innerText = ''; st.style.color = 'var(--text-muted)'; }
  const pw = document.getElementById('curlProgressWrap'); if (pw) pw.style.display = 'none';
  const bar = document.getElementById('curlProgressBar'); if (bar) bar.style.width = '0%';
  const startBtn = document.getElementById('curlStartBtn'); if (startBtn) { startBtn.style.display = 'none'; startBtn.disabled = false; }
  const parseBtn = document.getElementById('curlParseBtn'); if (parseBtn) { parseBtn.style.display = ''; parseBtn.disabled = false; }
  curlSaveDir = defaultDir || '';
  const sd = document.getElementById('curlSaveDir'); if (sd) sd.value = curlSaveDir || '(未选择保存目录)';
  const m = document.getElementById('curlModal'); if (m) m.style.display = 'flex';
}
function closeCurlModal() {
  const m = document.getElementById('curlModal'); if (m) m.style.display = 'none';
}
async function chooseCurlSaveDir() {
  const dir = await window.api.selectDirectory();
  if (dir) { curlSaveDir = dir; const sd = document.getElementById('curlSaveDir'); if (sd) sd.value = dir; }
}
async function parseCurlInput() {
  const ta = document.getElementById('curlInput');
  const text = (ta && ta.value || '').trim();
  if (!text) { showToast('请先粘贴 cURL 命令', 'warning'); return; }
  const parseBtn = document.getElementById('curlParseBtn'); if (parseBtn) parseBtn.disabled = true;
  const res = await window.api.parseCurl(text);
  if (parseBtn) parseBtn.disabled = false;
  if (!res || !res.success) { showToast('解析失败: ' + (res && res.error || '格式不正确'), 'error'); return; }
  curlParsed = res.parsed;
  const pv = document.getElementById('curlPreview');
  if (pv) {
    pv.style.display = 'block';
    pv.innerHTML = `<b>${escapeHtml(res.preview.method)}</b> ${escapeHtml(res.preview.url)}<br>`
      + `请求头 ${res.preview.headerCount} 个 · Cookie ${res.preview.hasCookie ? '✅ 已包含(带会话)' : '❌ 无(可能下载失败)'}`
      + (res.preview.hasData ? ' · 含请求体' : '');
  }
  const startBtn = document.getElementById('curlStartBtn'); if (startBtn) startBtn.style.display = '';
}
async function startCurlDownload() {
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return;
  if (!curlParsed) { showToast('请先解析 cURL', 'warning'); return; }
  if (!curlSaveDir) { showToast('请选择保存目录', 'warning'); return; }
  const startBtn = document.getElementById('curlStartBtn'); if (startBtn) startBtn.disabled = true;
  const parseBtn = document.getElementById('curlParseBtn'); if (parseBtn) parseBtn.disabled = true;
  const pw = document.getElementById('curlProgressWrap'); if (pw) pw.style.display = 'block';
  const bar = document.getElementById('curlProgressBar'); if (bar) bar.style.width = '0%';
  const st = document.getElementById('curlStatus'); if (st) { st.innerText = '正在连接…'; st.style.color = 'var(--text-muted)'; }

  window.api.onCurlProgress((d) => {
    if (d.status === 'progress') {
      if (bar) bar.style.width = (d.percentage != null ? d.percentage : 0) + '%';
      if (st) st.innerText = (d.speed || '');
    } else if (d.status === 'completed') {
      if (bar) bar.style.width = '100%';
      const safePath = (d.savePath || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
      if (st) { st.style.color = d.warn ? '#d97706' : '#10b981'; st.innerHTML = `✅ 下载完成: ${escapeHtml(d.name || '')}　<a href="#" onclick="window.api.openDownloadsFolder('${safePath}');return false;" style="color:var(--primary-color);">在文件夹中显示</a>${d.warn ? '<br><span style="color:#d97706;">' + escapeHtml(d.warn) + '</span>' : ''}`; }
      if (parseBtn) parseBtn.disabled = false;
      showToast('cURL 下载完成', 'success');
    } else if (d.status === 'failed') {
      if (st) { st.style.color = '#ef4444'; st.innerText = '❌ ' + (d.message || '下载失败'); }
      if (startBtn) startBtn.disabled = false;
      if (parseBtn) parseBtn.disabled = false;
      showToast('cURL 下载失败: ' + (d.message || ''), 'error');
    }
  });

  try {
    await window.api.downloadCurl({ parsed: curlParsed, saveDir: curlSaveDir });
  } catch (e) {
    if (st) { st.style.color = '#ef4444'; st.innerText = '❌ ' + e.message; }
    if (startBtn) startBtn.disabled = false;
    if (parseBtn) parseBtn.disabled = false;
  }
}

async function handleLogin() {
  const user = document.getElementById('authUsername').value.trim();
  const pass = document.getElementById('authPassword').value.trim();

  if (!user || !pass) {
    showToast('账号和密码不能为空', 'error');
    return;
  }

  try {
    const res = await window.api.login(user, pass);
    if (res && res.success) {
      showToast('账户登录成功', 'success');
      await window.api.saveSettings({ token: res.token });
      await verifyToken(res.token);
    } else {
      showToast('登录失败: ' + ((res && res.error) || '用户名或密码错误'), 'error');
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
    if (res && res.success) {
      showToast('账户秒速注册成功', 'success');
      await window.api.saveSettings({ token: res.token });
      await verifyToken(res.token);
    } else {
      showToast('注册失败: ' + ((res && res.error) || '未知错误'), 'error');
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

      // 更新限时流量 / 永久流量 / 设备上限
      const limitedTrafficEl = document.getElementById('profLimitedTraffic');
      if (limitedTrafficEl) {
        const limitedRemain = Math.max(0, (res.limitedTrafficLimit || 0) - (res.limitedTrafficConsumed || 0));
        limitedTrafficEl.innerText = `${formatBytes(limitedRemain)} / ${formatBytes(res.limitedTrafficLimit || 0)}`;
      }
      const permTrafficEl = document.getElementById('profPermanentTraffic');
      if (permTrafficEl) {
        const permRemain = Math.max(0, (res.permanentTrafficLimit || 0) - (res.permanentTrafficConsumed || 0));
        permTrafficEl.innerText = `${formatBytes(permRemain)} / ${formatBytes(res.permanentTrafficLimit || 0)}`;
      }
      const maxDevicesEl = document.getElementById('profMaxDevices');
      if (maxDevicesEl) maxDevicesEl.innerText = res.maxDevices || 2;

      // 更新钱包余额 (账号可用余额)
      const walletBalanceEl = document.getElementById('profWalletBalance');
      if (walletBalanceEl) walletBalanceEl.innerText = (res.balance || 0).toFixed(2);

      // 刷新签到按钮状态
      updateCheckinButton();
      
      // 上报当前设备（供后台设备管理）——使用稳定设备ID，避免每次登录膨胀设备列表
      try {
        let devId = localStorage.getItem('bd_device_id');
        if (!devId) {
          devId = `desktop-${(navigator.platform || 'unknown').replace(/\s+/g, '')}-${Date.now().toString(36)}`;
          localStorage.setItem('bd_device_id', devId);
        }
        await window.api.reportDevice(res.token, devId, '桌面客户端');
      } catch (e) {}
      
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
        await window.campusNotice?.ready;
        if (!isClashRunning && !window.campusNotice?.requiresAcknowledgment()) {
          await window.api.startClash(token);
          updateClashUIState();
        }
      } catch (clashErr) {
        console.error('自动开启加速器失败:', clashErr.message);
        showToast('加速器自动开启失败，请手动尝试', 'error');
      }
    }
  } catch (e) {
    console.error('Token验证处理过程出现警报/失败:', e);
    const isUnauthenticated = e.response && e.response.status === 401;
    if (isAutoLogin || isUnauthenticated) {
      console.warn('Token 无效或已失效，重置本地状态');
      await window.api.saveSettings({ token: null });
      if (!isAutoLogin) {
        await handleLogout();
      }
    } else {
      console.warn('非致命通信/渲染网络异常，保留当前登录态');
    }
  }
}

async function refreshUserInfo() {
  if (currentUser) {
    await verifyToken(currentUser.token);
  }
}

async function handleClientRedeem() {
  const input = document.getElementById('clientRedeemCode');
  const code = (input ? input.value : '').trim();
  if (!code) { showToast('请输入兑换码', 'error'); return; }
  if (!currentUser || !currentUser.token) { showToast('请先登录账户', 'error'); return; }
  try {
    const res = await window.api.redeemCode(currentUser.token, code);
    if (res && res.success) {
      showToast(res.message || '兑换成功', 'success');
      if (input) input.value = '';
      await verifyToken(currentUser.token); // 刷新账户信息
    } else {
      showToast((res && res.error) || '兑换失败', 'error');
    }
  } catch (e) {
    showToast('兑换请求失败: ' + e.message, 'error');
  }
}

function updateTrafficProgressBar(consumed, limit) {
  const textEl = document.getElementById('headerTrafficText');
  const fillEl = document.getElementById('headerTrafficFill') || document.getElementById('headerTrafficProgress');

  const isUnlimited = limit >= 100 * 1024 * 1024 * 1024 * 1024 * 0.9; // > 90TB 认为无限
  if (isUnlimited) {
    if (textEl) textEl.innerText = '无限流量 ⭐';
    if (fillEl) {
      fillEl.style.width = '100%';
      fillEl.style.background = 'var(--success-grad)';
    }
    return;
  }
  const ratio = limit > 0 ? (consumed / limit) * 100 : 0;
  const remainText = formatBytes(limit - consumed);
  const totalText = formatBytes(limit);
  
  if (textEl) textEl.innerText = `${remainText} / ${totalText}`;
  if (fillEl) fillEl.style.width = Math.min(100, Math.max(0, 100 - ratio)) + '%';
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

  // 重置加速器 UI(currentUser 已置空,updateClashUIState 会短路返回,需手动复位,否则边栏残留"已开启"绿态)
  const clashDot = document.getElementById('clashDot');
  const clashText = document.getElementById('clashStatusText');
  const clashToggle = document.getElementById('clashToggle');
  const clashInfo = document.getElementById('clashConfigInfo');
  if (clashDot) clashDot.className = 'dot';
  if (clashText) clashText.innerText = '加速器已关闭';
  if (clashToggle) clashToggle.checked = false;
  if (clashInfo) clashInfo.innerText = '尚未启动下载加速器。启动下载时会自动开启。';

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
      const permContainer = document.getElementById('packageListPerm');

      res.packages.forEach(pkg => {
        const card = document.createElement('div');
        card.className = 'package-card';
        
        const trafficStr = formatBytes(pkg.trafficBytes);
        const priceHtml = pkg.originalPrice
          ? `<span style="text-decoration: line-through; font-size: 0.9rem; color: var(--text-muted); margin-right: 0.5rem; font-weight: normal;">¥ ${pkg.originalPrice.toFixed(2)}</span>¥ ${pkg.price.toFixed(2)}`
          : `¥ ${pkg.price.toFixed(2)}`;
        const perm = !!pkg.permanent;
        const subtitle = perm
          ? '永久流量 · 永不过期'
          : `有效期: ${pkg.days} 天 | 设备上限 ${pkg.maxDevices || 2} 台`;
        
        card.innerHTML = `
          <h4 style="font-weight:bold;">${pkg.name}</h4>
          <div style="font-size:0.85rem;color:var(--text-muted);">${subtitle}</div>
          <div class="package-price">${priceHtml}</div>
          <div style="font-size:1.1rem;font-weight:bold;color:#10b981;margin-bottom:0.5rem;">${perm ? '永久' : '高速'}流量: ${trafficStr}</div>
          <div style="display:flex; align-items:center; justify-content:space-between; gap:0.5rem; margin-top:0.5rem; margin-bottom:0.75rem; background:rgba(255,255,255,0.03); padding:0.4rem 0.6rem; border-radius:6px; border:1px solid var(--border-color);">
            <span style="font-size:0.85rem; color:var(--text-muted);">选择购买数量:</span>
            <input type="number" id="qty-${pkg.id}" value="1" min="1" max="99" style="width:60px; background:var(--bg-input); color:var(--text-color); border:1px solid var(--border-color); border-radius:4px; padding:0.2rem; text-align:center; outline:none; font-weight:bold;">
          </div>
          <div style="margin-top:0.5rem; display:flex; gap:0.5rem;">
            <button class="btn btn-primary" style="flex:1; padding:0.5rem; font-size:0.85rem;" onclick="buyPackage('${pkg.id}', 'alipay')">支付宝</button>
            <button class="btn btn-success" style="flex:1; padding:0.5rem; font-size:0.85rem; background:#10b981;" onclick="buyPackage('${pkg.id}', 'balance')">余额支付</button>
          </div>
        `;
        if (perm && permContainer) {
          permContainer.appendChild(card);
        } else if (container) {
          container.appendChild(card);
        }
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
      startPayArrivalPoll();
    }
  } catch (err) {
    showToast('创建订单失败: ' + err.message, 'error');
  }
}

function closePayModal() {
  document.getElementById('payModal').style.display = 'none';
  stopPayArrivalPoll();
  // 确认完毕后更新一次数据
  refreshUserInfo();
}

// 支付到账核对:打开支付框后每 5 秒刷新一次额度,检测到到账即提示;亦可手动点"我已付款,刷新到账状态"
let payPollTimer = null;
let payBaselineLimit = 0;
function startPayArrivalPoll() {
  payBaselineLimit = currentUser ? (currentUser.trafficLimit || 0) : 0;
  stopPayArrivalPoll();
  payPollTimer = setInterval(async () => {
    await refreshUserInfo();
    if (currentUser && (currentUser.trafficLimit || 0) > payBaselineLimit) {
      stopPayArrivalPoll();
      showToast('已检测到流量到账!', 'success');
    }
  }, 5000);
}
function stopPayArrivalPoll() {
  if (payPollTimer) { clearInterval(payPollTimer); payPollTimer = null; }
}
async function checkPayArrival() {
  showToast('正在刷新到账状态...');
  await refreshUserInfo();
  if (currentUser && (currentUser.trafficLimit || 0) > payBaselineLimit) {
    stopPayArrivalPoll();
    showToast('已检测到流量到账!', 'success');
  } else {
    showToast('暂未检测到到账,若已付款请稍候再点刷新', 'warning');
  }
}

// ==========================================
// 【每日签到 / 余额充值 / 订单历史 / 设备管理 / 重置Token】
// ==========================================
let checkinToday = false;

function updateCheckinButton() {
  const today = new Date().toISOString().slice(0, 10);
  const signed = localStorage.getItem('bd_checkin_' + today);
  checkinToday = !!signed;
  const setBtn = (id, signedText, unsigText) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    if (signed) {
      btn.innerText = signedText;
      btn.disabled = true;
      btn.style.opacity = '0.6';
    } else {
      btn.innerText = unsigText;
      btn.disabled = false;
      btn.style.opacity = '1';
    }
  };
  setBtn('btnDailyCheckin', '📅 明日再来', '📅 每日签到');
  setBtn('btnHeaderCheckin', '📅 明日再来', '📅 签到');
}

async function handleCheckin() {
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户后再签到', 'error');
    switchTab('profile-tab');
    return;
  }
  if (checkinToday) {
    showToast('今日已签到，明日再来吧', 'info');
    return;
  }
  try {
    const res = await window.api.checkin(currentUser.token);
    if (res && res.success) {
      localStorage.setItem('bd_checkin_' + new Date().toISOString().slice(0, 10), String(res.rewardBytes || 0));
      checkinToday = true;
      updateCheckinButton();
      const rewardEl = document.getElementById('checkinReward');
      if (rewardEl) rewardEl.innerText = '+' + formatBytes(res.rewardBytes || 0);
      document.getElementById('checkinModal').style.display = 'flex';
      refreshUserInfo();
    } else {
      showToast((res && res.error) || '签到失败，请稍后再试', 'error');
    }
  } catch (e) {
    showToast('签到失败: ' + e.message, 'error');
  }
}

function closeCheckinModal() {
  document.getElementById('checkinModal').style.display = 'none';
}

let selectedRechargeAmount = null;

function selectRecharge(amount, el) {
  selectedRechargeAmount = amount;
  document.querySelectorAll('#rechargeModal .recharge-opt').forEach(o => o.classList.remove('selected'));
  if (el) el.classList.add('selected');
}

function openRechargeModal() {
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户', 'error');
    switchTab('profile-tab');
    return;
  }
  document.getElementById('rechargeModal').style.display = 'flex';
}

function closeRechargeModal() {
  document.getElementById('rechargeModal').style.display = 'none';
  selectedRechargeAmount = null;
  document.querySelectorAll('#rechargeModal .recharge-opt').forEach(o => o.classList.remove('selected'));
  document.getElementById('customRechargeInput').value = '';
}

async function doRecharge() {
  if (!currentUser || !currentUser.token) return;
  let amount = selectedRechargeAmount;
  const custom = parseFloat(document.getElementById('customRechargeInput').value);
  if (custom && custom >= 1) amount = custom;
  if (!amount || amount < 1) return showToast('请选择或输入充值金额', 'error');
  if (amount > 1000) return showToast('单次充值最高 ¥1000', 'error');
  try {
    showToast('正在创建充值订单...');
    const res = await window.api.balanceRecharge(currentUser.token, amount);
    if (res && res.checkoutUrl) {
      document.getElementById('checkoutLink').href = res.checkoutUrl;
      document.getElementById('payModal').style.display = 'flex';
      document.getElementById('modalTitle').innerText = `余额充值 ¥${Number(amount).toFixed(2)}`;
      closeRechargeModal();
      startRechargeArrivalPoll();
    } else {
      showToast((res && res.error) || '下单异常', 'error');
    }
  } catch (e) {
    showToast('充值下单失败: ' + e.message, 'error');
  }
}

let rechargePollTimer = null;
let rechargeBaselineBalance = 0;
function startRechargeArrivalPoll() {
  rechargeBaselineBalance = currentUser ? (Number(currentUser.balance) || 0) : 0;
  stopRechargeArrivalPoll();
  rechargePollTimer = setInterval(async () => {
    await refreshUserInfo();
    if (currentUser && (Number(currentUser.balance) || 0) > rechargeBaselineBalance) {
      stopRechargeArrivalPoll();
      closePayModal();
      showToast('余额已到账！', 'success');
    }
  }, 5000);
}
function stopRechargeArrivalPoll() {
  if (rechargePollTimer) { clearInterval(rechargePollTimer); rechargePollTimer = null; }
}

// ---- 订单历史 ----
let ordersFilter = 'all';
let allOrdersCache = [];

function openOrdersModal() {
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户', 'error');
    switchTab('profile-tab');
    return;
  }
  document.getElementById('ordersModal').style.display = 'flex';
  loadOrders();
}

function closeOrdersModal() {
  document.getElementById('ordersModal').style.display = 'none';
}

function switchOrdersFilter(filter, el) {
  ordersFilter = filter;
  const btnMap = { all: 'ordTabAll', pending: 'ordTabPending', paid: 'ordTabPaid' };
  Object.keys(btnMap).forEach(k => {
    const b = document.getElementById(btnMap[k]);
    if (!b) return;
    if (k === filter) {
      b.className = 'btn btn-primary btn-sm';
    } else {
      b.className = 'btn btn-secondary btn-sm';
    }
  });
  renderOrdersList();
}

async function loadOrders() {
  const body = document.getElementById('ordersListBody');
  if (!body) return;
  body.innerHTML = '加载中...';
  try {
    const res = await window.api.getOrders(currentUser.token);
    allOrdersCache = (res && res.orders) || [];
    renderOrdersList();
  } catch (e) {
    body.innerHTML = '<p style="color:var(--text-muted);">订单加载失败</p>';
  }
}

function renderOrdersList() {
  const body = document.getElementById('ordersListBody');
  if (!body) return;
  let orders = allOrdersCache;
  if (ordersFilter === 'pending') orders = orders.filter(o => o.status === 'pending');
  if (ordersFilter === 'paid') orders = orders.filter(o => o.status === 'paid');
  if (!orders.length) {
    body.innerHTML = '<p style="color:var(--text-muted);">暂无订单。</p>';
    return;
  }
  body.innerHTML = orders.map(o => `
    <div class="order-row">
      <div style="flex:1; min-width:0;">
        <div style="font-weight:600;">${escapeHtml(o.name || '订单')}</div>
        <div style="font-size:0.75rem; color:var(--text-muted);">${new Date(o.createdAt).toLocaleString()} · ${o.orderType === 'balance_recharge' ? '余额充值' : (o.permanent ? '永久流量' : '套餐')} · ${o.payType === 'balance' ? '余额支付' : '支付宝'}</div>
      </div>
      <div style="text-align:right; flex-shrink:0;">
        <div style="font-weight:700;">¥${(o.amount || 0).toFixed(2)}</div>
        <div style="font-size:0.75rem; color:${o.status === 'paid' ? '#10b981' : '#f59e0b'};">${o.status === 'paid' ? '✓ 已支付' : '待支付'}</div>
        ${o.status === 'pending' && o.checkoutUrl ? `<button class="btn btn-primary btn-sm" style="margin-top:4px;" onclick="reopenOrderPayment('${o.checkoutUrl}')">去支付</button>` : ''}
      </div>
    </div>`).join('');
}

async function reopenOrderPayment(checkoutUrl) {
  if (!checkoutUrl) return;
  document.getElementById('checkoutLink').href = checkoutUrl;
  document.getElementById('payModal').style.display = 'flex';
  document.getElementById('modalTitle').innerText = '继续支付';
  closeOrdersModal();
  startPayArrivalPoll();
}

// ---- 设备管理 ----
function openDevicesModal() {
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户', 'error');
    switchTab('profile-tab');
    return;
  }
  document.getElementById('devicesModal').style.display = 'flex';
  loadDevices();
}

function closeDevicesModal() {
  document.getElementById('devicesModal').style.display = 'none';
}

async function loadDevices() {
  const body = document.getElementById('devicesListBody');
  if (!body) return;
  body.innerHTML = '加载中...';
  try {
    const res = await window.api.getDevices(currentUser.token);
    const devices = (res && res.devices) || [];
    const max = (res && res.maxDevices) || 2;
    document.getElementById('devCountText').textContent = devices.length;
    document.getElementById('devMaxText').textContent = max;
    if (!devices.length) {
      body.innerHTML = '<p style="color:var(--text-muted);">暂无在线设备。当前设备将在下次启动后自动上报。</p>';
    } else {
      body.innerHTML = devices.map(d => `
        <div class="device-row-item">
          <div>
            <div style="font-weight:600;">${escapeHtml(d.deviceName || '未知设备')}</div>
            <div style="font-size:0.75rem; color:var(--text-muted);">最后在线：${new Date(d.lastSeen).toLocaleString()}</div>
          </div>
        </div>`).join('');
    }
  } catch (e) {
    body.innerHTML = '<p style="color:var(--text-muted);">设备列表加载失败</p>';
  }
  loadLoginLog();
}

// 加载登录记录(网页/客户端登录, 不计入设备数)
async function loadLoginLog() {
  const body = document.getElementById('loginLogListBody');
  if (!body || !currentUser || !currentUser.token) return;
  body.innerHTML = '加载中...';
  try {
    const res = await window.api.getLoginLog(currentUser.token);
    const records = (res && res.records) || [];
    if (!records.length) {
      body.innerHTML = '<p style="color:var(--text-muted);">暂无登录记录。</p>';
      return;
    }
    body.innerHTML = records.map(r => `
      <div class="device-row-item">
        <div style="flex:1; min-width:0;">
          <div style="font-weight:600;">${escapeHtml(r.source || '未知')}</div>
          <div style="font-size:0.75rem; color:var(--text-muted);">${new Date(r.time).toLocaleString()}${r.ip ? ' · ' + escapeHtml(r.ip) : ''}</div>
        </div>
      </div>`).join('');
  } catch (e) {
    body.innerHTML = '<p style="color:var(--text-muted);">登录记录加载失败</p>';
  }
}

// ---- 重置 Token ----
async function handleResetToken() {
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户', 'error');
    switchTab('profile-tab');
    return;
  }
  if (!confirm('确定要重置 Token 吗？\n重置后旧 Token 将立即失效，所有已登录设备需要重新登录。')) return;
  try {
    showToast('正在重置 Token...');
    const res = await window.api.resetToken(currentUser.token);
    if (res && res.success) {
      await window.api.saveSettings({ token: res.token });
      await verifyToken(res.token);
      showToast('Token 已重置，请在其他设备重新登录', 'success');
    } else {
      showToast((res && res.error) || '重置失败', 'error');
    }
  } catch (e) {
    showToast('重置 Token 失败: ' + e.message, 'error');
  }
}

window.handleCheckin = handleCheckin;
window.closeCheckinModal = closeCheckinModal;
window.openRechargeModal = openRechargeModal;
window.closeRechargeModal = closeRechargeModal;
window.selectRecharge = selectRecharge;
window.doRecharge = doRecharge;
window.openOrdersModal = openOrdersModal;
window.closeOrdersModal = closeOrdersModal;
window.switchOrdersFilter = switchOrdersFilter;
window.reopenOrderPayment = reopenOrderPayment;
window.openDevicesModal = openDevicesModal;
window.closeDevicesModal = closeDevicesModal;
window.handleResetToken = handleResetToken;

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

// 队列文件重命名(行内编辑,替代在 Electron 中不可靠的 window.prompt)
function renameFile(index) {
  if (!currentQueue[index]) return;
  editingIndex = index;
  renderQueue();
  const input = document.getElementById(`rename-input-${index}`);
  if (input) {
    input.focus();
    // 默认选中不含扩展名的主名部分,方便直接改写
    const dot = input.value.lastIndexOf('.');
    input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
  }
}

// 确认改名
function commitRename(index) {
  if (editingIndex !== index) return; // 防止 blur 与 Enter/Escape 重复触发
  const input = document.getElementById(`rename-input-${index}`);
  const file = currentQueue[index];
  if (input && file) {
    const newName = input.value.trim().replace(/[\\/:*?"<>|]/g, '_'); // 清洗非法字符
    if (newName) file.name = newName;
  }
  editingIndex = -1;
  renderQueue();
}

// 取消改名
function cancelRename() {
  editingIndex = -1;
  renderQueue();
}

// 从队列移除单项
function removeFromQueue(index) {
  if (index < 0 || index >= currentQueue.length) return;
  const removed = currentQueue.splice(index, 1)[0];
  // 同步总大小
  const totalBytes = currentQueue.reduce((acc, f) => acc + (f.size || 0), 0);
  const totalEl = document.getElementById('totalQueueSize');
  if (totalEl) totalEl.innerText = currentQueue.length > 0 ? '预计共 ' + formatBytes(totalBytes) : '共 0 字节';
  renderQueue();
  if (removed) showToast(`已从队列移除: ${removed.name}`, 'info');
}

// 单个文件独立加速下载
async function downloadSingle(index) {
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return;
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
  file.originalIndex = allocateTransferId();
  const fileId = file.originalIndex;
  file.targetDir = defaultDir;
  file.percentage = 0;
  file.status = 'waiting';
  file.speed = '排队中...';

  // 加入正在下载列表
  if (!activeDownloads.find(d => d.originalIndex === fileId)) {
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
    const result = await window.api.startDownload([file], defaultDir, currentUser.token, maxConcurrentDownloadsSetting);
    for (const outcome of result?.outcomes || []) handleDownloadStatus(outcome);
    showToast(`文件 ${file.name} 下载任务运行完毕！`, 'info');
  } catch (e) {
    file.status = 'paused'; file.startupError = e.message;
    showToast('启动失败，任务已保留：' + e.message, 'error');
  } finally {
    if (singleBtn) singleBtn.disabled = false;
    document.getElementById('checkSizeBtn').disabled = false;
    document.getElementById('downloadBtn').disabled = false;
    
    // 刷新(已暂停的任务须保留卡片与断点,等待用户恢复,不能移除)
    const still = activeDownloads.find(d => d.originalIndex === fileId);
    if (!still || still.status !== 'paused') {
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== fileId);
    }
    renderDownloadingList();
    updateTransferCounts();
    await refreshUserInfo();
  }
}

// ==========================================
// 【传输列表与排队管理控制器】
// ==========================================
function getTransferCurrentPage(tab) {
  return transferPages[tab || currentTransferSubTab] || 1;
}

function setTransferCurrentPage(tab, page) {
  transferPages[tab] = Math.max(1, page);
}

function updateTransferPaginationUI(totalItems) {
  const paginationEl = document.getElementById('transferPagination');
  if (!paginationEl) return;
  const totalPages = Math.max(1, Math.ceil(totalItems / TRANSFER_PAGE_SIZE));
  const currentPage = Math.min(getTransferCurrentPage(currentTransferSubTab), totalPages);
  transferPages[currentTransferSubTab] = currentPage;

  if (totalItems <= TRANSFER_PAGE_SIZE) {
    paginationEl.style.display = 'none';
    const top = document.getElementById('transferPaginationTop');
    if (top) top.style.display = 'none';
    return;
  }
  paginationEl.style.display = 'flex';

  const infoEl = document.getElementById('transferPageInfo');
  if (infoEl) {
    const start = (currentPage - 1) * TRANSFER_PAGE_SIZE + 1;
    const end = Math.min(currentPage * TRANSFER_PAGE_SIZE, totalItems);
    infoEl.innerText = `第 ${currentPage} / ${totalPages} 页 · 显示第 ${start}-${end} 项 (共 ${totalItems} 项)`;
  }

  const btnFirst = document.getElementById('tpBtnFirst');
  const btnPrev = document.getElementById('tpBtnPrev');
  const btnNext = document.getElementById('tpBtnNext');
  const btnLast = document.getElementById('tpBtnLast');

  if (btnFirst) btnFirst.disabled = (currentPage <= 1);
  if (btnPrev) btnPrev.disabled = (currentPage <= 1);
  if (btnNext) btnNext.disabled = (currentPage >= totalPages);
  if (btnLast) btnLast.disabled = (currentPage >= totalPages);
  // Mirror controls without duplicating element IDs. Both bars share page state.
  let top = document.getElementById('transferPaginationTop');
  if (!top) {
    top = document.createElement('div');
    top.id = 'transferPaginationTop';
    top.className = 'transfer-pagination';
    const list = document.getElementById('transferDownloadingList');
    if (list) list.before(top);
  }
  const existingJump = paginationEl.querySelector('[data-page-jump]');
  if (existingJump) existingJump.remove();
  const markup = paginationEl.innerHTML.replace(/\s+id="[^"]+"/g, '');
  const jump = `<label>跳至 <input type="number" min="1" max="${totalPages}" value="${currentPage}" aria-label="跳转页码" style="width:5rem" onchange="changeTransferPage(Number(this.value))"> 页</label>`;
  top.innerHTML = markup + jump;
  top.style.display = 'flex';
  let bottomJump = paginationEl.querySelector('[data-page-jump]');
  if (!bottomJump) {
    bottomJump = document.createElement('span');
    bottomJump.dataset.pageJump = 'true';
    paginationEl.appendChild(bottomJump);
  }
  bottomJump.innerHTML = jump;
}

function changeTransferPage(action) {
  const currentTab = currentTransferSubTab;
  let itemsCount = 0;
  if (currentTab === 'downloading') {
    itemsCount = activeDownloads.filter((f) => matchesTransferSearch(f.name)).length + Object.keys(extractionJobs).length;
  } else if (currentTab === 'completed') {
    itemsCount = completedDownloads.filter((f) => matchesTransferSearch(f.name)).length;
  } else if (currentTab === 'failed') {
    itemsCount = failedDownloads.filter((f) => matchesTransferSearch(f.name)).length;
  }
  const totalPages = Math.max(1, Math.ceil(itemsCount / TRANSFER_PAGE_SIZE));
  let cur = getTransferCurrentPage(currentTab);

  if (action === 'first') cur = 1;
  else if (action === 'prev') cur = Math.max(1, cur - 1);
  else if (action === 'next') cur = Math.min(totalPages, cur + 1);
  else if (action === 'last') cur = totalPages;
  else if (typeof action === 'number') cur = Math.max(1, Math.min(totalPages, action));

  transferPages[currentTab] = cur;
  if (currentTab === 'downloading') renderDownloadingList();
  else if (currentTab === 'completed') renderCompletedList();
  else if (currentTab === 'failed') renderFailedList();
}

function parseSpeedToBytes(speedStr) {
  if (!speedStr || typeof speedStr !== 'string') return 0;
  const match = speedStr.match(/([\d\.]+)\s*([KMGT]?B\/s)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  if (unit.startsWith('K')) return val * 1024;
  if (unit.startsWith('M')) return val * 1024 * 1024;
  if (unit.startsWith('G')) return val * 1024 * 1024 * 1024;
  if (unit.startsWith('T')) return val * 1024 * 1024 * 1024 * 1024;
  return val;
}

function formatBytesSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '0 B/s';
  if (bytesPerSec < 1024) return bytesPerSec.toFixed(0) + ' B/s';
  if (bytesPerSec < 1024 * 1024) return (bytesPerSec / 1024).toFixed(1) + ' KB/s';
  if (bytesPerSec < 1024 * 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(2) + ' MB/s';
  return (bytesPerSec / (1024 * 1024 * 1024)).toFixed(2) + ' GB/s';
}

let lastGlobalSpeedPaintAt = 0;
let globalSpeedPaintTimer = null;

function paintGlobalTotalSpeed() {
  let totalBytes = 0;
  activeDownloads.forEach(item => {
    if (item.speed && item.status !== 'completed' && item.status !== 'failed' && item.status !== 'paused') {
      totalBytes += parseSpeedToBytes(item.speed);
    }
  });
  // 引导式提取任务的速度同样计入总速度
  Object.keys(extractionJobs).forEach((id) => {
    const j = extractionJobs[id];
    if (j && !j.paused && j.speed && j.speed !== '连接中…') {
      totalBytes += parseSpeedToBytes(j.speed);
    }
  });
  const speedEl = document.getElementById('globalTotalSpeed');
  if (speedEl) {
    speedEl.innerText = formatBytesSpeed(totalBytes);
  }
  lastGlobalSpeedPaintAt = Date.now();
}

function updateGlobalTotalSpeed() {
  const elapsed = Date.now() - lastGlobalSpeedPaintAt;
  if (elapsed >= 1000 || lastGlobalSpeedPaintAt === 0) {
    if (globalSpeedPaintTimer) {
      clearTimeout(globalSpeedPaintTimer);
      globalSpeedPaintTimer = null;
    }
    paintGlobalTotalSpeed();
    return;
  }
  if (!globalSpeedPaintTimer) {
    globalSpeedPaintTimer = setTimeout(() => {
      globalSpeedPaintTimer = null;
      paintGlobalTotalSpeed();
    }, 1000 - elapsed);
  }
}

function getTransferPausedCount() {
  let n = activeDownloads.filter((d) => d.status === 'paused').length;
  Object.keys(extractionJobs).forEach((id) => { if (extractionJobs[id] && extractionJobs[id].paused) n++; });
  return n;
}

function switchTransferSubTab(subTab) {
  currentTransferSubTab = subTab;
  updateMd5Toolbar();
  const btnDownloading = document.getElementById('tabBtnDownloading');
  const btnCompleted = document.getElementById('tabBtnCompleted');
  const btnFailed = document.getElementById('tabBtnFailed');
  const listDownloading = document.getElementById('transferDownloadingList');
  const listCompleted = document.getElementById('transferCompletedList');
  const listFailed = document.getElementById('transferFailedList');
  const btnClearCompleted = document.getElementById('btnClearCompleted');
  const btnClearFailed = document.getElementById('btnClearFailed');
  const btnRetryAllFailed = document.getElementById('btnRetryAllFailed');

  if (subTab === 'downloading') {
    if (btnDownloading) btnDownloading.classList.add('active');
    if (btnCompleted) btnCompleted.classList.remove('active');
    if (btnFailed) btnFailed.classList.remove('active');
    if (listDownloading) listDownloading.style.display = 'flex';
    if (listCompleted) listCompleted.style.display = 'none';
    if (listFailed) listFailed.style.display = 'none';
    if (btnClearCompleted) btnClearCompleted.style.display = 'none';
    if (btnClearFailed) btnClearFailed.style.display = 'none';
    if (btnRetryAllFailed) btnRetryAllFailed.style.display = 'none';
  } else if (subTab === 'completed') {
    if (btnDownloading) btnDownloading.classList.remove('active');
    if (btnCompleted) btnCompleted.classList.add('active');
    if (btnFailed) btnFailed.classList.remove('active');
    if (listDownloading) listDownloading.style.display = 'none';
    if (listCompleted) listCompleted.style.display = 'flex';
    if (listFailed) listFailed.style.display = 'none';
    if (btnClearCompleted) btnClearCompleted.style.display = 'inline-block';
    if (btnClearFailed) btnClearFailed.style.display = 'none';
    if (btnRetryAllFailed) btnRetryAllFailed.style.display = 'none';
  } else if (subTab === 'failed') {
    if (btnDownloading) btnDownloading.classList.remove('active');
    if (btnCompleted) btnCompleted.classList.remove('active');
    if (btnFailed) btnFailed.classList.add('active');
    if (listDownloading) listDownloading.style.display = 'none';
    if (listCompleted) listCompleted.style.display = 'none';
    if (listFailed) listFailed.style.display = 'flex';
    if (btnClearCompleted) btnClearCompleted.style.display = 'none';
    if (btnClearFailed) btnClearFailed.style.display = failedDownloads.length > 0 ? 'inline-block' : 'none';
    if (btnRetryAllFailed) btnRetryAllFailed.style.display = failedDownloads.length > 0 ? 'inline-block' : 'none';
  }
  // 页签切换后刷新工具栏可见性(全部暂停/恢复/取消只在下载页签出现)与统计行
  updateTransferCounts();
  if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
  if (subTab === 'downloading') updateTransferPaginationUI(activeDownloads.filter(f => matchesTransferSearch(f.name)).length + Object.keys(extractionJobs).length);
  else if (subTab === 'completed') updateTransferPaginationUI(completedDownloads.filter(f => matchesTransferSearch(f.name)).length);
  else if (subTab === 'failed') updateTransferPaginationUI(failedDownloads.filter(f => matchesTransferSearch(f.name)).length);
}

function updateTransferCounts() {
  syncTransfersToStorage();
  const downloadingCount = activeDownloads.length + Object.keys(extractionJobs).length;
  const downloadingCountEl = document.getElementById('downloadingCount');
  const completedCountEl = document.getElementById('completedCount');
  const failedCountEl = document.getElementById('failedCount');
  if (downloadingCountEl) downloadingCountEl.innerText = downloadingCount;
  if (completedCountEl) completedCountEl.innerText = completedDownloads.length;
  if (failedCountEl) failedCountEl.innerText = failedDownloads.length;

  const badge = document.getElementById('activeDownloadsBadge');
  if (badge) {
    if (downloadingCount > 0) {
      badge.innerText = downloadingCount;
      badge.style.display = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  }

  const btnClearFailed = document.getElementById('btnClearFailed');
  const btnRetryAllFailed = document.getElementById('btnRetryAllFailed');
  if (currentTransferSubTab === 'failed') {
    if (btnClearFailed) btnClearFailed.style.display = failedDownloads.length > 0 ? 'inline-block' : 'none';
    if (btnRetryAllFailed) btnRetryAllFailed.style.display = failedDownloads.length > 0 ? 'inline-block' : 'none';
  }

  // 正在下载工具栏(全部暂停/恢复/取消):仅在下载页签且有任务时显示
  const showDlToolbar = downloadingCount > 0 && currentTransferSubTab === 'downloading';
  const btnPauseAll = document.getElementById('btnPauseAll');
  const btnResumeAll = document.getElementById('btnResumeAll');
  const btnCancelAll = document.getElementById('btnCancelAll');
  if (btnPauseAll) btnPauseAll.style.display = showDlToolbar ? 'inline-block' : 'none';
  if (btnResumeAll) btnResumeAll.style.display = showDlToolbar ? 'inline-block' : 'none';
  if (btnCancelAll) btnCancelAll.style.display = showDlToolbar ? 'inline-block' : 'none';
  if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();

  updateGlobalTotalSpeed();

  // 任务统计行:X 下载中 · Y 已暂停 · 总速度
  const statsEl = document.getElementById('transferStatsLine');
  if (statsEl) {
    if (downloadingCount === 0) {
      statsEl.innerText = '';
      statsEl.style.display = 'none';
    } else {
      const paused = getTransferPausedCount();
      const running = downloadingCount - paused;
      statsEl.style.display = 'block';
      statsEl.innerText = `${running} 个下载中 · ${paused} 个已暂停`;
    }
  }
}

// 按文件名/URL 推断文件类型图标(传输列表卡片左侧)
function getFileTypeIcon(name, url) {
  const s = (String(name || '') + ' ' + String(url || '')).toLowerCase();
  const COMP = '(\\.(gz|bz2|xz|zst))?'; // 生信序列文件常被压缩(fastq.gz 等),仍应识别为序列数据
  if (/sra_raw|sra-pub-run-odp|\.sra(\?|$)/.test(s)) return '🧬';
  if (new RegExp('\\.(fastq|fq|fasta|fa|gb|gff|gtf|sam|bam|cram|vcf|bcf)' + COMP + '(\\?|$)').test(s)) return '🧬';
  if (/\.(h5|h5ad|loom|rds|h5seurat|mtx)(\?|$)/.test(s)) return '🧫';
  if (/ebi\.ac\.uk|geo\/series|ncbi\.nlm\.nih\.gov/.test(s)) return '🧬';
  if (/\.(gz|zip|tar|rar|7z|bz2|xz)(\?|$)/.test(s)) return '📦';
  if (/\.(csv|tsv|xls|xlsx|json|xml)(\?|$)/.test(s)) return '📊';
  if (/\.(pdf|doc|docx)(\?|$)/.test(s)) return '📕';
  if (/\.(mp4|mov|avi|mkv|webm)(\?|$)/.test(s)) return '🎬';
  if (/\.(png|jpe?g|gif|webp|svg)(\?|$)/.test(s)) return '🖼️';
  return '📄';
}

// 剩余时间(ETA)格式化
function formatEta(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return '剩余约 ' + Math.ceil(seconds) + ' 秒';
  if (seconds < 3600) return '剩余约 ' + Math.ceil(seconds / 60) + ' 分钟';
  return '剩余约 ' + (seconds / 3600).toFixed(1) + ' 小时';
}

// 由剩余字节 + 速度字符串估算 ETA
function computeEta(remainingBytes, speedStr) {
  const bps = parseSpeedToBytes(speedStr);
  if (!bps || !remainingBytes || remainingBytes <= 0) return '';
  return formatEta(remainingBytes / bps);
}

// Use one byte snapshot for the bar, byte label and ETA, including re-renders.
// Legacy records without byte counters retain their percentage-based estimate.
function transferProgressView(file) {
  const total = Number(file.totalBytes) > 0 ? Number(file.totalBytes) : Number(file.size) || 0;
  const legacyAxel = file.engine === 'axel' && !file.receivedBytesApproximate;
  const knownReceived = !legacyAxel && file.receivedBytes != null && Number.isFinite(Number(file.receivedBytes));
  const received = Math.max(0, knownReceived ? Number(file.receivedBytes) : total * (Number(file.percentage) || 0) / 100);
  const percentage = Math.max(0, Math.min(100, total > 0 ? Math.floor(received * 1000 / total) / 10 : Number(file.percentage) || 0));
  return { total, received, percentage, approximate: legacyAxel || Boolean(file.receivedBytesApproximate) };
}

function matchesTransferSearch(name) {
  if (!transferSearchQuery) return true;
  return String(name || '').toLowerCase().includes(transferSearchQuery);
}

function onTransferSearch(e) {
  transferSearchQuery = (e.target.value || '').trim().toLowerCase();
  renderDownloadingList();
  renderCompletedList();
  renderFailedList();
  renderExtractionTransferCards();
}

function renderDownloadingList() {
  const container = document.getElementById('transferDownloadingList');
  if (!container) return;

  const emptyState = document.getElementById('emptyDownloadingState');
  const cards = container.querySelectorAll('.transfer-item:not(.transfer-item-ex)');
  cards.forEach(c => c.remove());

  const matched = activeDownloads.filter((f) => matchesTransferSearch(f.name));
  const totalCount = matched.length + Object.keys(extractionJobs).length;

  if (activeDownloads.length === 0 && Object.keys(extractionJobs).length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (typeof updateTransferPaginationUI === 'function') updateTransferPaginationUI(0);
    if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  if (typeof updateTransferPaginationUI === 'function') updateTransferPaginationUI(totalCount);
  const page = typeof getTransferCurrentPage === 'function' ? getTransferCurrentPage('downloading') : 1;
  const pageSize = typeof TRANSFER_PAGE_SIZE !== 'undefined' ? TRANSFER_PAGE_SIZE : 50;
  const startIdx = (page - 1) * pageSize;
  const pageItems = matched.slice(startIdx, startIdx + pageSize);

  pageItems.forEach((file) => {
    const fileId = file.originalIndex;
    const paused = file.status === 'paused';
    const { percentage, total: totalSize, received: receivedSize, approximate } = transferProgressView(file);
    const speedText = paused ? '—' : (file.speed || (file.status === 'waiting' ? '排队中...' : ''));
    const eta = paused || ['waiting', 'preparing', 'connecting', 'verifying'].includes(file.phase || file.status) ? '' : computeEta(totalSize > 0 ? totalSize - receivedSize : 0, file.speed);
    const statusText = paused ? (file.startupError ? '未启动：' + escapeHtml(file.startupError) : '已暂停 · 可续传') : (file.status === 'waiting' ? '排队中...' : file.phase === 'verifying' ? '正在校验文件' : file.phase === 'preparing' ? '正在准备下载' : file.phase === 'connecting' ? '正在连接下载源' : '正在高速下载');

    const itemEl = document.createElement('div');
    itemEl.className = 'transfer-item tl-card' + (paused ? ' tl-paused' : '');
    itemEl.id = `transfer-card-${fileId}`;
    itemEl.dataset.url = file.url || '';
    itemEl.dataset.status = paused ? 'paused' : 'downloading';

    itemEl.innerHTML = `
      <input type="checkbox" class="tl-select-checkbox" ${typeof selectedTransferKeys !== 'undefined' && selectedTransferKeys.downloading.has(String(fileId)) ? 'checked' : ''} onchange="toggleTransferItemSelection('downloading', '${fileId}', this.checked)" title="勾选此任务">
      <div class="tl-icon">${getFileTypeIcon(file.name, file.url)}</div>
      <div class="tl-body">
        <div class="transfer-item-name-row">
          <span class="transfer-item-name">${escapeHtml(file.name)}</span>
          <span class="transfer-item-badge">${getFileTypeBadge(file.url || '')}</span>
        </div>
        <div class="tl-progress-row">
          <div class="transfer-progress-bar">
            <div class="transfer-progress-fill${paused ? ' paused' : ''}" id="trans-progress-fill-${fileId}" style="width: ${percentage}%"></div>
          </div>
          <span class="tl-pct" id="trans-pct-${fileId}">${percentage}%</span>
        </div>
        <div class="transfer-item-meta">
          <span class="transfer-item-size" id="trans-size-${fileId}">${approximate ? '约 ' : ''}${totalSize > 0 ? formatBytes(receivedSize) + ' / ' + formatBytes(totalSize) : formatBytes(receivedSize)}</span>
          <span class="transfer-item-speed" id="trans-speed-${fileId}">${escapeHtml(speedText)}</span>
          <span class="tl-eta" id="trans-eta-${fileId}">${escapeHtml(eta)}</span>
          <span class="transfer-item-status${paused ? ' paused' : ''}" id="trans-status-${fileId}">${statusText}</span>
        </div>
      </div>
      <div class="tl-actions">
        ${paused
          ? `<button class="tl-btn primary" title="恢复下载(断点续传)" onclick="resumeSingleDownload(${fileId})">▶</button>`
          : `<button class="tl-btn" title="暂停下载(保留断点)" onclick="pauseSingleDownload(${fileId})">⏸</button>`}
        <button class="tl-btn danger" title="取消任务" onclick="cancelSingleDownload(${fileId})">✕</button>
      </div>
    `;
    container.appendChild(itemEl);
  });
  if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
}
let mismatchQueueBusy = false;
const transferPathKey = value => { const key = String(value || '').replace(/\\/g, '/').replace(/\/$/, ''); return /^[a-z]:\/|^\/\//i.test(key) ? key.toLowerCase() : key; };
async function redownloadMismatch(index) { const item = completedDownloads[index]; if (item) await queueMismatches([item]); }
async function redownloadAllMismatched() { await queueMismatches(completedDownloads.filter(item => item.verification?.status === 'mismatch')); }
async function queueMismatches(items) {
  if (mismatchQueueBusy) return;
  if (manualMd5Run) return showToast('请先等待 MD5 校验完成或停止校验，再重新下载', 'info');
  if (!items.length) return showToast('没有 MD5 不一致的文件；未校验文件请先校验 MD5', 'info');
  mismatchQueueBusy = true;
  try {
    if (!(await ensureTransferConnection())) return;
    const groups = new Map(), seen = new Set(activeDownloads.map(item => transferPathKey(item.savePath || (item.targetDir + '/' + (item.folder ? item.folder + '/' : '') + item.name))));
    let count = 0;
    for (const item of items) {
      if (item.verification?.status !== 'mismatch' || item.type === 'extraction') continue;
      const savePath = item.savePath || '', sep = Math.max(savePath.lastIndexOf('/'), savePath.lastIndexOf('\\'));
      const url = item.url || item.fileObj?.url, key = transferPathKey(savePath);
      if (sep < 0 || !url || seen.has(key)) continue;
      seen.add(key);
      const dir = savePath.slice(0, sep + 1);
      const file = { ...item.fileObj, name: savePath.slice(sep + 1), url, size: item.size,
        md5: item.verification.expectedMd5 || item.md5 || item.fileObj?.md5,
        folder: '', targetDir: dir, savePath, originalIndex: allocateTransferId(),
        redownloadMismatch: true, status: 'waiting', speed: '等待重新下载…' };
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push(file); activeDownloads.push(file); count++;
    }
    if (!count) return showToast('文件已在队列中，或缺少原链接/保存路径', 'info');
    renderDownloadingList(); updateTransferCounts(); syncTransfersToStorage(); switchTransferSubTab('downloading');
    showToast(`已加入 ${count} 个重下任务；原文件保留在下载目录的 .biodl-replaced 文件夹`, 'info');
    for (const [dir, files] of groups) {
      try { await window.api.startDownload(files, dir, currentUser.token, maxConcurrentDownloadsSetting); }
      catch (error) {
        files.forEach(file => { if (activeDownloads.includes(file)) { file.status = 'paused'; file.speed = ''; } });
        renderDownloadingList(); updateTransferCounts(); syncTransfersToStorage();
        showToast('启动失败，任务已保留：' + error.message, 'error');
      }
    }
  } finally { mismatchQueueBusy = false; }
}

// Manual MD5 checks operate on a stable snapshot even if download history changes.
var manualMd5Run = null;
async function verifyCompletedMd5(index) {
  const item = completedDownloads[index];
  if (item) await runCompletedMd5([item]);
}
async function verifyAllCompletedMd5() {
  await runCompletedMd5(completedDownloads.filter(item => item.savePath && item.verification?.status !== 'verified'));
}
async function stopCompletedMd5() {
  if (!manualMd5Run) return;
  manualMd5Run.cancelled = true;
  if (manualMd5Run.id) await window.api.cancelTransferMd5(manualMd5Run.id);
}
function updateMd5Toolbar() {
  const start = document.getElementById('btnVerifyCompleted');
  const stop = document.getElementById('btnStopMd5');
  const retry = document.getElementById('btnRedownloadMismatched');
  if (retry) { retry.style.display = currentTransferSubTab === 'completed' ? '' : 'none'; retry.disabled = Boolean(manualMd5Run); }
  if (start) { start.style.display = currentTransferSubTab === 'completed' ? '' : 'none'; start.disabled = Boolean(manualMd5Run); }
  if (stop) stop.style.display = manualMd5Run ? '' : 'none';
}
async function runCompletedMd5(items) {
  if (manualMd5Run) return showToast('已有 MD5 校验正在进行，可等待完成或点击停止校验', 'info');
  if (!items.length) return showToast('没有待校验的已完成文件', 'info');
  const run = { cancelled: false, id: null, item: null };
  manualMd5Run = run;
  let verified = 0, warning = 0;
  updateMd5Toolbar();
  try {
    // Metadata can use the accelerator when logged in. Local hashing still works
    // offline; without an official checksum it is never labelled verified.
    if (currentUser?.token && !window.campusNotice?.requiresAcknowledgment() && !(await window.api.getClashStatus())) {
      try { await window.api.startClash(currentUser.token); } catch (_) {}
    }
    for (const item of items) {
      if (run.cancelled) break;
      if (!completedDownloads.includes(item)) continue;
      run.id = 'md5-' + allocateTransferId(); run.item = item;
      item.md5Progress = '正在获取参考 MD5…';
      renderCompletedList();
      try {
        const result = await window.api.verifyTransferMd5({
          id: run.id, savePath: item.savePath,
          file: { ...item.fileObj, name: item.name, url: item.url || item.fileObj?.url,
            size: item.size, md5: item.md5 || item.fileObj?.md5 || item.verification?.expectedMd5 }
        });
        if (result.cancelled) { run.cancelled = true; break; }
        item.verification = result.verification;
        if (item.verification.status === 'verified') verified++; else warning++;
      } catch (error) {
        item.verification = { status: 'failed', reason: error.message }; warning++;
      } finally {
        delete item.md5Progress;
        syncTransfersToStorage(); renderCompletedList();
      }
    }
    showToast(`${run.cancelled ? '已停止校验' : 'MD5 校验结束'}：一致 ${verified} · 待核对 ${warning}`, warning ? 'warning' : 'info');
  } finally { manualMd5Run = null; updateMd5Toolbar(); }
}
if (window.api.onMd5VerificationProgress) window.api.onMd5VerificationProgress(data => {
  if (!manualMd5Run || manualMd5Run.id !== data.id) return;
  manualMd5Run.item.md5Progress = data.phase === 'hashing'
    ? `正在校验 MD5：${data.total ? Math.floor(data.bytes * 100 / data.total) : 100}%` : '正在获取参考 MD5…';
  renderCompletedList();
});

function renderCompletedList() {
  const container = document.getElementById('transferCompletedList');
  if (!container) return;

  const emptyState = document.getElementById('emptyCompletedState');
  const cards = container.querySelectorAll('.transfer-item');
  cards.forEach(c => c.remove());

  const matched = completedDownloads.map((item, index) => ({ item, index })).filter(({ item }) => matchesTransferSearch(item.name));

  if (completedDownloads.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (typeof updateTransferPaginationUI === 'function') updateTransferPaginationUI(0);
    if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  if (typeof updateTransferPaginationUI === 'function') updateTransferPaginationUI(matched.length);
  const page = typeof getTransferCurrentPage === 'function' ? getTransferCurrentPage('completed') : 1;
  const pageSize = typeof TRANSFER_PAGE_SIZE !== 'undefined' ? TRANSFER_PAGE_SIZE : 50;
  const startIdx = (page - 1) * pageSize;
  const pageItems = matched.slice(startIdx, startIdx + pageSize);

  pageItems.forEach(({ item, index }) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'transfer-item tl-card completed';
    itemEl.dataset.url = item.url || '';
    itemEl.dataset.status = 'completed';
    itemEl.dataset.savepath = item.savePath || '';
    itemEl.dataset.index = String(index);
    itemEl.innerHTML = `
      <input type="checkbox" class="tl-select-checkbox" ${typeof selectedTransferKeys !== 'undefined' && selectedTransferKeys.completed.has(item) ? 'checked' : ''} onchange="toggleTransferItemSelection('completed', ${index}, this.checked)" title="勾选此任务">
      <div class="tl-icon">${getFileTypeIcon(item.name, item.url)}</div>
      <div class="tl-body">
        <div class="transfer-item-name-row">
          <span class="transfer-item-name">${escapeHtml(item.name)}</span>
          <span class="transfer-item-badge">${getFileTypeBadge(item.url || '')}</span>
        </div>
        <div class="transfer-item-meta">
          <span class="transfer-item-size">${formatBytes(item.size || 0)}</span>
          <span class="transfer-item-status completed"${item.verification && ['unavailable', 'mismatch', 'computed', 'failed'].includes(item.verification.status) ? ' style="color: #d97706;"' : ''} title="${escapeHtml(item.verification && item.verification.reason || '')}">${item.md5Progress ? escapeHtml(item.md5Progress) : item.verification?.status === 'failed' ? '校验失败：' + escapeHtml(item.verification.reason || '请重试') : item.verification?.status === 'computed' ? '已计算 MD5，缺少参考值（未比对）' : item.verification && item.verification.status === 'mismatch' ? '已保存 · MD5 与参考值不一致，需核对' : item.verification && item.verification.status === 'unavailable' ? '已保存 · MD5 未核验' : item.verification && item.verification.status === 'verified' ? 'MD5 与参考值一致' : item.verification && item.verification.status === 'quick-checked' ? (item.verification.transport?.engine === 'native' ? '分块与边界检查通过（未做 MD5）' : item.verification.transport ? '源文件抽样通过（未做 MD5）' : '快速检查通过（未做 MD5）') : item.skip ? '大小匹配 (跳过)' : '下载完成'}</span>
          ${item.verification?.actualMd5 ? `<span style="word-break:break-all;user-select:text;">本地 MD5：${escapeHtml(item.verification.actualMd5)}</span>` : ''}
          ${item.verification?.status === 'unavailable' || item.verification?.status === 'computed' ? `<span>${escapeHtml(item.verification.reason || '缺少参考 MD5，可点击校验重试')}</span>` : ''}
          ${item.backupPath ? `<span style="word-break:break-all;user-select:text;" title="${escapeHtml(item.backupPath)}">原文件已保留：${escapeHtml(item.backupPath)}</span>` : ''}
          <span class="transfer-item-time">${item.completedAt}</span>
        </div>
      </div>
      <div class="tl-actions">
        ${item.verification?.status === 'mismatch' ? `<button class="tl-btn primary" style="width:auto;padding:0 8px;" onclick="redownloadMismatch(${index})" ${item.md5Progress ? 'disabled' : ''}>重新下载</button>` : ''}
        <button class="tl-btn primary" style="width:auto;padding:0 8px;" title="读取已有文件并立即校验 MD5，不重复下载" onclick="verifyCompletedMd5(${index})" ${item.md5Progress ? 'disabled' : ''}>校验 MD5</button>
        <button class="tl-btn primary" title="在文件夹中定位" onclick="openCompletedRecord(${index})">📂</button>
        <button class="tl-btn danger" title="删除记录" onclick="deleteCompletedRecord(${index})">🗑</button>
      </div>
    `;
    container.appendChild(itemEl);
  });
  if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
}

function renderFailedList() {
  const container = document.getElementById('transferFailedList');
  if (!container) return;

  const emptyState = document.getElementById('emptyFailedState');
  const cards = container.querySelectorAll('.transfer-item');
  cards.forEach(c => c.remove());

  const matched = failedDownloads.map((item, index) => ({ item, index })).filter(({ item }) => matchesTransferSearch(item.name));

  if (failedDownloads.length === 0) {
    if (emptyState) emptyState.style.display = 'flex';
    if (typeof updateTransferPaginationUI === 'function') updateTransferPaginationUI(0);
    if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
    return;
  }
  if (emptyState) emptyState.style.display = 'none';

  if (typeof updateTransferPaginationUI === 'function') updateTransferPaginationUI(matched.length);
  const page = typeof getTransferCurrentPage === 'function' ? getTransferCurrentPage('failed') : 1;
  const pageSize = typeof TRANSFER_PAGE_SIZE !== 'undefined' ? TRANSFER_PAGE_SIZE : 50;
  const startIdx = (page - 1) * pageSize;
  const pageItems = matched.slice(startIdx, startIdx + pageSize);

  pageItems.forEach(({ item, index }) => {
    const itemEl = document.createElement('div');
    itemEl.className = 'transfer-item tl-card failed';
    itemEl.dataset.url = item.url || '';
    itemEl.dataset.status = 'failed';
    itemEl.dataset.index = String(index);
    itemEl.innerHTML = `
      <input type="checkbox" class="tl-select-checkbox" ${typeof selectedTransferKeys !== 'undefined' && selectedTransferKeys.failed.has(item) ? 'checked' : ''} onchange="toggleTransferItemSelection('failed', ${index}, this.checked)" title="勾选此任务">
      <div class="tl-icon">${getFileTypeIcon(item.name, item.url)}</div>
      <div class="tl-body">
        <div class="transfer-item-name-row">
          <span class="transfer-item-name">${escapeHtml(item.name)}</span>
          <span class="transfer-item-badge">${getFileTypeBadge(item.url || '')}</span>
        </div>
        <div class="transfer-item-meta">
          <span class="transfer-item-size">${formatBytes(item.size || 0)}</span>
          <span class="transfer-item-status failed" style="color: #f87171;">下载失败: ${escapeHtml(item.failedReason || item.errorMsg || '网络或节点超时')}</span>
          <span class="transfer-item-time">${item.failedAt || new Date().toLocaleString()}</span>
        </div>
      </div>
      <div class="tl-actions">
        <button class="tl-btn primary" title="一键重试(断点续传)" onclick="retryFailedDownload(${index})">🔄</button>
        <button class="tl-btn danger" title="删除记录" onclick="deleteFailedRecord(${index})">🗑</button>
      </div>
    `;
    container.appendChild(itemEl);
  });
  if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
}

// 点击定位文件夹时，不再通过 innerHTML 拼接未转义反斜杠，避免 Windows 路径被 JS 字符串吞噬
function escapeJsArg(str) {
  return String(str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function getFileTypeBadge(url) {
  if (!url) return 'Direct Link';
  if (url.includes('sra_raw') || url.includes('sra-pub-run-odp')) return 'SRA Raw';
  if (url.includes('ebi.ac.uk')) return 'EBI Raw';
  if (url.includes('geo/series')) return 'GEO Suppl';
  if (url.includes('zenodo.org')) return 'Zenodo';
  if (url.includes('huggingface.co')) return 'Hugging Face';
  if (url.includes('ncbi.nlm.nih.gov')) return 'NCBI';
  if (url.includes('singlecell.broadinstitute.org')) return 'Broad';
  return 'Direct Link';
}

function openCompletedRecord(index) {
  const item = completedDownloads[index];
  if (!item || !item.savePath) {
    showToast('该任务无文件存储路径', 'error');
    return;
  }
  openCompletedFile(item.savePath);
}

function openCompletedFile(savePath) {
  if (!savePath) {
    showToast('该任务无文件存储路径', 'error');
    return;
  }
  window.api.openDownloadsFolder(savePath);
}

let currentDeleteTarget = null;

function openDeleteTransferModal(target) {
  // target: { category: 'completed'|'failed'|'active'|'all_completed'|'all_failed', index, fileId }
  let name = '';
  let savePath = '';
  let title = '删除下载任务';

  if (target.category === 'completed') {
    const item = completedDownloads[target.index];
    if (!item) return;
    name = item.name;
    savePath = item.savePath || '';
  } else if (target.category === 'failed') {
    const item = failedDownloads[target.index];
    if (!item) return;
    name = item.name;
    savePath = item.savePath || '';
  } else if (target.category === 'active') {
    const item = activeDownloads.find(d => d.originalIndex === target.fileId);
    if (!item) return;
    name = item.name;
    savePath = item.savePath || (defaultDir ? (item.folder ? `${defaultDir}/${item.folder}/${item.name}` : `${defaultDir}/${item.name}`) : '');
  } else if (target.category === 'all_completed') {
    title = '清空全部已完成任务';
    name = `全部已完成任务 (${completedDownloads.length} 项)`;
    savePath = '将对所有已完成任务执行操作';
  } else if (target.category === 'selected_completed') {
    title = '删除选中的已完成任务';
    name = `已选已完成任务 (${selectedTransferKeys.completed.size} 项)`;
    savePath = '将对所有勾选的已完成任务执行操作';
  } else if (target.category === 'all_failed') {
    title = '清空全部失败任务';
    name = `全部失败任务 (${failedDownloads.length} 项)`;
    savePath = '将对所有失败任务执行操作';
  } else if (target.category === 'selected_failed') {
    title = '删除选中的失败任务';
    name = `已选失败任务 (${selectedTransferKeys.failed.size} 项)`;
    savePath = '将对所有勾选的失败任务执行操作';
  }

  currentDeleteTarget = { ...target, name, savePath };

  const modal = document.getElementById('deleteTransferModal');
  const titleEl = document.getElementById('deleteTransferModalTitle');
  const nameEl = document.getElementById('deleteTransferName');
  const pathEl = document.getElementById('deleteTransferPath');

  if (titleEl) titleEl.textContent = title;
  if (nameEl) nameEl.textContent = name || '未命名任务';
  if (pathEl) pathEl.textContent = savePath ? `本地路径: ${savePath}` : '本地路径: (未获取到本地路径，将仅清理记录)';
  if (modal) modal.style.display = 'flex';
}

function closeDeleteTransferModal() {
  const modal = document.getElementById('deleteTransferModal');
  if (modal) modal.style.display = 'none';
  currentDeleteTarget = null;
}

async function confirmDeleteTransfer(deleteFiles) {
  const target = currentDeleteTarget;
  closeDeleteTransferModal();
  if (!target) return;

  if (target.category === 'all_completed' || target.category === 'selected_completed') {
    const isSelected = target.category === 'selected_completed';
    const toDelete = isSelected ? [...selectedTransferKeys.completed].filter(item => completedDownloads.includes(item)) : [...completedDownloads];
    if (isSelected) {
      completedDownloads = completedDownloads.filter(item => !selectedTransferKeys.completed.has(item));
      selectedTransferKeys.completed.clear();
    } else {
      completedDownloads = [];
      selectedTransferKeys.completed.clear();
    }
    syncTransfersToStorage();
    renderCompletedList();
    updateTransferCounts();
    if (deleteFiles) {
      for (const item of toDelete) {
        if (item.savePath) {
          try { await window.api.deleteTransferFile(item.savePath); } catch (e) {}
        }
      }
    }
    showToast(deleteFiles ? (isSelected ? '已删除选中完成记录及本地文件' : '已清空完成记录并删除对应本地文件') : (isSelected ? '已删除选中完成记录' : '已清空完成记录'), 'success');
    return;
  }

  if (target.category === 'all_failed' || target.category === 'selected_failed') {
    const isSelected = target.category === 'selected_failed';
    const toDelete = isSelected ? [...selectedTransferKeys.failed].filter(item => failedDownloads.includes(item)) : [...failedDownloads];
    if (isSelected) {
      failedDownloads = failedDownloads.filter(item => !selectedTransferKeys.failed.has(item));
      selectedTransferKeys.failed.clear();
    } else {
      failedDownloads = [];
      selectedTransferKeys.failed.clear();
    }
    syncTransfersToStorage();
    renderFailedList();
    updateTransferCounts();
    if (deleteFiles) {
      for (const item of toDelete) {
        if (item.savePath) {
          try { await window.api.deleteTransferFile(item.savePath); } catch (e) {}
        }
      }
    }
    showToast(deleteFiles ? (isSelected ? '已删除选中失败记录及残留文件' : '已清空失败记录并删除残留文件') : (isSelected ? '已删除选中失败记录' : '已清空失败记录'), 'success');
    return;
  }

  if (target.category === 'active') {
    const fileId = target.fileId;
    try {
      await window.api.cancelDownload(fileId);
    } catch (e) {
      console.warn('cancelDownload error:', e);
    }
    if (deleteFiles) {
      await new Promise(r => setTimeout(r, 250));
    }
    activeDownloads = activeDownloads.filter(d => d.originalIndex !== fileId);
    renderDownloadingList();
    updateTransferCounts();
    if (deleteFiles && target.savePath) {
      try {
        await window.api.deleteTransferFile(target.savePath);
      } catch (e) {
        console.warn('deleteTransferFile error:', e);
      }
    }
    showToast(deleteFiles ? '已取消任务并删除本地文件' : '已取消任务并移除记录', 'success');
    return;
  }

  if (target.category === 'completed') {
    completedDownloads.splice(target.index, 1);
    syncTransfersToStorage();
    renderCompletedList();
    updateTransferCounts();
    if (deleteFiles && target.savePath) {
      try {
        await window.api.deleteTransferFile(target.savePath);
      } catch (e) {
        console.warn('deleteTransferFile error:', e);
      }
    }
    showToast(deleteFiles ? '已删除记录及本地文件' : '已删除传输记录', 'success');
    return;
  }

  if (target.category === 'failed') {
    failedDownloads.splice(target.index, 1);
    syncTransfersToStorage();
    renderFailedList();
    updateTransferCounts();
    if (deleteFiles && target.savePath) {
      try {
        await window.api.deleteTransferFile(target.savePath);
      } catch (e) {
        console.warn('deleteTransferFile error:', e);
      }
    }
    showToast(deleteFiles ? '已删除失败记录及残留文件' : '已删除失败记录', 'success');
    return;
  }
}

function deleteCompletedRecord(index) {
  openDeleteTransferModal({ category: 'completed', index });
}

function deleteFailedRecord(index) {
  openDeleteTransferModal({ category: 'failed', index });
}

function clearCompletedDownloads() {
  if (!completedDownloads.length) return showToast('暂无已完成任务', 'info');
  if (selectedTransferKeys.completed.size > 0) return openDeleteTransferModal({ category: 'selected_completed' });
  openDeleteTransferModal({ category: 'all_completed' });
}

function clearFailedDownloads() {
  if (!failedDownloads.length) return showToast('暂无失败任务', 'info');
  if (selectedTransferKeys.failed.size > 0) return openDeleteTransferModal({ category: 'selected_failed' });
  openDeleteTransferModal({ category: 'all_failed' });
}

let transferConnectionPromise = null;
let nextTransferId = Date.now();
const resumingTransferIds = new Set();
const resumingExtractionIds = new Set();
const selectedTransferKeys = {
  downloading: new Set(),
  completed: new Set(),
  failed: new Set()
};

function getTransferSelectSet(tab = currentTransferSubTab) {
  return selectedTransferKeys[tab] || selectedTransferKeys.downloading;
}

function getVisibleTransferItems(tab = currentTransferSubTab) {
  if (tab === 'downloading') {
    const page = typeof getTransferCurrentPage === 'function' ? getTransferCurrentPage('downloading') : 1;
    const pageSize = typeof TRANSFER_PAGE_SIZE !== 'undefined' ? TRANSFER_PAGE_SIZE : 50;
    const startIdx = (page - 1) * pageSize;
    const matched = activeDownloads.filter(f => matchesTransferSearch(f.name)).slice(startIdx, startIdx + pageSize);
    const exKeys = Object.keys(extractionJobs).filter(id => extractionJobs[id] && matchesTransferSearch(extractionJobs[id].name)).map(id => 'ex:' + id);
    return [...matched.map(f => String(f.originalIndex)), ...exKeys];
  }
  if (tab === 'completed') {
    const page = typeof getTransferCurrentPage === 'function' ? getTransferCurrentPage('completed') : 1;
    const pageSize = typeof TRANSFER_PAGE_SIZE !== 'undefined' ? TRANSFER_PAGE_SIZE : 50;
    const startIdx = (page - 1) * pageSize;
    return completedDownloads.map((item, idx) => ({ item, idx })).filter(({ item }) => matchesTransferSearch(item.name)).slice(startIdx, startIdx + pageSize).map(({ item }) => item);
  }
  if (tab === 'failed') {
    const page = typeof getTransferCurrentPage === 'function' ? getTransferCurrentPage('failed') : 1;
    const pageSize = typeof TRANSFER_PAGE_SIZE !== 'undefined' ? TRANSFER_PAGE_SIZE : 50;
    const startIdx = (page - 1) * pageSize;
    return failedDownloads.map((item, idx) => ({ item, idx })).filter(({ item }) => matchesTransferSearch(item.name)).slice(startIdx, startIdx + pageSize).map(({ item }) => item);
  }
  return [];
}

function pruneTransferSelections() {
  const validDl = new Set([
    ...activeDownloads.map(d => String(d.originalIndex)),
    ...Object.keys(extractionJobs).map(id => 'ex:' + id)
  ]);
  for (const k of [...selectedTransferKeys.downloading]) {
    if (!validDl.has(k)) selectedTransferKeys.downloading.delete(k);
  }
  for (const item of [...selectedTransferKeys.completed]) {
    if (!completedDownloads.includes(item)) selectedTransferKeys.completed.delete(item);
  }
  for (const item of [...selectedTransferKeys.failed]) {
    if (!failedDownloads.includes(item)) selectedTransferKeys.failed.delete(item);
  }
}

function syncTransferSelectionUI() {
  pruneTransferSelections();
  const tab = currentTransferSubTab;
  const visible = getVisibleTransferItems(tab);
  const set = getTransferSelectSet(tab);
  const selectedCount = set.size;
  const wrap = document.getElementById('transferSelectAllWrap');
  const cb = document.getElementById('transferSelectAllCheckbox');
  const txt = document.getElementById('transferSelectAllText');
  if (wrap) wrap.style.display = visible.length > 0 ? 'inline-flex' : 'none';
  if (cb) {
    const allVisibleSelected = visible.length > 0 && visible.every(v => set.has(v));
    const someVisibleSelected = visible.some(v => set.has(v));
    cb.checked = allVisibleSelected;
    cb.indeterminate = !allVisibleSelected && someVisibleSelected;
  }
  if (txt) txt.textContent = selectedCount > 0 ? `已选 ${selectedCount}` : '全选';

  const btnPauseAll = document.getElementById('btnPauseAll');
  const btnResumeAll = document.getElementById('btnResumeAll');
  const btnCancelAll = document.getElementById('btnCancelAll');
  const btnRetryAllFailed = document.getElementById('btnRetryAllFailed');
  const btnClearCompleted = document.getElementById('btnClearCompleted');
  const btnClearFailed = document.getElementById('btnClearFailed');

  if (tab === 'downloading') {
    const n = selectedTransferKeys.downloading.size;
    if (btnPauseAll) btnPauseAll.textContent = n > 0 ? `⏸ 暂停选中 (${n})` : '⏸ 全部暂停';
    if (btnResumeAll) btnResumeAll.textContent = n > 0 ? `▶ 恢复选中 (${n})` : '▶ 全部恢复';
    if (btnCancelAll) btnCancelAll.textContent = n > 0 ? `✕ 取消选中 (${n})` : '✕ 全部取消';
  } else if (tab === 'completed') {
    const n = selectedTransferKeys.completed.size;
    if (btnClearCompleted) btnClearCompleted.textContent = n > 0 ? `🗑️ 删除选中 (${n})` : '🗑️ 清空已完成';
  } else if (tab === 'failed') {
    const n = selectedTransferKeys.failed.size;
    if (btnRetryAllFailed) btnRetryAllFailed.textContent = n > 0 ? `🔄 重试选中 (${n})` : '🔄 一键重试全部';
    if (btnClearFailed) btnClearFailed.textContent = n > 0 ? `🗑️ 删除选中 (${n})` : '🗑️ 清空失败记录';
  }
}

function toggleTransferItemSelection(tab, keyOrIndex, checked) {
  const set = getTransferSelectSet(tab);
  const item = tab === 'downloading' ? String(keyOrIndex) : (tab === 'completed' ? completedDownloads[keyOrIndex] : failedDownloads[keyOrIndex]);
  if (!item) return;
  if (checked) set.add(item);
  else set.delete(item);
  syncTransferSelectionUI();
}

function toggleSelectAllTransfers(checked) {
  const tab = currentTransferSubTab;
  const set = getTransferSelectSet(tab);
  const visible = getVisibleTransferItems(tab);
  if (checked) visible.forEach(v => set.add(v));
  else visible.forEach(v => set.delete(v));
  if (tab === 'downloading') { renderDownloadingList(); renderExtractionTransferCards(); }
  else if (tab === 'completed') renderCompletedList();
  else if (tab === 'failed') renderFailedList();
  syncTransferSelectionUI();
}
function allocateTransferId() {
  while (activeDownloads.some(t => t.originalIndex === nextTransferId)) nextTransferId++;
  return nextTransferId++;
}
async function ensureTransferConnection() {
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return false;
  if (!currentUser || !currentUser.token) {
    showToast('请登录账户后继续下载', 'error');
    switchTab('profile-tab');
    return false;
  }
  if (!transferConnectionPromise) {
    transferConnectionPromise = (async () => {
      if (!(await window.api.getClashStatus())) await window.api.startClash(currentUser.token);
      return true;
    })().catch(error => { showToast('无法建立下载加速连接：' + error.message, 'error'); return false; })
      .finally(() => { transferConnectionPromise = null; });
  }
  return transferConnectionPromise;
}

async function retryFailedDownload(index) {
  const item = failedDownloads[index];
  if (!item || !(await ensureTransferConnection())) return;
  const oldFile = item.fileObj || {};
  const dir = oldFile.targetDir || item.targetDir || item.saveDir || defaultDir;
  if (!dir) return showToast('请先选择下载保存目录', 'error');
  const position = failedDownloads.indexOf(item);
  if (position < 0) return; // A second click must not queue the same failed record twice.
  failedDownloads.splice(position, 1);
  renderFailedList();
  switchTransferSubTab('downloading');
  if (item.type === 'extraction') {
    updateTransferCounts();
    try {
      const result = await window.api.extractionDownload({ url:item.url, name:item.name, saveDir:dir, size:item.size });
      if (result && result.success === false) showToast(result.error || '重试失败，请查看失败列表', 'error');
    } catch (error) {
      failedDownloads.unshift(item); renderFailedList(); updateTransferCounts();
      showToast(error.message, 'error');
    }
    return;
  }
  const file = { ...item, ...oldFile, name:oldFile.name || item.name, url:oldFile.url || item.url,
    originalIndex:allocateTransferId(), targetDir:dir, status:'waiting', speed:'准备重试...' };
  activeDownloads.push(file);
  renderDownloadingList(); updateTransferCounts();
  try { await window.api.startDownload([file], dir, currentUser.token, maxConcurrentDownloadsSetting); }
  catch (error) {
    file.status='paused'; file.speed=''; renderDownloadingList(); updateTransferCounts();
    showToast('启动失败，任务已保留：' + error.message, 'error');
  }
}

async function retryAllFailedDownloads() {
  if (!failedDownloads.length || !(await ensureTransferConnection())) return;
  const selected = [...selectedTransferKeys.failed].filter(item => failedDownloads.includes(item));
  const queue = selected.length > 0 ? selected : [...failedDownloads];
  selectedTransferKeys.failed.clear();
  async function worker() {
    while (queue.length) {
      const item=queue.shift(), index=failedDownloads.indexOf(item);
      if (index >= 0) await retryFailedDownload(index);
    }
  }
  await Promise.all(Array.from({length:Math.min(maxConcurrentDownloadsSetting || 3, queue.length)}, worker));
}

function cancelSingleDownload(fileId) {
  openDeleteTransferModal({ category: 'active', fileId });
}

// 暂停单个普通下载任务:主进程挂起 axel 进程(SIGSTOP 原地冻结,进度零丢失)。
// suspended=true 时本地直接置为暂停态;排队/重试间隙的任务由 download-status 'paused' 事件回传
async function pauseSingleDownload(fileId) {
  const item = activeDownloads.find(d => d.originalIndex === fileId);
  if (!item) return;
  if (item.status === 'paused') { resumeSingleDownload(fileId); return; }
  try {
    const r = await window.api.pauseDownload(fileId);
    if (r && r.success) {
      if (r.suspended) {
        item.status = 'paused';
        item.speed = '';
        renderDownloadingList();
        updateTransferCounts();
      }
      showToast('已暂停,断点已保留,可随时恢复续传', 'success');
    } else {
      showToast((r && r.error) || '暂停失败', 'error');
    }
  } catch (e) {
    showToast('暂停失败: ' + e.message, 'error');
  }
}

// 恢复单个已暂停任务:优先唤醒被挂起的进程(原地继续);无挂起进程时重新发起下载走断点续传
async function resumeSingleDownload(fileId) {
  if (resumingTransferIds.has(fileId)) return;
  resumingTransferIds.add(fileId);
  try { await resumeTransferFile(fileId); }
  finally { resumingTransferIds.delete(fileId); }
}
async function resumeTransferFile(fileId) {
  const file = activeDownloads.find(d => d.originalIndex === fileId);
  if (!file) return;
  if (file.status !== 'paused') return;
  try {
    const r = await window.api.resumeDownload(fileId);
    if (r && r.success === false) { showToast(r.error || '恢复失败，任务已保留', 'error'); return; }
    if (r && r.resumed) {
      file.status = 'downloading';
      file.speed = '恢复中...';
      renderDownloadingList();
      updateTransferCounts();
      showToast(`已恢复 ${file.name}`, 'success');
      return;
    }
  } catch (e) { showToast('恢复失败，任务已保留：' + e.message, 'error'); return; }
  if (!currentUser) {
    showToast('请登录账户后恢复下载', 'error');
    switchTab('profile-tab');
    return;
  }
  const dir = file.targetDir || defaultDir || (document.getElementById('targetDirInput') ? document.getElementById('targetDirInput').value.trim() : '');
  if (!dir) {
    showToast('请先选择下载的保存目标路径', 'error');
    return;
  }
  if (!(await ensureTransferConnection())) return;
  file.status = 'waiting';
  delete file.startupError;
  file.speed = '准备恢复...';
  renderDownloadingList();
  updateTransferCounts();
  showToast(`正在恢复 ${file.name},从断点继续下载...`, 'info');
  try {
    await window.api.startDownload([{ name: file.name, url: file.url, size: file.size || 0, md5: file.md5, folder: file.folder, type: file.type, originalIndex: file.originalIndex, redownloadMismatch: file.redownloadMismatch, backupPath: file.backupPath }], dir, currentUser.token, maxConcurrentDownloadsSetting);
  } catch (e) {
    file.status = 'paused'; file.speed = '';
    renderDownloadingList(); updateTransferCounts();
    showToast('启动失败，任务已保留：' + e.message, 'error');
  }
}

// ---- 全部任务操作(参考成熟下载器:全部暂停/全部恢复/全部取消，支持仅操作勾选项) ----
async function pauseAllDownloads() {
  let acted = false;
  const sel = selectedTransferKeys.downloading;
  const hasSelection = sel.size > 0;
  for (const t of activeDownloads) {
    if (hasSelection && !sel.has(String(t.originalIndex))) continue;
    if (t.status === 'paused' || t.status === 'completed' || t.status === 'failed') continue;
    try {
      const r = await window.api.pauseDownload(t.originalIndex);
      if (r && r.success) {
        if (r.suspended) { t.status = 'paused'; t.speed = ''; }
        acted = true;
      }
    } catch (e) {}
  }
  for (const id of Object.keys(extractionJobs)) {
    if (hasSelection && !sel.has('ex:' + id)) continue;
    const j = extractionJobs[id];
    if (!j || j.paused) continue;
    try {
      const r = await window.api.extractionPause(id);
      if (r && r.success) { j.paused = true; acted = true; }
    } catch (e) {}
  }
  renderDownloadingList();
  renderExtractionTransferCards();
  updateTransferCounts();
  showToast(acted ? (hasSelection ? '已暂停选中任务' : '已暂停全部任务') : '没有可暂停的任务', acted ? 'success' : 'info');
}

async function resumeAllDownloads() {
  const sel = selectedTransferKeys.downloading;
  const hasSelection = sel.size > 0;
  const pausedAxel = activeDownloads.filter(d => d.status === 'paused' && (!hasSelection || sel.has(String(d.originalIndex))));
  const pausedEx = Object.keys(extractionJobs).filter((id) => extractionJobs[id] && extractionJobs[id].paused && (!hasSelection || sel.has('ex:' + id)));
  if (!pausedAxel.length && !pausedEx.length) {
    showToast('没有已暂停的任务', 'info');
    return;
  }
  pausedAxel.forEach((t) => { resumeSingleDownload(t.originalIndex); });
  pausedEx.forEach((id) => { resumeExtractionDownload(id); });
}

async function cancelAllDownloads() {
  const sel = selectedTransferKeys.downloading;
  const hasSelection = sel.size > 0;
  const targetAxel = hasSelection ? activeDownloads.filter(d => sel.has(String(d.originalIndex))) : [...activeDownloads];
  const targetExIds = hasSelection ? Object.keys(extractionJobs).filter(id => sel.has('ex:' + id)) : Object.keys(extractionJobs);
  if (!targetAxel.length && !targetExIds.length) {
    showToast('没有可取消的任务', 'info');
    return;
  }
  if (targetAxel.length) {
    const cancelSet = new Set(targetAxel.map(d => d.originalIndex));
    targetAxel.forEach((d) => { try { window.api.cancelDownload(d.originalIndex); } catch (e) {} });
    if (!hasSelection) {
      try { window.api.cancelAllDownloadsSignal(); } catch (e) {}
    }
    // 立即清理本地已暂停/未启动/排队中的任务卡片，确保点击全部取消立刻生效
    activeDownloads = activeDownloads.filter(d => !cancelSet.has(d.originalIndex));
  }
  for (const id of targetExIds) {
    try { await window.api.extractionCancel(id); } catch (e) {}
    delete extractionJobs[id];
  }
  sel.clear();
  const errorBox = document.getElementById('transferBatchError');
  if (errorBox && activeDownloads.length === 0) {
    errorBox.hidden = true;
    errorBox.textContent = '';
  }
  renderDownloadingList();
  renderExtractionTransferCards();
  updateTransferCounts();
  showToast(hasSelection ? '已取消选中任务' : '已取消全部任务', 'info');
}

function syncMaxConcurrentControls(value) {
  const select = document.getElementById('settingsMaxConcurrent');
  const customInput = document.getElementById('settingsMaxConcurrentCustom');
  const n = Math.max(1, parseInt(value, 10) || 3);
  maxConcurrentDownloadsSetting = n;
  if (!select) return;
  const preset = ['1', '2', '3', '4', '5'].includes(String(n));
  if (preset) {
    select.value = String(n);
    if (customInput) {
      customInput.style.display = 'none';
      customInput.value = '';
    }
  } else {
    select.value = 'custom';
    if (customInput) {
      customInput.style.display = 'inline-block';
      customInput.value = String(n);
    }
  }
}

async function persistMaxConcurrent(n) {
  maxConcurrentDownloadsSetting = Math.max(1, parseInt(n, 10) || 3);
  try {
    const settings = await window.api.getSettings();
    settings.maxConcurrent = maxConcurrentDownloadsSetting;
    await window.api.saveSettings(settings);
    showToast(`同时下载数量已修改为：${maxConcurrentDownloadsSetting}`, 'success');
  } catch (err) {
    console.error('保存并发设置失败:', err);
  }
}

async function changeMaxConcurrent(val) {
  const customInput = document.getElementById('settingsMaxConcurrentCustom');
  if (val === 'custom') {
    if (customInput) {
      customInput.style.display = 'inline-block';
      customInput.focus();
      if (!customInput.value) customInput.value = String(maxConcurrentDownloadsSetting || 3);
    }
    return;
  }
  if (customInput) customInput.style.display = 'none';
  await persistMaxConcurrent(val);
}

async function changeMaxConcurrentCustom(val) {
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n < 1) {
    showToast('请输入大于等于 1 的正整数', 'error');
    return;
  }
  syncMaxConcurrentControls(n);
  await persistMaxConcurrent(n);
}
window.changeMaxConcurrentCustom = changeMaxConcurrentCustom;

// Persist every transfer category, independently of the current login/network state.
var transfersReady = false;
var transferSaveTimer = null;
var lastTransferSnapshot = '';
var transferSaveErrorShown = false;

function transferSnapshot() {
  return {
    version: 2,
    completed: completedDownloads.map(({ md5Progress, ...item }) => item),
    failed: failedDownloads,
    active: activeDownloads.filter(t => !t.isUpdate).map(t => ({ ...t, targetDir: t.targetDir || defaultDir })),
    extraction: Object.values(extractionJobs).map(t => ({ ...t, saveDir: t.saveDir || defaultDir }))
  };
}

function syncTransfersToStorage() {
  if (!transfersReady) return;
  clearTimeout(transferSaveTimer); transferSaveTimer = null;
  const snapshot = transferSnapshot();
  const serialized = JSON.stringify(snapshot);
  if (serialized === lastTransferSnapshot) return;
  lastTransferSnapshot = serialized;
  try { localStorage.setItem('transfer_history_v2', serialized); } catch (_) {}
  if (window.api && window.api.saveTransfersHistory) {
    window.api.saveTransfersHistory(snapshot).catch(err => {
      lastTransferSnapshot = '';
      console.error('保存传输记录失败:', err.message);
      if (!transferSaveErrorShown) {
        transferSaveErrorShown = true;
        showToast('传输记录保存失败，请检查数据目录权限或剩余空间', 'error');
      }
    });
  }
}

function scheduleTransferSave() {
  if (transfersReady && !transferSaveTimer) transferSaveTimer = setTimeout(syncTransfersToStorage, 1000);
}

window.addEventListener('beforeunload', () => {
  if (!transfersReady) return;
  syncTransfersToStorage();
  // Electron waits for this synchronous acknowledgement before destroying the renderer.
  try {
    const result = window.api.flushTransfersHistory(transferSnapshot());
    if (result && typeof result.catch === 'function') result.catch(() => {});
  } catch (_) {}
});

async function loadTransferHistory(settings = {}) {
  if (transfersReady) return;
  let history;
  try {
    if (window.api && window.api.getTransfersHistory) history = await window.api.getTransfersHistory();
  } catch (e) { console.error('读取传输记录失败:', e.message); }
  // An existing empty file is authoritative: clearing history must not resurrect old localStorage data.
  if (!history || history.exists === false || (history.legacy && !history.completed.length && !history.failed.length && !history.active.length && !history.extraction.length)) {
    try {
      const cached = localStorage.getItem('transfer_history_v2');
      history = cached ? JSON.parse(cached) : {
        completed: JSON.parse(localStorage.getItem('completed_downloads') || '[]'),
        failed: JSON.parse(localStorage.getItem('failed_downloads') || '[]')
      };
    } catch (e) { console.error('读取备用传输记录失败:', e.message); }
  }
  const entries = key => Array.isArray(history && history[key]) ? history[key].filter(t => t && typeof t === 'object') : [];
  completedDownloads = entries('completed').map(({ md5Progress, ...item }) => item);
  failedDownloads = entries('failed');
  // Old process handles no longer exist. Restore unfinished work as paused without charging or starting it.
  const firstId = Date.now();
  activeDownloads = entries('active').filter(t => !t.isUpdate && !['completed','failed','cancelled'].includes(t.status)).map((t, i) => ({
    ...t, originalIndex: firstId + i, status: 'paused', speed: '',
    targetDir: t.targetDir || settings.defaultDir || '', restored: true
  }));
  extractionJobs = Object.fromEntries(entries('extraction').map((t, i) => {
    const id = 'restored-' + firstId + '-' + i;
    return [id, { ...t, id, paused: true, speed: '', saveDir: t.saveDir || settings.defaultDir || '', restored: true }];
  }));
  transfersReady = true;
}

// 载入历史与并发数
async function initTransfersAndSettings(settings) {
  await loadTransferHistory(settings || {});

  // 2. 载入并发数量设置
  if (settings && settings.maxConcurrent) {
    syncMaxConcurrentControls(settings.maxConcurrent);
  }

  lowPowerModeSetting = Boolean(settings && settings.lowPowerMode);
  const lowPowerToggle = document.getElementById('settingsLowPowerToggle');
  if (lowPowerToggle) lowPowerToggle.checked = lowPowerModeSetting;

  stableModeSetting = Boolean(settings && settings.stableMode);
  const stableModeToggle = document.getElementById('settingsStableModeToggle');
  if (stableModeToggle) stableModeToggle.checked = stableModeSetting;
  const deepIntegrityToggle = document.getElementById('settingsDeepIntegrityToggle');
  if (deepIntegrityToggle) deepIntegrityToggle.checked = Boolean(settings && settings.deepIntegrityCheck);
  for (const [group, value] of Object.entries({ http: 'native', bio: 'inherit', ftp: 'aria2', sftp: 'aria2', ftps: 'curl', ...settings?.downloadEngines })) {
    const select = document.getElementById('engine-' + group); if (select) select.value = value;
  }

  // 3. 载入诊断日志开关设置
  const toggle = document.getElementById('settingsLoggingToggle');
  if (toggle) {
    toggle.checked = (settings && settings.loggingEnabled) || false;
  }

  renderCompletedList();
  renderFailedList();
  renderDownloadingList();
  renderExtractionTransferCards();
  updateTransferCounts();
}

// ==========================================
// 【全局 IPC 进度监听事件绑定】
// ==========================================
function handleDownloadStatus(data) {
  const { index, status, fileName, savePath } = data;
  
  const queueIndex = currentQueue.findIndex(file => file.originalIndex === index);
  // 1. 更新下载中心的队列 UI
  const fill = document.getElementById(`progress-fill-${queueIndex}`);
  const pct = document.getElementById(`progress-pct-${queueIndex}`);
  const txt = document.getElementById(`status-text-${queueIndex}`);
  
  if (txt) {
    if (status === 'downloading') {
      txt.className = 'item-status status-downloading';
      txt.innerText = data.phase === 'verifying' ? '正在校验文件' : data.phase === 'preparing' ? '正在准备下载' : data.phase === 'connecting' ? '正在连接下载源' : '正在高速下载';
      if (data.speed) {
        const speedEl = document.getElementById(`speed-text-${queueIndex}`);
        if (speedEl) speedEl.innerText = data.speed;
      }
    } else if (status === 'completed') {
      txt.className = 'item-status status-completed';
      txt.innerText = data.verification && data.verification.status === 'mismatch' ? '已保存 · MD5 待核对' : data.verification && data.verification.status === 'unavailable' ? '已保存 · MD5 未核验' : '下载完成';
      if (fill) fill.style.width = '100%';
      if (pct) pct.innerText = '100%';
      const speedEl = document.getElementById(`speed-text-${queueIndex}`);
      if (speedEl) speedEl.innerText = data.speed || '已保存';
    } else if (status === 'failed') {
      txt.className = 'item-status status-failed';
      txt.innerText = '下载失败';
      const speedEl = document.getElementById(`speed-text-${queueIndex}`);
      if (speedEl) speedEl.innerText = data.speed || '下载失败';
    } else if (status === 'cancelled') {
      txt.className = 'item-status status-failed';
      txt.innerText = '已取消';
      const speedEl = document.getElementById(`speed-text-${queueIndex}`);
      if (speedEl) speedEl.innerText = '已取消';
    }
  }

  // 2. 更新传输中心的正在下载/已完成任务状态
  const activeItem = activeDownloads.find(d => d.originalIndex === index);
  if (activeItem) {
    activeItem.status = status;
    activeItem.phase = data.phase || null;
    if (data.md5) activeItem.md5 = data.md5;
    if (data.size > 0) activeItem.size = data.size;
    if (data.verification) activeItem.verification = data.verification;
    if (savePath) activeItem.savePath = savePath;
    if (data.engine) activeItem.engine = data.engine;
    if (data.backupPath) activeItem.backupPath = data.backupPath;
    if (data.redownloadPrepared) activeItem.redownloadMismatch = false;
    if (data.speed) activeItem.speed = data.speed;
    
    if (status === 'completed') {
      activeItem.percentage = 100;
      const completedItem = {
        name: activeItem.name,
        url: activeItem.url,
        size: activeItem.size,
        savePath: savePath || '',
        completedAt: new Date().toLocaleString(),
        skip: (data.speed && data.speed.includes('跳过')),
        folder: activeItem.folder,
        type: activeItem.type,
        md5: activeItem.md5, verification: activeItem.verification, engine: activeItem.engine, backupPath: activeItem.backupPath,
        fileObj: { name: activeItem.name, url: activeItem.url, size: activeItem.size, md5: activeItem.md5, folder: activeItem.folder, type: activeItem.type, originalIndex: activeItem.originalIndex, targetDir: activeItem.targetDir, redownloadMismatch: activeItem.redownloadMismatch, backupPath: activeItem.backupPath }
      };
      completedDownloads = completedDownloads.filter(item => !savePath || transferPathKey(item.savePath) !== transferPathKey(savePath));
      completedDownloads.unshift(completedItem);
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== index);
      renderCompletedList();
      renderDownloadingList();
    } else if (status === 'failed') {
      const failedItem = {
        name: activeItem.name,
        url: activeItem.url,
        size: activeItem.size,
        failedReason: data.speed || '网络连接超时 / 代理节点 502 Bad Gateway 报错',
        failedAt: new Date().toLocaleString(),
        originalIndex: activeItem.originalIndex,
        folder: activeItem.folder,
        type: activeItem.type,
        savePath: savePath || '', md5: activeItem.md5, verification: activeItem.verification, engine: activeItem.engine, backupPath: activeItem.backupPath,
        fileObj: { name: activeItem.name, url: activeItem.url, size: activeItem.size, md5: activeItem.md5, folder: activeItem.folder, type: activeItem.type, originalIndex: activeItem.originalIndex, targetDir: activeItem.targetDir, redownloadMismatch: activeItem.redownloadMismatch, backupPath: activeItem.backupPath }
      };
      failedDownloads.unshift(failedItem);
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== index);
      renderFailedList();
      renderDownloadingList();
      showToast(`文件 ${activeItem.name} 下载失败，已移至【下载失败】选项卡`, 'error');
    } else if (status === 'cancelled') {
      activeDownloads = activeDownloads.filter(d => d.originalIndex !== index);
      renderDownloadingList();
    } else if (status === 'paused') {
      // 暂停:卡片保留并切换为"恢复"形态(断点已保留)
      activeItem.status = 'paused';
      activeItem.speed = '';
      renderDownloadingList();
      showToast(`文件 ${activeItem.name} 已暂停,断点已保留`, 'info');
    } else {
      activeItem.status = status === 'waiting' ? 'waiting' : 'downloading';
      const transStatus = document.getElementById(`trans-status-${index}`);
      const transSpeed = document.getElementById(`trans-speed-${index}`);
      if (transStatus) {
        transStatus.innerText = status === 'waiting' ? '排队中...' : data.phase === 'verifying' ? '正在校验文件' : data.phase === 'preparing' ? '正在准备下载' : data.phase === 'connecting' ? '正在连接下载源' : '正在高速下载';
      }
      const etaEl = document.getElementById(`trans-eta-${index}`);
      if (etaEl && data.phase) etaEl.innerText = '';
      if (transSpeed && data.speed) {
        transSpeed.innerText = data.speed;
      }
    }
    updateTransferCounts();
  }
}
window.api.onDownloadStatus(handleDownloadStatus);

window.api.onDownloadProgress((data) => {
  const { index, percentage, speed, receivedBytes, totalBytes } = data;
  const queueIndex = currentQueue.findIndex(file => file.originalIndex === index);

  // 1. 更新下载中心的队列 UI
  if (percentage != null) {
    const fill = document.getElementById(`progress-fill-${queueIndex}`);
    const pct = document.getElementById(`progress-pct-${queueIndex}`);
    if (fill) fill.style.width = percentage + '%';
    if (pct) pct.innerText = percentage + '%';
  }
  if (speed != null) {
    const speedEl = document.getElementById(`speed-text-${queueIndex}`);
    if (speedEl) speedEl.innerText = '当前速度: ' + speed;
  }

  const queueStatus = document.getElementById(`status-text-${queueIndex}`);
  if (queueStatus) queueStatus.innerText = '正在高速下载';

  // 2. 更新传输中心 UI
  const activeItem = activeDownloads.find(d => d.originalIndex === index);
  if (activeItem) {
    if (percentage !== null && percentage !== undefined) {
      activeItem.percentage = percentage;
    }
    if (receivedBytes != null) {
      activeItem.receivedBytes = receivedBytes;
      activeItem.receivedBytesApproximate = Boolean(data.receivedBytesApproximate);
    }
    if (totalBytes != null) {
      activeItem.totalBytes = totalBytes;
    }
    if (data.engine) activeItem.engine = data.engine;
    activeItem.phase = 'transferring';
    const view = transferProgressView(activeItem);
    activeItem.percentage = view.percentage;
    const statusEl = document.getElementById(`trans-status-${index}`);
    if (statusEl && activeItem.status !== 'paused') statusEl.innerText = data.engine === 'native' && data.connections != null
      ? `下载中 · 当前并发上限 ${data.connections} / ${data.connectionLimit || 16}` : '正在高速下载';
    const fill = document.getElementById(`trans-progress-fill-${index}`);
    const sizeEl = document.getElementById(`trans-size-${index}`);
    const pctEl = document.getElementById(`trans-pct-${index}`);
    if (fill) fill.style.width = (activeItem.percentage || 0) + '%';
    if (pctEl) pctEl.innerText = (activeItem.percentage || 0) + '%';
    if (sizeEl) {
      const { total: totalSize, received: receivedSize } = view;
      sizeEl.innerText = (view.approximate ? '约 ' : '') + (totalSize > 0 ? `${formatBytes(receivedSize)} / ${formatBytes(totalSize)}` : formatBytes(receivedSize));
    }
    if (speed !== null && speed !== undefined) {
      activeItem.speed = speed;
      activeItem.lastSpeedUpdateAt = Date.now();
      const speedEl = document.getElementById(`trans-speed-${index}`);
      if (speedEl) speedEl.innerText = speed;
    }
    // 实时估算剩余时间(ETA)
    const etaEl = document.getElementById(`trans-eta-${index}`);
    if (etaEl) {
      const { total: totalSize, received: receivedSize } = view;
      etaEl.innerText = computeEta(totalSize > 0 ? totalSize - receivedSize : 0, activeItem.speed);
    }
    updateGlobalTotalSpeed();
    scheduleTransferSave();
  }
});

// External engines may go silent while reconnecting. Never leave their last
// non-zero speed painted indefinitely when no new progress has arrived.
if (typeof setInterval === 'function') setInterval(() => {
  let changed = false;
  for (const item of activeDownloads) {
    if (item.lastSpeedUpdateAt && Date.now() - item.lastSpeedUpdateAt > 3000 && parseSpeedToBytes(item.speed) > 0) {
      item.speed = '0 B/s';
      const speed = document.getElementById(`trans-speed-${item.originalIndex}`);
      const eta = document.getElementById(`trans-eta-${item.originalIndex}`);
      if (speed) speed.innerText = '0 B/s';
      if (eta) eta.innerText = '';
      changed = true;
    }
  }
  if (changed) updateGlobalTotalSpeed();
}, 1000);

// 绑定到 window 暴露给 HTML 属性
window.toggleMoreMenu = toggleMoreMenu;
window.selectMoreType = selectMoreType;
window.openDownloadsDirectory = openDownloadsDirectory;
window.switchTransferSubTab = switchTransferSubTab;
window.changeMaxConcurrent = changeMaxConcurrent;
window.openCompletedRecord = openCompletedRecord;
window.openCompletedFile = openCompletedFile;
window.deleteCompletedRecord = deleteCompletedRecord;
window.clearCompletedDownloads = clearCompletedDownloads;
window.deleteFailedRecord = deleteFailedRecord;
window.clearFailedDownloads = clearFailedDownloads;
window.retryFailedDownload = retryFailedDownload;
window.retryAllFailedDownloads = retryAllFailedDownloads;
window.cancelSingleDownload = cancelSingleDownload;
window.pauseSingleDownload = pauseSingleDownload;
window.resumeSingleDownload = resumeSingleDownload;
window.pauseAllDownloads = pauseAllDownloads;
window.resumeAllDownloads = resumeAllDownloads;
window.cancelAllDownloads = cancelAllDownloads;
window.cancelDownload = cancelDownload;
window.changeTransferPage = changeTransferPage;
window.onTransferSearch = onTransferSearch;
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

async function toggleLowPowerMode(checked) {
  try {
    lowPowerModeSetting = Boolean(checked);
    await window.api.saveSettings({ lowPowerMode: lowPowerModeSetting });
    showToast(lowPowerModeSetting
      ? '已开启低功耗模式：单文件最多16线程、全任务最多32连接'
      : '已恢复正常模式：单文件最高32线程、全任务最高64连接');
    if (currentQueue.length) renderQueue();
  } catch (err) {
    console.error('Failed to toggle low power mode:', err);
  }
}

async function toggleStableMode(checked) {
  try {
    stableModeSetting = Boolean(checked);
    await window.api.saveSettings({ stableMode: stableModeSetting });
    showToast(stableModeSetting
      ? '已开启稳定下载模式：强制单线程单连接'
      : '已关闭稳定下载模式');
    if (currentQueue.length) renderQueue();
  } catch (err) {
    console.error('Failed to toggle stable mode:', err);
  }
}

async function saveDownloadEngines() {
  const downloadEngines = {};
  for (const group of ['http', 'bio', 'ftp', 'sftp', 'ftps']) downloadEngines[group] = document.getElementById('engine-' + group).value;
  try { await window.api.saveSettings({ downloadEngines }); showToast('下载器设置已保存，新任务生效；已有断点继续使用原下载器'); }
  catch (error) { showToast('保存失败：' + error.message, 'error'); }
}

async function toggleDeepIntegrityCheck(checked) {
  try {
    await window.api.saveSettings({ deepIntegrityCheck: Boolean(checked) });
    showToast(checked ? '下一批任务将进行完整 MD5 校验；已有文件请到传输列表 → 已完成 → 校验 MD5' : '下一批任务使用快速检查，不读取整个文件计算 MD5');
  } catch (error) {
    const toggle = document.getElementById('settingsDeepIntegrityToggle');
    if (toggle) toggle.checked = !checked;
    showToast('保存检查设置失败：' + error.message, 'error');
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
window.toggleLowPowerMode = toggleLowPowerMode;
window.toggleStableMode = toggleStableMode;
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

let currentRealNodeCount = 0;
let currentNodeTier = null;

function updateNodeCountUI(count, tier) {
  if (typeof count === 'number' && count > 0) {
    currentRealNodeCount = count;
  }
  if (tier === 1 || tier === 2 || tier === 3) {
    currentNodeTier = tier;
  }
  const textEl = document.getElementById('btnOptimizeConnText');
  if (textEl) {
    if (currentRealNodeCount > 0) {
      const tierLabel = currentNodeTier === 1 ? '一级节点'
        : currentNodeTier === 2 ? '二级节点'
        : currentNodeTier === 3 ? '三级节点'
        : '目前节点';
      textEl.innerText = `⚡ 优化连接 (${tierLabel}${currentRealNodeCount})`;
    } else {
      textEl.innerText = `⚡ 优化连接`;
    }
  }
}

function setClashValidationProgress(data) {
  const wrap = document.getElementById('clashValidationProgress');
  const fill = document.getElementById('clashValidationProgressFill');
  if (!wrap || !fill) return;
  const total = Number(data && data.total) || 0;
  const completed = Number(data && data.completed) || 0;
  const pct = total > 0 ? Math.min(100, Math.round(completed * 100 / total)) : 0;
  wrap.style.display = 'block';
  fill.style.width = pct + '%';
  if (typeof data?.passed === 'number' && data.passed > 0) updateNodeCountUI(data.passed, data.tier);
  if (data && data.done) {
    setTimeout(() => {
      wrap.style.display = 'none';
      fill.style.width = '0%';
    }, 350);
  }
}

function resetClashValidationProgress() {
  const wrap = document.getElementById('clashValidationProgress');
  const fill = document.getElementById('clashValidationProgressFill');
  if (fill) fill.style.width = '0%';
  if (wrap) wrap.style.display = 'none';
}

// 优化连接/刷新通道方法
async function optimizeConnections() {
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return;
  if (!currentUser || !currentUser.token) {
    showToast('请先登录账户后再执行优化连接', 'error');
    switchTab('profile-tab');
    return;
  }

  const btn = document.getElementById('btnOptimizeConn');
  const textEl = document.getElementById('btnOptimizeConnText');
  if (btn) {
    btn.disabled = true;
    if (textEl) textEl.innerText = '⏳ 正在优化网络通道...';
  }
  resetClashValidationProgress();
  const progressWrap = document.getElementById('clashValidationProgress');
  if (progressWrap) progressWrap.style.display = 'block';

  try {
    const res = await window.api.optimizeClash(currentUser.token);
    if (res.success) {
      if (res.nodeCount) updateNodeCountUI(res.nodeCount, res.nodeTier);
      const tierNotice = res.nodeTier === 2
        ? `优秀节点较少，已自动放宽启用 ${res.nodeCount} 个二级连接节点`
        : res.nodeTier === 3
          ? `当前网络受限，已放宽启用 ${res.nodeCount} 个三级保底节点`
          : (res.message || `网络通道优化成功（已优选 ${res.nodeCount || currentRealNodeCount} 个一级节点）`);
      showToast(tierNotice, 'success');
    }
  } catch (err) {
    showToast('连接优化失败: ' + (err.message || '未知错误'), 'error');
    resetClashValidationProgress();
  } finally {
    if (btn) {
      btn.disabled = false;
    }
    updateNodeCountUI();
  }
}

window.optimizeConnections = optimizeConnections;

// ============================================================================
// 【2.0.0 引导式提取 (User-Guided Extraction)】
// 内置浏览器导航 + 资源嗅探侧边栏 + 代码框 + 拦截下载并入传输列表
// ============================================================================
const EXTRACTION_SITES = [
  {
    icon: '🧬', name: 'NCBI', url: 'https://www.ncbi.nlm.nih.gov',
    desc: '检索序列后点 Send to / 下载，自动转 efetch 分页下载并校验完整性，会话过期有提示。',
    example: '1. 打开 ncbi.nlm.nih.gov，搜索基因/序列（如 NDM-1）\n2. 勾选结果 → Send to → File → 选格式(GenBank/FASTA) → Create File\n3. 本工具自动拦截并转为 efetch 分页下载（可断点续传、核对记录数）\n4. 若提示会话过期：点右上角🧹清除会话，重新登录后再操作'
  },
  {
    icon: '🔬', name: 'Broad Single Cell', url: 'https://singlecell.broadinstitute.org',
    desc: '单细胞研究批量下载：把网页 Download 给出的 curl 配置代码粘到右侧代码框执行。',
    example: '1. 打开研究页，例如 SCP259\n2. 点 Download，会得到形如：\n   curl "https://singlecell.broadinstitute.org/single_cell/api/v1/bulk_download/generate_curl_config?accessions=SCP259&auth_code=xxxx&directory=all&context=study" -o cfg.txt; curl -K cfg.txt && rm cfg.txt\n3. 复制整段 → 右侧代码框 → 执行下载（逐文件、断点续传）\n4. auth_code 过期时按提示回网页重新 Download 复制'
  },
  {
    icon: '🌐', name: '通用网站', url: 'https://example.com',
    desc: '任意网站：真实下载自动拦截转入下载器；右侧列出嗅探到的媒体/数据资源，点击即下。',
    example: '在内置浏览器打开任意网站并正常操作：\n• 触发的下载会被自动拦截 → 传输列表（多线程+断点续传）\n• 右侧「资源嗅探」列出 png/mp4 及数据文件(gz/csv/h5ad…)\n• 重要资源加粗红字置顶，点击即可下载\n• 注意：有 Cookie 次数限制的网站勿高频重复请求'
  }
];
let extractionResources = [];
let extractionInited = false;

function getExtractionWebview() { return document.getElementById('extractionWebview'); }

function initExtraction() {
  if (extractionInited) return;
  extractionInited = true;
  renderExtractionSites();
  window.api.onExtractionEvent(handleExtractionEvent);
  const wv = getExtractionWebview();
  if (wv) {
    wv.addEventListener('did-navigate', (e) => { const inp = document.getElementById('extractionUrlInput'); if (inp) inp.value = e.url; });
    wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) { const inp = document.getElementById('extractionUrlInput'); if (inp) inp.value = e.url; } });
    wv.addEventListener('did-fail-load', (e) => { if (e.errorCode && e.errorCode !== -3) showToast('页面加载失败: ' + (e.errorDescription || e.errorCode), 'error'); });
  }
}

function renderExtractionSites() {
  const box = document.getElementById('extractionSites');
  if (!box) return;
  box.innerHTML = EXTRACTION_SITES.map((s, i) => `
    <div class="ex-site-card" data-i="${i}">
      <div class="ex-site-name"><span>${s.icon}</span><span>${escapeHtml(s.name)}</span><span class="ex-site-open">打开 ›</span></div>
      <div class="ex-site-desc">${escapeHtml(s.desc)}</div>
      <div class="ex-site-example">${escapeHtml(s.example)}</div>
    </div>`).join('');
  box.querySelectorAll('.ex-site-card').forEach((el) => {
    const s = EXTRACTION_SITES[parseInt(el.dataset.i, 10)];
    el.querySelector('.ex-site-open').onclick = (e) => { e.stopPropagation(); document.getElementById('extractionUrlInput').value = s.url; extractionGo(); };
    el.onclick = () => el.classList.toggle('open');
  });
}

function extractionGo() {
  const inp = document.getElementById('extractionUrlInput');
  let url = (inp.value || '').trim();
  if (!url) { showToast('请输入网址', 'error'); return; }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  inp.value = url;
  const wv = getExtractionWebview();
  document.getElementById('extractionStartpage').style.display = 'none';
  wv.style.display = 'block';
  wv.loadURL(url);
}
function extractionHome() {
  const wv = getExtractionWebview();
  wv.style.display = 'none';
  document.getElementById('extractionStartpage').style.display = 'block';
  const inp = document.getElementById('extractionUrlInput'); if (inp) inp.value = '';
  try { wv.stop(); } catch (e) {}
}
function extractionBack() { try { const wv = getExtractionWebview(); if (wv.canGoBack()) wv.goBack(); } catch (e) {} }
function extractionForward() { try { const wv = getExtractionWebview(); if (wv.canGoForward()) wv.goForward(); } catch (e) {} }
function extractionReload() { try { getExtractionWebview().reload(); } catch (e) {} }
async function extractionClearCookies() {
  const r = await window.api.extractionClearSession();
  showToast(r && r.success ? '已清除内置浏览器会话，请重新登录以刷新 Token' : '清除失败', 'success');
}

// ---- 资源嗅探侧边栏 ----
function addExtractionResource(r) {
  if (!r || !r.url) return;
  if (extractionResources.some((x) => x.url === r.url)) return;
  extractionResources.push({ url: r.url, name: r.name || r.url, important: !!r.important, site: r.site || 'generic', label: r.label || '', resourceType: r.resourceType || '' });
  if (extractionResources.length > 300) extractionResources.shift();
  renderExtractionResources();
}
function renderExtractionResources() {
  const box = document.getElementById('extractionResources');
  if (!box) return;
  const sorted = [...extractionResources].sort((a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0));
  if (!sorted.length) {
    box.innerHTML = '<div class="ex-empty">浏览网页后，这里会列出可下载资源。<br>重要资源会<b style="color:#ef4444">加粗红字</b>置顶，点击即可下载。</div>';
    return;
  }
  box.innerHTML = sorted.map((r, i) => `
    <div class="ex-res-item ${r.important ? 'important' : ''}" data-i="${i}">
      <span class="ex-res-name">${escapeHtml(r.name)}</span>
      <span class="ex-res-meta">${r.important ? '★ ' : ''}${escapeHtml(r.label || r.site)} · ${escapeHtml(r.resourceType)}</span>
    </div>`).join('');
  box.querySelectorAll('.ex-res-item').forEach((el) => {
    const r = sorted[parseInt(el.dataset.i, 10)];
    el.onclick = () => extractionDownloadResource(r.url, r.name);
  });
}
async function extractionDownloadResource(url, name) {
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return;
  showToast('已加入下载：' + (name || url), 'info');
  try { await window.api.extractionDownload({ url, name, saveDir: defaultDir }); } catch (e) { showToast('启动下载失败: ' + e.message, 'error'); }
}

// ---- 代码框 ----
async function extractionRunCode() {
  const ta = document.getElementById('extractionCodeInput');
  const code = (ta.value || '').trim();
  if (!code) { showToast('请粘贴下载代码（cURL 或 Broad 配置）', 'error'); return; }
  showToast('正在解析并启动下载…', 'info');
  try {
    const res = await window.api.extractionRunCode(code, defaultDir);
    if (res && res.success) showToast(res.mode === 'broad' ? `Broad 批量下载完成 ${res.count}/${res.total}，见传输列表` : '下载任务已启动，见传输列表', 'success');
    else showToast((res && res.error) || '执行失败', 'error');
  } catch (e) { showToast('执行失败: ' + e.message, 'error'); }
}

// ---- 拦截/嗅探下载事件 → 传输列表 ----
function handleExtractionEvent(d) {
  // 主窗口只负责把拦截/代码框/嗅探点击的下载送进「传输列表」;资源嗅探与日志由独立弹窗处理
  if (!d || d.type !== 'download') return;
  return handleExtractionDownload(d);
}
function handleExtractionDownload(d) {
  const id = d.id;
  if (d.status === 'started') {
    if (d.replacesId) delete extractionJobs[d.replacesId];
    extractionJobs[id] = { id, name: d.name || '下载', url: d.url || '', size: d.size || 0, received: 0, total: d.size || 0, percentage: 0, speed: '连接中…', eta: '', title: d.title || '', saveDir: d.saveDir || defaultDir, paused: false };
    renderExtractionTransferCards();
    updateTransferCounts();
    return;
  }
  if (d.status === 'cancelled') {
    // 用户主动取消:直接移除卡片,不进失败列表(可能已被按钮先行移除,幂等处理)
    delete extractionJobs[id];
    const card = document.getElementById('ex-card-' + id); if (card) card.remove();
    renderExtractionTransferCards(); updateTransferCounts();
    return;
  }
  const j = extractionJobs[id];
  if (d.status === 'progress') {
    if (!j || j.paused) return;
    if (d.percentage != null) j.percentage = d.percentage;
    if (d.speed) j.speed = d.speed;
    if (d.name) j.name = d.name;
    if (d.saveDir) j.saveDir = d.saveDir;
    if (d.received != null) j.received = d.received;
    if (d.total != null) j.total = d.total;
    j.eta = (d.speedBps > 0 && j.total > 0 && j.received < j.total) ? formatEta((j.total - j.received) / d.speedBps) : '';
    const fill = document.getElementById('ex-fill-' + id); if (fill) fill.style.width = (j.percentage || 0) + '%';
    const pct = document.getElementById('ex-pct-' + id); if (pct) pct.innerText = (j.percentage || 0) + '%';
    const sp = document.getElementById('ex-speed-' + id); if (sp) sp.innerText = j.speed;
    const eta = document.getElementById('ex-eta-' + id); if (eta) eta.innerText = j.eta;
    const sz = document.getElementById('ex-size-' + id);
    if (sz) sz.innerText = j.total > 0 ? `${formatBytes(j.received)} / ${formatBytes(j.total)}` : formatBytes(j.received || 0);
    const st = document.getElementById('ex-status-' + id); if (st) st.innerText = '引导式提取 · 下载中';
    updateGlobalTotalSpeed();
    scheduleTransferSave();
    return;
  }
  if (d.status === 'completed') {
    const rec = { name: d.name || (j && j.name) || '下载', url: (j && j.url) || '', size: d.size || (j && j.size) || 0, savePath: d.savePath || '', completedAt: new Date().toLocaleString(), skip: false, folder: '', type: 'extraction', fileObj: {} };
    completedDownloads.unshift(rec);
    delete extractionJobs[id];
    const card = document.getElementById('ex-card-' + id); if (card) card.remove();
    renderCompletedList(); renderExtractionTransferCards(); updateTransferCounts();
    showToast('下载完成: ' + rec.name, 'success');
    if (d.warn) showToast(d.warn.trim(), 'error');
    return;
  }
  if (d.status === 'failed') {
    // 暂停(中断流保留断点)也走 failed 通道,但特殊标记为"已暂停"而不是失败
    if (d.message === 'PAUSED' && j) {
      j.paused = true;
      j.speed = '';
      renderExtractionTransferCards();
      updateTransferCounts();
      showToast('已暂停,断点已保留,可随时恢复续传', 'success');
      return;
    }
    if (!j) { // 卡片可能已因取消被移除:迟到的失败事件直接丢弃
      const card = document.getElementById('ex-card-' + id); if (card) card.remove();
      return;
    }
    const rec = { name: (j && j.name) || '下载', url: (j && j.url) || '', size: (j && j.size) || 0, failedReason: d.message || '下载失败', failedAt: new Date().toLocaleString(), saveDir: j.saveDir, folder: '', type: 'extraction', fileObj: {} };
    failedDownloads.unshift(rec);
    delete extractionJobs[id];
    const card = document.getElementById('ex-card-' + id); if (card) card.remove();
    renderFailedList(); renderExtractionTransferCards(); updateTransferCounts();
    showToast(d.message || '下载失败', 'error');
  }
}
function renderExtractionTransferCards() {
  const container = document.getElementById('transferDownloadingList');
  if (!container) return;
  container.querySelectorAll('.transfer-item-ex').forEach((c) => c.remove());
  const emptyState = document.getElementById('emptyDownloadingState');
  const ids = Object.keys(extractionJobs);
  if ((ids.length || activeDownloads.length) && emptyState) emptyState.style.display = 'none';
  if (!ids.length && emptyState && activeDownloads.length === 0) emptyState.style.display = 'flex';
  ids.filter((id) => matchesTransferSearch(extractionJobs[id].name)).forEach((id) => {
    const j = extractionJobs[id];
    const paused = !!j.paused;
    const percentage = Math.min(100, j.percentage || 0);
    const sizeText = j.total > 0 ? `${formatBytes(j.received)} / ${formatBytes(j.total)}` : formatBytes(j.received || j.size || 0);
    const el = document.createElement('div');
    el.className = 'transfer-item tl-card transfer-item-ex' + (paused ? ' tl-paused' : '');
    el.id = 'ex-card-' + id;
    el.dataset.url = j.url || '';
    el.dataset.status = paused ? 'paused' : 'downloading';
    el.dataset.ex = '1';
    el.dataset.jobid = id;
    el.innerHTML = `
      <input type="checkbox" class="tl-select-checkbox" ${typeof selectedTransferKeys !== 'undefined' && selectedTransferKeys.downloading.has('ex:' + id) ? 'checked' : ''} onchange="toggleTransferItemSelection('downloading', 'ex:${escapeJsArg(id)}', this.checked)" title="勾选此任务">
      <div class="tl-icon">${getFileTypeIcon(j.name, j.url)}</div>
      <div class="tl-body">
        <div class="transfer-item-name-row">
          <span class="transfer-item-name">${escapeHtml(j.name)}</span>
          <span class="transfer-item-badge">${j.title ? escapeHtml(j.title) : getFileTypeBadge(j.url)}</span>
        </div>
        <div class="tl-progress-row">
          <div class="transfer-progress-bar"><div class="transfer-progress-fill${paused ? ' paused' : ''}" id="ex-fill-${id}" style="width: ${percentage}%"></div></div>
          <span class="tl-pct" id="ex-pct-${id}">${percentage}%</span>
        </div>
        <div class="transfer-item-meta">
          <span class="transfer-item-size" id="ex-size-${id}">${sizeText}</span>
          <span class="transfer-item-speed" id="ex-speed-${id}">${paused ? '—' : escapeHtml(j.speed || '')}</span>
          <span class="tl-eta" id="ex-eta-${id}">${paused ? '' : escapeHtml(j.eta || '')}</span>
          <span class="transfer-item-status${paused ? ' paused' : ''}" id="ex-status-${id}">${paused ? '已暂停 · 可续传' : '引导式提取 · 下载中'}</span>
        </div>
      </div>
      <div class="tl-actions">
        ${paused
          ? `<button class="tl-btn primary" title="恢复下载(断点续传)" onclick="resumeExtractionDownload('${id}')">▶</button>`
          : `<button class="tl-btn" title="暂停下载(保留断点)" onclick="pauseExtractionDownload('${id}')">⏸</button>`}
        <button class="tl-btn danger" title="取消任务" onclick="cancelExtractionDownload('${id}')">✕</button>
      </div>`;
    container.appendChild(el);
  });
  if (typeof syncTransferSelectionUI === 'function') syncTransferSelectionUI();
}
async function pauseExtractionDownload(id) {
  const j = extractionJobs[id];
  if (!j) return;
  if (j.paused) { resumeExtractionDownload(id); return; }
  try {
    const r = await window.api.extractionPause(id);
    if (r && r.success) {
      // 原生下载引擎返回 paused:true 且不再发事件 → 这里置暂停态并提示;
      // axios 流式下载 abort 后还会回传 'PAUSED' failed 事件,由 handleExtractionDownload 统一置态并提示(避免双 toast)
      j.paused = true;
      j.speed = '';
      renderExtractionTransferCards();
      updateTransferCounts();
      if (r.paused === true) showToast('已暂停,断点已保留,可随时恢复续传', 'success');
    } else {
      showToast((r && r.error) || '暂停失败', 'error');
    }
  } catch (e) {
    showToast('暂停失败: ' + e.message, 'error');
  }
}
async function resumeExtractionDownload(id) {
  if (resumingExtractionIds.has(id)) return;
  resumingExtractionIds.add(id);
  try { await resumeExtractionJob(id); }
  finally { resumingExtractionIds.delete(id); }
}
async function resumeExtractionJob(id) {
  const j = extractionJobs[id];
  if (!j) return;
  if (!j.paused) { pauseExtractionDownload(id); return; }
  try {
    // 原生 DownloadItem 的暂停 → 再次调用 pause 即恢复(toggle),返回 paused:false
    const r = await window.api.extractionPause(id);
    if (r && r.success && r.paused === false) {
      j.paused = false;
      j.speed = '连接中…';
      renderExtractionTransferCards();
      updateTransferCounts();
      showToast('已恢复下载', 'success');
      return;
    }
  } catch (e) {}
  // Restore the same acceleration path after restarting the application.
  if (!(await ensureTransferConnection())) return;
  const url = j.url, name = j.name;
  if (url) {
    try {
      const result = await window.api.extractionDownload({ url, name, saveDir: j.saveDir || defaultDir, size: j.total || j.size, replacesId: id });
      if (result && result.success === false) throw new Error(result.error || '下载未完成，请查看传输列表');
    } catch (e) {
      showToast('恢复失败: ' + e.message, 'error');
    }
  }
}
async function cancelExtractionDownload(id) {
  try {
    const r = await window.api.extractionCancel(id);
    if (r && r.success) {
      delete extractionJobs[id];
      const card = document.getElementById('ex-card-' + id); if (card) card.remove();
      renderExtractionTransferCards();
      updateTransferCounts();
      showToast('任务已取消,未完成文件已清理', 'info');
    } else {
      showToast((r && r.error) || '取消失败', 'error');
    }
  } catch (e) {
    showToast('取消失败: ' + e.message, 'error');
  }
}

window.extractionGo = extractionGo;
window.extractionHome = extractionHome;
window.extractionBack = extractionBack;
window.extractionForward = extractionForward;
window.extractionReload = extractionReload;
window.extractionClearCookies = extractionClearCookies;
window.pauseExtractionDownload = pauseExtractionDownload;
window.resumeExtractionDownload = resumeExtractionDownload;

// ==========================================
// 【扩展插件生态管理】
// ==========================================
async function refreshPluginsList() {
  const container = document.getElementById('pluginsListContainer');
  if (!container || !window.api || !window.api.getPluginStatus) return;

  container.innerHTML = `
    <div style="text-align:center; padding:2rem; color:var(--text-muted);">
      <div style="display:inline-block; animation:spin 1s linear infinite; font-size:1.5rem; margin-bottom:0.5rem;">⏳</div>
      <div>正在检测插件运行环境与依赖完整性...</div>
    </div>
  `;

  try {
    const res = await window.api.getPluginStatus();
    const plugins = (res && res.plugins) || [];
    if (plugins.length === 0) {
      container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:1.5rem;">暂无可用的扩展插件</div>';
      return;
    }

    container.innerHTML = plugins.map(p => {
      const isOk = p.installed && p.usable;
      const isSsh = p.id === 'ssh';
      const statusBadge = isOk
        ? `<span style="background:rgba(16, 185, 129, 0.15); color:#10b981; border:1px solid rgba(16, 185, 129, 0.3); padding:0.25rem 0.6rem; border-radius:6px; font-size:0.8rem; font-weight:700; display:flex; align-items:center; gap:0.25rem;">✅ 已就绪 (v${escapeHtml(p.version)})</span>`
        : (p.installed
            ? `<span style="background:rgba(239, 68, 68, 0.15); color:#ef4444; border:1px solid rgba(239, 68, 68, 0.3); padding:0.25rem 0.6rem; border-radius:6px; font-size:0.8rem; font-weight:700; display:flex; align-items:center; gap:0.25rem;">⚠️ 依赖缺失或异常</span>`
            : `<span style="background:rgba(156, 163, 175, 0.15); color:var(--text-muted); border:1px solid var(--border-color); padding:0.25rem 0.6rem; border-radius:6px; font-size:0.8rem; font-weight:600; display:flex; align-items:center; gap:0.25rem;">⭕ ${isSsh ? '未安装启用' : '未安装'}</span>`);

      const actionBtn = isSsh
        ? (isOk
            ? `<button class="btn btn-primary" id="sshPluginOpenBtn" onclick="openSshPanel()" style="font-size:0.8rem; padding:0.35rem 0.85rem;">⚙️ 配置 SSH 连接 →</button>
               <button class="btn btn-secondary" onclick="refreshPluginsList()" style="font-size:0.8rem; padding:0.35rem 0.8rem;">🔄 重新检测</button>`
            : `<button class="btn btn-primary" id="sshPluginInstallBtn" onclick="handleInstallPlugin('ssh', this)" style="font-size:0.8rem; padding:0.35rem 0.85rem;">➕ 安装并启用扩展</button>`)
        : (isOk
            ? `<button class="btn btn-secondary" onclick="refreshPluginsList()" style="font-size:0.8rem; padding:0.35rem 0.8rem;">🔄 重新检测</button>`
            : (p.installed
                ? `<button class="btn btn-primary" onclick="handleInstallPlugin('${escapeHtml(p.id)}', this)" style="font-size:0.8rem; padding:0.35rem 0.8rem; background:#d97706; border:none;">🛠️ 修复并覆盖更新</button>`
                : `<button class="btn btn-primary" onclick="handleInstallPlugin('${escapeHtml(p.id)}', this)" style="font-size:0.8rem; padding:0.35rem 0.8rem;">📥 立即下载并安装</button>`));

      return `
        <div data-plugin-id="${escapeHtml(p.id)}" style="background:var(--bg-input); border:1px solid var(--border-color); border-radius:10px; padding:1.1rem 1.25rem; display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:1rem;">
          <div style="flex:1; min-width:240px;">
            <div style="display:flex; align-items:center; gap:0.6rem; margin-bottom:0.4rem; flex-wrap:wrap;">
              <span style="font-weight:700; font-size:0.95rem; color:var(--text-primary);">${escapeHtml(p.name)}</span>
              ${statusBadge}
            </div>
            <div style="font-size:0.82rem; color:var(--text-muted); line-height:1.45; margin-bottom:0.4rem;">${escapeHtml(p.description)}</div>
            <div style="font-size:0.75rem; color:var(--text-muted); font-family:monospace; overflow-wrap:anywhere;">
              <span>平台: ${escapeHtml(p.platform)}</span>
              ${p.source ? `<span style="margin-left:0.8rem;">来源: ${escapeHtml({bundled:'软件内置',system:'系统 PATH',custom:'用户指定'}[p.source] || p.source)}</span>` : ''}
              ${p.path ? `<span style="margin-left:0.8rem;">路径: ${escapeHtml(p.path)}</span>` : ''}
            </div>
            ${p.errorDetail ? `<div style="margin-top:0.4rem; padding:0.4rem 0.6rem; background:rgba(239, 68, 68, 0.1); border-radius:4px; font-size:0.75rem; color:#ef4444; font-family:monospace; word-break:break-all;">报错原因: ${escapeHtml(p.errorDetail)}</div>` : ''}
            ${p.internal || p.noCustomPath ? '' : `<div style="display:flex; gap:0.5rem; margin-top:0.7rem; align-items:center; flex-wrap:wrap;">
              <input id="pluginPath-${escapeHtml(p.id)}" type="text" placeholder="填写 ${escapeHtml(p.id === 'axel' ? 'axel' : p.id === 'curl' ? 'curl' : 'aria2c')} 可执行文件绝对路径" style="flex:1; min-width:260px; padding:0.5rem 0.65rem; font-size:0.78rem;">
              <button class="btn btn-secondary" onclick="handleSetPluginPath('${escapeHtml(p.id)}', this)" style="font-size:0.78rem; padding:0.4rem 0.7rem;">使用此路径</button>
            </div>`}
          </div>
          <div style="display:flex; align-items:center; gap:0.5rem;flex-wrap:wrap;">
            ${['native','aria2','axel'].includes(p.id) ? `<button class="btn ${res.defaultEngine === p.id ? 'btn-secondary' : 'btn-primary'}" data-primary-engine="${p.id}" onclick="setPrimaryDownloader('${p.id}')" ${res.defaultEngine === p.id || !isOk ? 'disabled' : ''}>${res.defaultEngine === p.id ? '当前主力下载器' : '设为主力下载器'}</button>` : ''}
            ${p.internal ? '' : actionBtn}
          </div>
        </div>
      `;
    }).join('');

  } catch (err) {
    container.innerHTML = `
      <div style="padding:1.5rem; text-align:center; color:#ef4444; background:rgba(239, 68, 68, 0.08); border-radius:8px;">
        <div>❌ 获取插件状态失败: ${escapeHtml(err.message)}</div>
        <button class="btn btn-secondary" onclick="refreshPluginsList()" style="margin-top:0.75rem; font-size:0.8rem;">重试</button>
      </div>
    `;
  }
}

async function handleInstallPlugin(pluginId, btnEl) {
  if (!window.api || !window.api.installPlugin) return;
  const isSsh = pluginId === 'ssh';
  const originalText = btnEl ? btnEl.innerHTML : '';
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.innerHTML = isSsh ? '⏳ 正在启用扩展...' : '⏳ 正在下载安装...';
  }
  showToast(isSsh ? '正在校验内置 SSH 组件并启用扩展...' : '正在下载并配置插件...', 'info');
  try {
    const res = await window.api.installPlugin(pluginId);
    if (res && res.success) {
      showToast(isSsh ? 'SSH 远程连接扩展已启用，可点击配置使用！' : '插件安装就绪并校验通过！', 'success');
      await refreshPluginsList();
    } else {
      showToast('安装失败', 'error');
    }
  } catch (e) {
    showToast('插件安装出错: ' + e.message, 'error');
  } finally {
    if (btnEl) {
      btnEl.disabled = false;
      btnEl.innerHTML = originalText;
    }
  }
}

async function handleSetPluginPath(pluginId, btnEl) {
  const input = document.getElementById(`pluginPath-${pluginId}`);
  const binaryPath = input ? input.value.trim() : '';
  if (!binaryPath) return showToast('请填写可执行文件绝对路径', 'error');
  if (btnEl) btnEl.disabled = true;
  try {
    const res = await window.api.setPluginPath(pluginId, binaryPath);
    showToast(`路径验证成功${res.version ? ` (v${res.version})` : ''}`, 'success');
    await refreshPluginsList();
  } catch (e) {
    showToast('路径验证失败: ' + e.message, 'error');
  } finally {
    if (btnEl) btnEl.disabled = false;
  }
}

window.openDeleteTransferModal = openDeleteTransferModal;
window.closeDeleteTransferModal = closeDeleteTransferModal;
window.confirmDeleteTransfer = confirmDeleteTransfer;
window.toggleTransferItemSelection = toggleTransferItemSelection;
window.toggleSelectAllTransfers = toggleSelectAllTransfers;
window.refreshPluginsList = refreshPluginsList;
window.handleInstallPlugin = handleInstallPlugin;
window.handleSetPluginPath = handleSetPluginPath;
window.cancelExtractionDownload = cancelExtractionDownload;
window.extractionRunCode = extractionRunCode;
window.extractionDownloadResource = extractionDownloadResource;

async function setPrimaryDownloader(engine) {
  if (!['native', 'aria2', 'axel'].includes(engine)) return;
  try {
    const settings = await window.api.getSettings();
    await window.api.saveSettings({ downloadEngineSchema: 2, downloadEngines: { ...settings.downloadEngines, http: engine, bio: 'inherit' } });
    for (const [group, value] of Object.entries((await window.api.getSettings()).downloadEngines)) { const select = document.getElementById('engine-' + group); if (select) select.value = value; }
    await refreshPluginsList();
    showToast('已切换主力下载器；新任务生效，已有断点仍由原内核恢复');
  } catch (error) { showToast('切换失败：' + error.message, 'error'); }
}

async function openSshPanel() {
  if (!window.api.isElectron) { showToast('请在 Mac 或 Windows 桌面客户端的扩展插件中连接这台 Linux 服务器。', 'info'); return; }
  switchTab('ssh-tunnel-tab'); await refreshSshStatus();
}
async function chooseSshKey() { try { document.getElementById('sshKeyPath').value = await window.api.sshSelectKey() || ''; } catch (e) { showToast(e.message,'error'); } }
async function refreshSshStatus() {
  try { const s = await window.api.sshTunnelStatus(); document.getElementById('sshTunnelState').textContent = s.connected ? '已连接：' + s.url : (s.error || '尚未连接'); } catch (e) { showToast(e.message,'error'); }
}
async function stopSshTunnel() { await window.api.sshTunnelStop(); await refreshSshStatus(); }
async function startSshTunnel() {
  if (window.campusNotice && !(await window.campusNotice.beforeUse())) return;
  const button = document.getElementById('sshConnectButton'); button.disabled = true;
  const value = id => document.getElementById(id).value;
  const options = { host:value('sshHost'),username:value('sshUsername'),port:Number(value('sshPort')),remotePort:Number(value('sshRemotePort')),localPort:Number(value('sshLocalPort')),password:value('sshPassword'),keyPath:value('sshKeyPath'),passphrase:value('sshPassphrase') };
  const state = document.getElementById('sshTunnelState'); state.textContent='正在连接 SSH…';
  try {
    let result = await window.api.sshTunnelStart(options);
    if (result.requiresTrust) {
      if (!confirm('首次连接 ' + result.host + ':' + result.port + '\n服务器指纹：' + result.fingerprint + '\n请与服务器管理员提供的指纹核对一致后确认。是否信任并继续？')) { state.textContent='已取消，未保存信任'; return; }
      result = await window.api.sshTunnelStart({ ...options, confirmedFingerprint:result.fingerprint });
    }
    if (!result.connected) throw new Error('SSH 未建立连接');
    await refreshSshStatus(); await window.api.sshTunnelOpen();
  } catch(e) { state.textContent=e.message; showToast(e.message,'error'); }
  finally { options.password='';options.passphrase='';document.getElementById('sshPassword').value='';document.getElementById('sshPassphrase').value='';button.disabled=false; }
}
