const fs = require('fs');
const main = require('../main');

const preload = fs.readFileSync(require.resolve('../preload.js'), 'utf8');
const bridge = fs.readFileSync(require.resolve('../packages/web/web-bridge.js'), 'utf8');

const apiNames = [...preload.matchAll(/^\s{2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]);
const missingApi = apiNames.filter((name) => !new RegExp(`\\b${name}\\b`).test(bridge));
if (missingApi.length) {
  throw new Error(`Linux Web bridge 缺少 preload API: ${missingApi.join(', ')}`);
}

const invokeChannels = [...new Set([...preload.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((m) => m[1]))];
const missingHandlers = invokeChannels.filter((channel) => !main.headlessHandlers[channel]);
if (missingHandlers.length) {
  throw new Error(`无头核心未注册 IPC handler: ${missingHandlers.join(', ')}`);
}

console.log(`Linux Web 契约检查通过: ${apiNames.length} 个 window.api 方法，${invokeChannels.length} 个 IPC handler 全部覆盖`);
