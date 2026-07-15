const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 系统设置与文件夹选择
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getBackendUrl: () => ipcRenderer.invoke('get-backend-url'),

  // 用户与认证
  register: (username, password, email) => ipcRenderer.invoke('api-register', { username, password, email }),
  login: (username, password) => ipcRenderer.invoke('api-login', { username, password }),
  getUserInfo: (token) => ipcRenderer.invoke('api-get-user-info', { token }),
  requestEmailBindCode: (token, email) => ipcRenderer.invoke('api-request-email-bind-code', { token, email }),
  confirmEmailBind: (token, email, code) => ipcRenderer.invoke('api-confirm-email-bind', { token, email, code }),
  requestPasswordReset: (email) => ipcRenderer.invoke('api-request-password-reset', { email }),
  confirmPasswordReset: (email, code, newPassword) => ipcRenderer.invoke('api-confirm-password-reset', { email, code, newPassword }),

  // 支付计费
  getPackages: () => ipcRenderer.invoke('api-get-packages'),
  createOrder: (token, packageId, payType, quantity) => ipcRenderer.invoke('api-create-order', { token, packageId, payType, quantity }),
  mockConfirm: (orderId) => ipcRenderer.invoke('api-mock-confirm', { orderId }),

  // Clash 代理内核控制
  startClash: (token) => ipcRenderer.invoke('clash-start', { token }),
  stopClash: () => ipcRenderer.invoke('clash-stop'),
  getClashStatus: () => ipcRenderer.invoke('clash-status'),

  // 下载管理
  checkSize: (type, inputVal) => ipcRenderer.invoke('check-download-size', { type, inputVal }),
  startDownload: (files, targetDir, token, maxConcurrent) => ipcRenderer.invoke('start-download', { files, targetDir, token, maxConcurrent }),
  cancelDownload: (fileIndex) => ipcRenderer.invoke('cancel-download', fileIndex),
  openDownloadsFolder: (folderPath) => ipcRenderer.invoke('open-downloads-folder', folderPath),
  cancelAllDownloadsSignal: () => ipcRenderer.send('cancel-all-downloads-signal'),

  // 自动更新与发布页
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openExternalUrl: (url) => ipcRenderer.invoke('open-external-url', { url }),
  downloadAppUpdate: (url, fileName) => ipcRenderer.invoke('download-app-update', { url, fileName }),

  // 事件监听器
  onDownloadStatus: (callback) => {
    ipcRenderer.removeAllListeners('download-status');
    ipcRenderer.on('download-status', (event, data) => callback(data));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  },
  onUpdateProgress: (callback) => {
    ipcRenderer.removeAllListeners('update-progress');
    ipcRenderer.on('update-progress', (event, data) => callback(data));
  },
  onUpdateStatus: (callback) => {
    ipcRenderer.removeAllListeners('update-status');
    ipcRenderer.on('update-status', (event, data) => callback(data));
  }
});
