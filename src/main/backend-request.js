const axios = require('axios');
const RETRYABLE = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'EAI_AGAIN']);
// Account and version requests go directly to the configured service. Never
// inherit an unrelated shell proxy or send account credentials to a mirror.
async function backendGet(url, options = {}) {
  const { retryAttempts = 2, ...requestOptions } = options;
  const config = { ...requestOptions, timeout: Math.max(1000, Math.min(30000, Number(requestOptions.timeout) || 15000)), proxy: false };
  const attempts = Math.max(1, Math.min(3, retryAttempts));
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await axios.get(url, attempt === 1 ? { ...config, family: 4 } : config); }
    catch (error) {
      if (error.response || !RETRYABLE.has(error.code) || attempt === attempts - 1) throw error;
    }
  }
}
module.exports = { backendGet };
