'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const yaml = require('js-yaml');
const { createRequire } = require('node:module');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
async function scenario(fastCount, listenerFailure = false) {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ name: `route-${i}`, type: 'ss' }));
  let text = yaml.dump({ proxies: nodes, 'proxy-groups': [{ name: '⚡ 多账号并发下载池', proxies: nodes.slice(0, 9).map(p => p.name) }] });
  const selected = new Map(), probes = [], events = [], readyPorts = new Set();
  const c = vm.createContext({ fs: { readFileSync: () => text, writeFileSync: (_, data) => { text = data; } }, yaml,
    require: createRequire(path.join(__dirname, '../main.js')), ACCOUNT_AIRPORTS: {},
    currentRealNodeCount: 0, currentPhysicalNodeCount: 0, currentNodeTier: null, currentNodeVerified: false,
    CLASH_CONTROL_URL: 'http://127.0.0.1:1', writeClashLog: () => {},
    waitForPortReady: async (port, host, timeoutMs) => { assert.equal(timeoutMs, 4000); if (listenerFailure) throw Error('listener blocked'); readyPorts.add(port); },
    checkPortBusy: async () => false, axios: { put: async (url, body) => { selected.set(decodeURIComponent(url.split('/proxies/')[1]), body.name); return { status: 204 }; } }
  });
  vm.runInContext(source.slice(source.indexOf('function hasRepeatedRouteGain('), source.indexOf('async function startClash(')), c);
  c.reloadClashConfig = async () => {};
  c.measureProxyThroughputMbps = async port => {
    assert.ok(readyPorts.has(port), 'bench listeners must be ready before sampling');
    const name = selected.get(`__BIODL_BENCH_${port - 43310}`); probes.push(name);
    const index = Number(name.split('-')[1]); return index < fastCount ? 8 : index >= 9 ? 3 : 0;
  };
  if (listenerFailure) {
    const original = text;
    await assert.rejects(c.validateLocalClashNodes('/fixture'), /监听端口未就绪/);
    assert.equal(probes.length, 0);
    assert.equal(text, original);
    assert.equal(c.currentNodeVerified, false);
    return;
  }
  await c.validateLocalClashNodes('/fixture', { send: (_, data) => events.push(data) });
  if (fastCount >= 5) {
    assert.equal(probes.some(n => Number(n.split('-')[1]) >= 9), false);
    assert.equal(c.currentNodeTier, 1);
  } else {
    assert.equal(new Set(probes).size, 12);
    assert.ok(events.some(e => e.phase === 'sampling-secondary'));
    assert.equal(c.currentNodeTier, 2);
    assert.equal(c.currentPhysicalNodeCount, fastCount + 3);
  }
}
(async () => { for (const n of [0, 3, 4, 5]) await scenario(n); await scenario(5, true); console.log('CLASH_CANDIDATE_STAGES_OK: 0/3/4 primary groups expand configured backups; 5 avoids extra probes'); })()
.catch(e => { console.error(e); process.exitCode = 1; });
