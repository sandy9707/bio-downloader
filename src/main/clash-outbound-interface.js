'use strict';
const yaml = require('js-yaml');
function normalizeWindowsAdapters(value) {
  const adapters = Array.isArray(value) ? value : value ? [value] : [];
  const active = adapters.filter(a => a.Status === 'Up');
  return {
    interfaces: active.filter(a => a.HardwareInterface === true && typeof a.Name === 'string')
      .map(a => ({ name: a.Name, index: Number(a.InterfaceIndex), description: String(a.InterfaceDescription || '') })),
    tunDetected: active.some(a => a.HardwareInterface !== true && /tun|wintun|meta|clash/i.test(`${a.Name} ${a.InterfaceDescription}`))
  };
}
function applyOutboundInterface(text, selected, state, platform) {
  if (platform !== 'win32' || !selected) return text;
  if (!state.interfaces.some(i => i.name === selected)) throw new Error('所选加速器出站接口不存在或未连接，请重新选择接口或恢复自动。');
  const config = yaml.load(text);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('订阅配置格式无效');
  config['interface-name'] = selected;
  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}
function setLazyProxyGroups(text) {
  const config = yaml.load(text);
  for (const group of config?.['proxy-groups'] || []) {
    if (['load-balance', 'url-test', 'fallback'].includes(group.type)) group.lazy = true;
  }
  return yaml.dump(config, { lineWidth: -1, noRefs: true });
}
async function listWindowsAdapters(execFile) {
  const command = "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; @(Get-NetAdapter -ErrorAction Stop | Select-Object Name,InterfaceIndex,InterfaceDescription,HardwareInterface,Status) | ConvertTo-Json -Compress";
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const stdout = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { timeout: 6000, windowsHide: true, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (error, out) => error ? reject(new Error('无法读取Windows网络接口，请稍后重试。')) : resolve(out)));
  try { return normalizeWindowsAdapters(JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim() || '[]')); }
  catch (_) { throw new Error('无法解析Windows网络接口，请稍后重试。'); }
}
module.exports = { normalizeWindowsAdapters, applyOutboundInterface, listWindowsAdapters, setLazyProxyGroups };
