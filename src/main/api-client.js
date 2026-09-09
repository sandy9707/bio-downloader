const axios = require('axios');
let appRef = null;

// 从主进程获取 BACKEND_BASE_URL, 需要依赖外部注入
function getBackendUrl(BACKEND_BASE_URL) {
  return BACKEND_BASE_URL;
}

function registerApiHandlers(ipcMain, BACKEND_BASE_URL, app) {
  appRef = app;
  
  ipcMain.handle('api-register', async (event, { username, password, email, inviteCode }) => {
    try {
      const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/register`, { username, password, email, inviteCode, source: 'desktop' }, { timeout: 10000 });
      return res.data;
    } catch (err) {
      if (err.response && err.response.data) return err.response.data;
      return { error: `连接服务器失败: ${err.message}` };
    }
  });

  ipcMain.handle('api-login', async (event, { username, password }) => {
    try {
      const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/login`, { username, password, source: 'desktop' }, { timeout: 10000 });
      return res.data;
    } catch (err) {
      if (err.response && err.response.data) return err.response.data;
      return { error: `连接服务器失败: ${err.message}` };
    }
  });

  ipcMain.handle('api-get-user-info', async (event, { token }) => {
    try {
      const clientVersion = process.env.BIODL_SERVER_VERSION || appRef.getVersion();
      const res = await axios.get(`${BACKEND_BASE_URL}/api/user/info?token=${encodeURIComponent(token)}&version=${encodeURIComponent(clientVersion)}`);
      return res.data;
    } catch (err) {
      if (err.response && err.response.data) return err.response.data;
      return { error: `连接服务器失败: ${err.message}` };
    }
  });

  ipcMain.handle('api-redeem', async (event, { token, code }) => {
    try {
      const res = await axios.post(`${BACKEND_BASE_URL}/api/user/redeem`, { token, code }, { timeout: 15000 });
      return res.data;
    } catch (err) {
      if (err.response && err.response.data) return err.response.data;
      return { error: `连接服务器失败: ${err.message}` };
    }
  });

  ipcMain.handle('api-request-email-bind-code', async (event, { token, email }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/email/request-code`, { token, email });
    return res.data;
  });

  ipcMain.handle('api-confirm-email-bind', async (event, { token, email, code }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/email/confirm`, { token, email, code });
    return res.data;
  });

  ipcMain.handle('api-request-password-reset', async (event, { email }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/password-reset/request`, { email });
    return res.data;
  });

  ipcMain.handle('api-confirm-password-reset', async (event, { email, code, newPassword }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/password-reset/confirm`, { email, code, newPassword });
    return res.data;
  });

  ipcMain.handle('api-get-packages', async () => {
    const res = await axios.get(`${BACKEND_BASE_URL}/api/pay/packages`);
    return res.data;
  });

  ipcMain.handle('api-create-order', async (event, { token, packageId, payType, quantity }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/pay/create`, { token, packageId, payType, quantity });
    return res.data;
  });

  ipcMain.handle('api-checkin', async (event, { token }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/checkin`, { token });
    return res.data;
  });

  ipcMain.handle('api-balance-recharge', async (event, { token, amount }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/balance/recharge`, { token, amount });
    return res.data;
  });

  ipcMain.handle('api-get-orders', async (event, { token }) => {
    const res = await axios.get(`${BACKEND_BASE_URL}/api/user/orders?token=${encodeURIComponent(token)}`);
    return res.data;
  });

  ipcMain.handle('api-get-devices', async (event, { token }) => {
    const res = await axios.get(`${BACKEND_BASE_URL}/api/user/device?token=${encodeURIComponent(token)}`);
    return res.data;
  });

  ipcMain.handle('api-get-login-log', async (event, { token }) => {
    const res = await axios.get(`${BACKEND_BASE_URL}/api/user/login-log?token=${encodeURIComponent(token)}`);
    return res.data;
  });

  ipcMain.handle('api-reset-token', async (event, { token }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/token/reset`, { token });
    return res.data;
  });

  ipcMain.handle('api-update-device', async (event, { token, deviceId, deviceName }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/device`, { token, deviceId, deviceName });
    return res.data;
  });

  ipcMain.handle('api-report-device', async (event, { token, deviceId, deviceName }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/device`, { token, deviceId, deviceName });
    return res.data;
  });

  ipcMain.handle('api-invite-copy', async (event, { token }) => {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/invite/copy`, { token });
    return res.data;
  });
}

module.exports = { registerApiHandlers };
