const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // 系统设置与文件夹选择
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),

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
  createOrder: (token, packageId, payType) => ipcRenderer.invoke('api-create-order', { token, packageId, payType }),
  mockConfirm: (orderId) => ipcRenderer.invoke('api-mock-confirm', { orderId }),

  // Clash 代理内核控制
  startClash: (token) => ipcRenderer.invoke('clash-start', { token }),
  stopClash: () => ipcRenderer.invoke('clash-stop'),
  getClashStatus: () => ipcRenderer.invoke('clash-status'),

  // 下载管理
  checkSize: (type, inputVal) => ipcRenderer.invoke('check-download-size', { type, inputVal }),
  startDownload: (files, targetDir, token) => ipcRenderer.invoke('start-download', { files, targetDir, token }),
  cancelDownload: () => ipcRenderer.invoke('cancel-download'),

  // 事件监听器
  onDownloadStatus: (callback) => {
    ipcRenderer.removeAllListeners('download-status');
    ipcRenderer.on('download-status', (event, data) => callback(data));
  },
  onDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  }
});
