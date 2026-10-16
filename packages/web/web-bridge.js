// 为浏览器环境提供动态通用的 IPC 映射层 (100% 对齐 preload.js)
(function () {
  if (window.api) return;

  const listeners = {
    downloadStatus: [],
    md5Progress: [],
    downloadProgress: [],
    updateProgress: [],
    updateStatus: [],
    curlProgress: [],
    speedtestProgress: [],
    extractionEvent: [],
    menuAddLink: [],
    extractionNav: []
  };

  // 1. 登录会话建立后连接 SSE，避免匿名访问下载任务事件。
  let sse = null;
  function connectSse() {
    if (sse) sse.close();
    const sid = localStorage.getItem('biodl_session');
    const sseUrl = sid ? `/api/events?sid=${encodeURIComponent(sid)}` : '/api/events';
    sse = new EventSource(sseUrl);
    sse.addEventListener('md5-verification-progress', (e) => {
      try { listeners.md5Progress.forEach(fn => fn(JSON.parse(e.data))); } catch (_) {}
    });
    sse.addEventListener('download-status', (e) => {
      try {
        const data = JSON.parse(e.data);
        listeners.downloadStatus.forEach(fn => fn(data));
      } catch (err) {}
    });
    sse.addEventListener('download-progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        listeners.downloadProgress.forEach(fn => fn(data));
      } catch (err) {}
    });
    sse.addEventListener('curl-download-progress', (e) => {
      try {
        const data = JSON.parse(e.data);
        listeners.curlProgress.forEach(fn => fn(data));
      } catch (err) {}
    });
  }
  connectSse();

  // 2. 通用 IPC 调用映射表 (对齐 preload.js 48 个接口)
  const channelMap = {
    getSettings: 'get-settings',
    saveSettings: (settings) => ({ channel: 'save-settings', payload: settings }),
    selectDirectory: 'select-directory',
    getAppVersion: 'get-app-version',
    getBackendUrl: 'get-backend-url',

    register: (u, p, e, i) => ({ channel: 'api-register', payload: { username: u, password: p, email: e, inviteCode: i } }),
    login: (u, p) => ({ channel: 'api-login', payload: { username: u, password: p } }),
    getUserInfo: (t) => ({ channel: 'api-get-user-info', payload: { token: t } }),
    redeemCode: (t, c) => ({ channel: 'api-redeem', payload: { token: t, code: c } }),
    requestEmailBindCode: (t, e) => ({ channel: 'api-request-email-bind-code', payload: { token: t, email: e } }),
    confirmEmailBind: (t, e, c) => ({ channel: 'api-confirm-email-bind', payload: { token: t, email: e, code: c } }),
    requestPasswordReset: (e) => ({ channel: 'api-request-password-reset', payload: { email: e } }),
    confirmPasswordReset: (e, c, p) => ({ channel: 'api-confirm-password-reset', payload: { email: e, code: c, newPassword: p } }),

    getPackages: 'api-get-packages',
    createOrder: (t, pkg, pt, q) => ({ channel: 'api-create-order', payload: { token: t, packageId: pkg, payType: pt, quantity: q } }),
    checkin: (t) => ({ channel: 'api-checkin', payload: { token: t } }),
    balanceRecharge: (t, a) => ({ channel: 'api-balance-recharge', payload: { token: t, amount: a } }),
    getOrders: (t) => ({ channel: 'api-get-orders', payload: { token: t } }),
    getDevices: (t) => ({ channel: 'api-get-devices', payload: { token: t } }),
    getLoginLog: (t) => ({ channel: 'api-get-login-log', payload: { token: t } }),
    resetToken: (t) => ({ channel: 'api-reset-token', payload: { token: t } }),
    reportDevice: (t, id, n) => ({ channel: 'api-report-device', payload: { token: t, deviceId: id, deviceName: n } }),
    recordInviteCopy: (t) => ({ channel: 'api-invite-copy', payload: { token: t } }),

    startClash: (t) => ({ channel: 'clash-start', payload: { token: t } }),
    stopClash: 'clash-stop',
    getClashStatus: 'clash-status',
    optimizeClash: (t) => ({ channel: 'clash-optimize', payload: { token: t } }),
    getNodeCount: 'clash-get-node-count',

    checkSize: (type, inputVal) => ({ channel: 'check-download-size', payload: { type, inputVal } }),
    queryBioProject: (project) => ({ channel: 'query-bioproject', payload: { project } }),
    queryBioSample: (biosample) => ({ channel: 'query-biosample', payload: { biosample } }),
    verifyTransferMd5: (payload) => ({ channel: 'verify-transfer-md5', payload }),
    cancelTransferMd5: (payload) => ({ channel: 'cancel-transfer-md5', payload }),
    startDownload: (files, targetDir, token, maxConcurrent) => ({ channel: 'start-download', payload: { files, targetDir, token, maxConcurrent } }),
    cancelDownload: (idx) => ({ channel: 'cancel-download', payload: idx }),
    pauseDownload: (idx) => ({ channel: 'pause-download', payload: idx }),
    resumeDownload: (idx) => ({ channel: 'resume-download', payload: idx }),
    openDownloadsFolder: (dir) => ({ channel: 'open-downloads-folder', payload: dir }),
    deleteTransferFile: (filePath) => ({ channel: 'delete-transfer-file', payload: filePath }),
    cancelAllDownloadsSignal: () => ({ channel: 'cancel-all-downloads-signal', isSignal: true }),

    parseCurl: (text) => ({ channel: 'parse-curl', payload: { text } }),
    downloadCurl: (payload) => ({ channel: 'download-curl', payload }),

    openExtraction: 'open-extraction',
    syncExtractionProxy: 'extraction-sync-proxy',
    extractionBrowserNav: (url) => ({ channel: 'extraction-browser-nav', payload: { url } }),
    extractionBrowserResize: (bounds) => ({ channel: 'extraction-browser-resize', payload: bounds }),
    extractionBrowserControl: (action) => ({ channel: 'extraction-browser-control', payload: { action } }),
    extractionPause: (id) => ({ channel: 'extraction-pause', payload: { id } }),
    extractionCancel: (id) => ({ channel: 'extraction-cancel', payload: { id } }),
    extractionDownload: (payload) => ({ channel: 'extraction-download', payload }),
    extractionRunCode: (code, saveDir) => ({ channel: 'extraction-run-code', payload: { code, saveDir } }),
    extractionCookiesFor: (url) => ({ channel: 'extraction-cookies-for', payload: { url } }),
    extractionClearSession: 'extraction-clear-session',

    checkForUpdates: (advancedMode) => ({ channel: 'check-for-updates', payload: { advancedMode } }),
    openExternalUrl: (url) => ({ channel: 'open-external-url', payload: { url } }),
    downloadAppUpdate: (url, fileName) => ({ channel: 'download-app-update', payload: { url, fileName } }),
    applyHotPatch: (patchUrl) => ({ channel: 'apply-hot-patch', payload: { patchUrl } }),

    openSpeedtestPage: 'open-speedtest-page',
    speedtestNetwork: (opts) => ({ channel: 'speedtest-network', payload: opts }),
    speedtestDownloader: (opts) => ({ channel: 'speedtest-downloader', payload: opts }),

    testNodeConnection: 'test-node-connection',
    getLogsList: 'get-logs-list',
    readLogContent: (f) => ({ channel: 'read-log-content', payload: f }),
    deleteLog: (f) => ({ channel: 'delete-log', payload: f }),
    uploadLogContent: (t, f, c) => ({ channel: 'upload-log-content', payload: { token: t, filename: f, content: c } }),

    getPluginStatus: 'plugin-get-status',
    installPlugin: (id) => ({ channel: 'plugin-install', payload: { pluginId: id } }),
    setPluginPath: (id, binaryPath) => ({ channel: 'plugin-set-path', payload: { pluginId: id, binaryPath } }),

    linuxSelfUpdate: (opts) => ({ channel: 'linux-self-update', payload: opts }),

    getTransfersHistory: 'get-transfers-history',
    saveTransfersHistory: (data) => ({ channel: 'save-transfers-history', payload: data }),
    flushTransfersHistory: (data) => ({ channel: 'save-transfers-history', payload: data })
  };

  async function invokeRpc(channel, payload) {
    const headers = { 'Content-Type': 'application/json' };
    const savedSid = localStorage.getItem('biodl_session');
    if (savedSid) headers['X-Biodl-Session'] = savedSid;

    const res = await fetch('/api/ipc', {
      method: 'POST',
      headers,
      body: JSON.stringify({ channel, payload })
    });
    const json = await res.json();
    if (json && json.sessionId) {
      localStorage.setItem('biodl_session', json.sessionId);
    }
    if (channel === 'save-settings' && payload && payload.token === null) {
      localStorage.removeItem('biodl_session');
    }
    if (json && json.error) throw new Error(json.error);
    if ((channel === 'api-login' || channel === 'api-register' || channel === 'api-get-user-info' || channel === 'get-settings') && json && json.result && (json.result.success || json.result.token)) {
      connectSse();
    }
    return json ? json.result : undefined;
  }

  // 3. 构建动态 window.api Proxy 代理
  window.api = new Proxy({}, {
    get(target, prop) {
      // 监听器
      if (prop === 'onMd5VerificationProgress') return (cb) => listeners.md5Progress.push(cb);
      if (prop === 'onDownloadStatus') return (cb) => listeners.downloadStatus.push(cb);
      if (prop === 'onDownloadProgress') return (cb) => listeners.downloadProgress.push(cb);
      if (prop === 'onUpdateProgress') return (cb) => listeners.updateProgress.push(cb);
      if (prop === 'onUpdateStatus') return (cb) => listeners.updateStatus.push(cb);
      if (prop === 'onCurlProgress') return (cb) => listeners.curlProgress.push(cb);
      if (prop === 'onSpeedtestProgress') return (cb) => listeners.speedtestProgress.push(cb);
      if (prop === 'onExtractionEvent') return (cb) => listeners.extractionEvent.push(cb);
      if (prop === 'onMenuAddLink') return (cb) => listeners.menuAddLink.push(cb);
      if (prop === 'onExtractionNav') return (cb) => listeners.extractionNav.push(cb);
      if (prop === 'removeAllListeners') return () => {
        for (const k in listeners) listeners[k] = [];
      };

      // 特殊浏览器处理
      if (prop === 'selectDirectory') {
        return async () => {
          const p = prompt('请输入保存目录路径 (例如 /home/user/downloads):');
          return p ? p.trim() : null;
        };
      }
      if (prop === 'openDownloadsFolder') {
        return (dir) => alert(`文件已保存在服务器路径:\n${dir}`);
      }
      if (prop === 'openExternalUrl') {
        return (url) => window.open(url, '_blank', 'noopener');
      }

      // 常规方法映射
      return async (...args) => {
        const mapping = channelMap[prop];
        let channel = prop;
        let payload = args[0];

        if (typeof mapping === 'function') {
          const res = mapping(...args);
          channel = res.channel;
          payload = res.payload;
        } else if (typeof mapping === 'string') {
          channel = mapping;
          payload = args[0];
        }

        return await invokeRpc(channel, payload);
      };
    }
  });
})();
