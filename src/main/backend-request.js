const axios = require('axios');
const RETRYABLE = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);
// Account and version requests go directly to the configured service. Never
// inherit an unrelated shell proxy or send account credentials to a mirror.
async function backendGet(url, options = {}) {
  const config = { ...options, timeout: 15000, proxy: false };
  try { return await axios.get(url, config); }
  catch (error) {
    if (error.response || !RETRYABLE.has(error.code)) throw error;
    return axios.get(url, { ...config, family: 4 });
  }
}
module.exports = { backendGet };
