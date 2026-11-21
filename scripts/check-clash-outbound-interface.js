'use strict';
const assert = require('node:assert/strict');
const { normalizeWindowsAdapters, applyOutboundInterface } = require('../src/main/clash-outbound-interface');
const adapters = normalizeWindowsAdapters([
  { Name: 'Ethernet custom', InterfaceIndex: 18, InterfaceDescription: 'Realtek', HardwareInterface: true, Status: 'Up' },
  { Name: 'Wi-Fi', InterfaceIndex: 19, InterfaceDescription: 'Wireless', HardwareInterface: true, Status: 'Up' },
  { Name: 'Meta', InterfaceIndex: 3, InterfaceDescription: 'Meta Tunnel', HardwareInterface: false, Status: 'Up' },
  { Name: 'offline', InterfaceIndex: 4, HardwareInterface: true, Status: 'Disconnected' }
]);
assert.equal(adapters.tunDetected, true);
assert.deepEqual(adapters.interfaces.map(i => i.name), ['Ethernet custom', 'Wi-Fi']);
const fixtureYaml = 'mixed-port: 43289\nproxies: []\n';
assert.equal(applyOutboundInterface(fixtureYaml, '', adapters, 'win32'), fixtureYaml);
const bound = applyOutboundInterface(fixtureYaml, 'Ethernet custom', adapters, 'win32');
assert.equal(require('js-yaml').load(bound)['interface-name'], 'Ethernet custom');
assert.throws(() => applyOutboundInterface(fixtureYaml, 'missing', adapters, 'win32'), /不存在或未连接/);
assert.throws(() => applyOutboundInterface(fixtureYaml, 'Meta', adapters, 'win32'), /不存在或未连接/);
for (const platform of ['darwin', 'linux']) assert.equal(applyOutboundInterface(fixtureYaml, 'Ethernet custom', adapters, platform), fixtureYaml);
assert.deepEqual(normalizeWindowsAdapters(null).interfaces, []);
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const { setLazyProxyGroups } = require('../src/main/clash-outbound-interface');
const existingLazy = require('js-yaml').dump({ 'proxy-groups': [{ name: 'pool', type: 'load-balance', proxies: ['a'], lazy: true }] });
const lazyResult = yamlLoad(setLazyProxyGroups(applyOutboundInterface(existingLazy, 'Ethernet custom', adapters, 'win32')));
assert.equal(lazyResult['proxy-groups'][0].lazy, true);
assert.equal(lazyResult['interface-name'], 'Ethernet custom');
assert.equal((source.match(/setLazyProxyGroups\(yamlContent\)/g) || []).length, 2);
const settings = { token: 'private-fixture', otherPreference: true };
const handlers = {};
const context = vm.createContext({ process: { platform: 'win32' }, getSettings: () => settings,
  saveSettings: patch => Object.assign(settings, patch), clashProcess: {}, runClashSerial: fn => fn(),
  ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
  require: name => name === 'child_process' ? { execFile: (_exe, _args, options, cb) => { assert.equal(options.windowsHide, true); cb(null, JSON.stringify([{ Name: 'Ethernet custom', InterfaceIndex: 18, HardwareInterface: true, Status: 'Up' }, { Name: 'Meta', Status: 'Up' }])); } } : createRequire(path.join(__dirname, '../main.js'))(name)
});
vm.runInContext(source.slice(source.indexOf('async function getClashOutboundInterfaces('), source.indexOf('async function startClash(')), context);
vm.runInContext(source.slice(source.indexOf("ipcMain.handle('clash-get-outbound-interfaces'"), source.indexOf("ipcMain.handle('clash-get-node-count'")), context);
(async () => {
  assert.equal((await handlers['clash-get-outbound-interfaces']()).tunDetected, true);
  const saved = await handlers['clash-set-outbound-interface']({}, { name: 'Ethernet custom' });
  assert.equal(saved.restartRequired, true);
  assert.equal(settings.clashOutboundInterface, 'Ethernet custom');
  assert.equal(settings.token, 'private-fixture');
  assert.equal(yamlLoad(await context.configureClashOutboundInterface(sourceYaml()))['interface-name'], 'Ethernet custom');
  assert.equal(await context.clashOutboundFailureHint(), '');
  settings.clashOutboundInterface = 'removed';
  await assert.rejects(context.configureClashOutboundInterface(sourceYaml()), /不存在或未连接/);
  await handlers['clash-set-outbound-interface']({}, { name: '' });
  assert.match(await context.clashOutboundFailureHint(), /TUN/);
  assert.equal(await context.configureClashOutboundInterface(sourceYaml()), sourceYaml());
  await assert.rejects(handlers['clash-set-outbound-interface']({}, { name: 'Meta' }), /不存在或未连接/);
  assert.equal((source.match(/let yamlContent = await configureClashOutboundInterface\(response.data\)/g) || []).length, 2, 'both start and optimize configure outbound binding');
  console.log('CLASH_OUTBOUND_INTERFACE_OK: persistence, IPC, TUN hint, missing rejection, start+optimize, cross-platform');
})().catch(e => { console.error(e); process.exitCode = 1; });
function yamlLoad(text) { return require('js-yaml').load(text); }
function sourceYaml() { return 'proxies: []\n'; }
