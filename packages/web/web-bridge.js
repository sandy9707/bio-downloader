// 为浏览器环境提供与 Electron preload 相同的 window.api 接口定义
(function () {
  if (window.api) return; // 若在 Electron 环境内直接使用原生 IPC

  const API_BASE = ''; // 相对当前 Web Server 主机

  async function request(path, options = {}) {
    const res = await fetch(API_BASE + path, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options
    });
    return await res.json();
  }

  const listeners = {
    downloadStatus: [],
    downloadProgress: []
  };

  // 建立 SSE 实时监听
  const eventSource = new EventSource('/api/events');
  eventSource.addEventListener('progress', (e) => {
    try {
      const data = JSON.parse(e.data);
      listeners.downloadProgress.forEach(cb => cb(data));
    } catch (err) {}
  });

  eventSource.addEventListener('updated', (e) => {
    try {
      const data = JSON.parse(e.data);
      listeners.downloadStatus.forEach(cb => cb(data));
    } catch (err) {}
  });

  eventSource.addEventListener('completed', (e) => {
    try {
      const data = JSON.parse(e.data);
      listeners.downloadStatus.forEach(cb => cb({ ...data, status: 'completed' }));
    } catch (err) {}
  });

  eventSource.addEventListener('failed', (e) => {
    try {
      const data = JSON.parse(e.data);
      listeners.downloadStatus.forEach(cb => cb({ ...data, status: 'failed' }));
    } catch (err) {}
  });

  window.api = {
    getAppVersion: async () => '2.0.37 (Linux Web/CLI)',
    getSettings: async () => await request('/api/settings'),
    saveSettings: async (settings) => await request('/api/settings', { method: 'POST', body: JSON.stringify(settings) }),
    getTransfersHistory: async () => await request('/api/transfers'),
    saveTransfersHistory: async (data) => await request('/api/transfers', { method: 'POST', body: JSON.stringify(data) }),

    // 鉴权
    loginUser: async (username, password) => await request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
    getUserInfo: async (token) => await request(`/api/user/info?token=${encodeURIComponent(token)}`),

    // 加速器
    getClashStatus: async () => {
      const sys = await request('/api/system');
      return !!sys.clashRunning;
    },
    getNodeCount: async () => {
      const sys = await request('/api/system');
      return sys.nodeCount || 60;
    },
    startClash: async () => await request('/api/clash/start', { method: 'POST' }),
    stopClash: async () => await request('/api/clash/stop', { method: 'POST' }),

    // 数据源校验与下载
    checkSize: async (type, inputVal) => {
      const res = await request('/api/resolve', { method: 'POST', body: JSON.stringify({ type, input: inputVal }) });
      return res.files || [];
    },
    startDownload: async (queue, targetDir) => {
      return await request('/api/tasks', { method: 'POST', body: JSON.stringify({ files: queue, targetDir }) });
    },

    // 目录选择 (Web 环境降级为手动输入或返回默认)
    selectDirectory: async () => {
      const p = prompt('请输入 Linux 服务器绝对保存路径 (例如 /home/user/downloads):');
      return p ? p.trim() : null;
    },
    openDownloadsFolder: (dir) => {
      alert(`文件已保存在 Linux 服务器目录:\n${dir}`);
    },

    // 插件状态 (Web 版已内建)
    getPluginStatus: async () => ({
      plugins: [{
        id: 'aria2',
        name: 'Linux 原生加速引擎 (aria2 & axel)',
        description: '已随 Linux 服务端完整内建并配置，开箱即用。',
        platform: 'Linux x86_64 / aarch64',
        installed: true,
        usable: true,
        version: '1.37.0'
      }]
    }),
    installPlugin: async () => ({ success: true }),

    // 事件
    onDownloadStatus: (cb) => listeners.downloadStatus.push(cb),
    onDownloadProgress: (cb) => listeners.downloadProgress.push(cb),
    removeAllListeners: () => {
      listeners.downloadStatus = [];
      listeners.downloadProgress = [];
    }
  };
})();
