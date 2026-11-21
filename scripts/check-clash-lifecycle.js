'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const code = source.slice(source.indexOf('async function startClash('), source.indexOf('// 【大小校验工具模块】'));
function fixture() {
  const logs = [], killed = [], events = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  const c = vm.createContext({
    console: { log: (...a) => logs.push(a.join(' ')), error: (...a) => logs.push(a.join(' ')) },
    writeClashLog: s => logs.push(s),
    configureClashOutboundInterface: async text => text, clashOutboundFailureHint: async () => '',
    require: require('node:module').createRequire(path.join(__dirname, '../main.js')),
    clashProcess: child, currentRealNodeCount: 12, currentPhysicalNodeCount: 6,
    currentNodeTier: 1, currentNodeVerified: true,
    killProcess: p => killed.push(p), killExistingClashProcesses: async () => {},
    checkPortBusy: async () => false, BACKEND_BASE_URL: 'https://fixture.invalid',
    backendGet: async () => ({ status: 200, data: 'proxy-groups: []' }),
    LOCAL_NODE_SPEED_TEST_URL: 'https://fixture.invalid/sample', CLASH_WORK_DIR: '/fixture',
    CLASH_CONTROL_URL: 'http://127.0.0.1:1', path,
    stripFakeProxyNodes: s => s, fs: { writeFileSync: () => {} },
    reloadClashConfig: async () => {},
    validateLocalClashNodes: async () => { c.currentRealNodeCount = 4; c.currentPhysicalNodeCount = 2; c.currentNodeTier = 2; c.currentNodeVerified = true; },
    axios: { delete: async () => {} },
    getClashBinaryPath: () => '/fixture/mihomo', ensureExecutable: () => {},
    spawn: () => child, waitForPortReady: async () => {},
    emitClashValidationProgress: (_, data) => events.push(data)
  });
  vm.runInContext(code, c);
  return { c, child, logs, killed, events };
}
function cleared(c) {
  assert.equal(c.clashProcess, null);
  assert.equal(c.currentRealNodeCount, 0);
  assert.equal(c.currentPhysicalNodeCount, 0);
  assert.equal(c.currentNodeTier, null);
  assert.equal(c.currentNodeVerified, false);
}
(async () => {
  for (const running of [true, false]) {
    const { c, killed } = fixture(); if (!running) c.clashProcess = null;
    c.stopClash(); cleared(c); assert.equal(killed.length, running ? 1 : 0);
  }
  for (const failure of ['token', 'network', 'http', 'payload', 'validation']) {
    const { c, killed, events, logs } = fixture();
    if (failure === 'network') c.backendGet = async () => { throw new Error('network unavailable'); };
    if (failure === 'http') c.backendGet = async () => ({ status: 403, data: 'denied' });
    if (failure === 'payload') c.backendGet = async () => ({ status: 200, data: {} });
    if (failure === 'validation') c.validateLocalClashNodes = async () => { throw new Error('invalid nodes'); };
    await assert.rejects(c.optimizeClash(failure === 'token' ? '' : 'fixture-sensitive-token'), /重新/);
    cleared(c); assert.equal(killed.length, 1);
    assert.equal(events.at(-1).failed, true); assert.equal(events.at(-1).verified, false);
    assert.ok(logs.every(s => !s.includes('fixture-sensitive-token')));
  }
  for (const failure of ['port', 'network', 'validation']) {
    const { c, logs } = fixture(); c.clashProcess = null;
    if (failure === 'port') c.checkPortBusy = async () => true;
    if (failure === 'network') c.backendGet = async () => { throw new Error('network unavailable'); };
    if (failure === 'validation') c.validateLocalClashNodes = async () => { throw new Error('invalid nodes'); };
    await assert.rejects(c.startClash('fixture-sensitive-token'));
    cleared(c); assert.ok(logs.every(s => !s.includes('fixture-')));
  }
  const { c, child } = fixture(); c.clashProcess = null;
  assert.equal(await c.startClash('fixture-sensitive-token'), true);
  assert.equal(c.currentNodeVerified, true);
  const replacement = new EventEmitter();
  c.clashProcess = replacement;
  child.emit('close', 1);
  assert.equal(c.clashProcess, replacement, 'late old-process close cannot clear the replacement');
  assert.equal(c.currentNodeVerified, true);
  c.clashProcess = child;
  child.emit('close', 1); cleared(c);
  const unverified = fixture(); unverified.c.currentNodeVerified = false;
  await unverified.c.startClash('fixture');
  assert.equal(unverified.killed.length, 1, 'running but unverified process must be replaced, not accepted');
  assert.equal(unverified.c.currentNodeVerified, true);
  const success = fixture();
  assert.equal((await success.c.optimizeClash('fixture-sensitive-token')).success, true);
  assert.equal(success.c.currentNodeVerified, true);
  console.log('CLASH_LIFECYCLE_OK: stop, early failures, validation failure, unexpected exit, no token logging');
})().catch(error => { console.error(error); process.exitCode = 1; });
