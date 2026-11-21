const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { Readable } = require('stream');
const { createRequire } = require('module');
const yaml = require('js-yaml');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-clash-validation-'));
const file = path.join(dir, '配置.yaml');

const n1a = '凤凰城1 [账号1]', n1b = '凤凰城1 [账号2]';
const n2a = '凤凰城2 [账号1]', n2b = '凤凰城2 [账号2]';
const n3a = '凤凰城3 [账号1]', n3b = '凤凰城3 [账号2]';
const mid = '东京标准线 [账号3]';
const verySlow = '慢速保底线 [账号6]';
const eprotoBad = '伪装死节点_EPROTO [账号3]';

const allNodes = [n1a, n1b, n2a, n2b, n3a, n3b, mid, verySlow, eprotoBad];
const baseConfig = () => ({
  proxies: allNodes.map(name => ({ name, type: 'ss' })),
  'proxy-groups': [
    { name: '⚡ 多账号并发下载池', type: 'load-balance', proxies: [...allNodes] },
    { name: '一分机场', type: 'url-test', proxies: [n1a, mid, eprotoBad] },
    { name: '备用', type: 'select', proxies: [eprotoBad] }
  ]
});

let failReloadAt = 0, reloadCount = 0, compareMode = '', compareGain = false, compareRequests = 0;
let failRefinement = false;
const selectionCounts = new Map();
let speedPlan = {}; // representative -> { mbps } or { error: 'EPROTO' }
const groupSelections = new Map(); // __BIODL_BENCH_w -> current representative
const calls = [], speedProbes = [];

const SAMPLE = 262144;
function fakeaxios(req) {
  if (req.responseType === 'arraybuffer') {
    compareRequests++;
    const begin = Number(req.headers.Range.match(/bytes=(\d+)/)[1]);
    const delay = compareGain && compareMode === '__BIODL_COMBINED' ? 20 : 70;
    return new Promise(resolve => setTimeout(() => resolve({ status: 206,
      headers: { 'content-range': `bytes ${begin}-${begin + 4194303}/99999999` },
      data: { length: 4194304 } }), delay));
  }
  const port = req.proxy?.port;
  const w = port - 43310;
  const rep = groupSelections.get(`__BIODL_BENCH_${w}`);
  speedProbes.push(rep);
  const spec = speedPlan[rep];
  if (!spec || spec.error) {
    const err = new Error(spec?.error || 'ECONNRESET');
    err.code = spec?.error || 'ECONNRESET';
    return Promise.reject(err);
  }
  const targetDurationMs = Math.max(90, Math.round((SAMPLE * 8) / (spec.mbps * 1000)));
  const half = SAMPLE / 2;
  const stream = new Readable({
    read() {
      this.push(Buffer.alloc(half, 65));
      setTimeout(() => {
        this.push(Buffer.alloc(half, 66));
        this.push(null);
      }, targetDurationMs);
      this._read = () => {};
    }
  });
  return Promise.resolve({ status: 206, data: stream });
}
fakeaxios.get = async (url) => {
  // 阶段 A 探活：除完全离线的节点外，包括伪装 EPROTO 节点都能通过 HTTP 探活进入阶段 B 真实 HTTPS 测速
  for (const k of Object.keys(speedPlan)) {
    if (url.includes(encodeURIComponent(k))) return { data: { delay: 80 } };
  }
  return { data: { delay: 0 } };
};
fakeaxios.put = async (url, body, options) => {
  if (url.includes('/proxies/__BIODL_COMPARE')) { compareMode = body.name; return { status: 204 }; }
  if (url.includes('/proxies/__BIODL_BENCH_')) {
    const groupName = decodeURIComponent(url.split('/proxies/')[1]);
    const count = (selectionCounts.get(body.name) || 0) + 1;
    selectionCounts.set(body.name, count);
    if (failRefinement && count === 2) throw new Error('injected refinement failure');
    groupSelections.set(groupName, body.name);
    return { status: 204 };
  }
  reloadCount++;
  if (reloadCount === failReloadAt) throw new Error('injected reload failure');
  calls.push({ url, body, options });
  assert.equal(typeof body.payload, 'string', 'Mihomo requires JSON payload');
  assert.equal(options.proxy, false, 'controller must stay local');
  const parsed = yaml.load(body.payload);
  assert.ok(parsed['proxy-groups'].every(group => group.proxies.length), 'no empty strategy groups');
  return { status: 204 };
};

const context = vm.createContext({
  fs, yaml, require: createRequire(path.join(__dirname, '../main.js')), AbortController, setTimeout, clearTimeout,
  currentRealNodeCount: 0, currentNodeTier: null, currentPhysicalNodeCount: 0, currentNodeVerified: false,
  CLASH_CONTROL_URL: 'http://127.0.0.1:43299',
  LOCAL_NODE_SPEED_TEST_URL: 'https://example.test/sample.sra',
  LOCAL_NODE_SPEED_SAMPLE_BYTES: SAMPLE,
  LOCAL_NODE_TEST_TIMEOUT_MS: 3000,
  LOCAL_NODE_TIER1_MBPS: 6.0,
  LOCAL_NODE_TIER2_MBPS: 2.0,
  LOCAL_NODE_MIN_POOL_SIZE: 6,
  LOCAL_NODE_TEST_CONCURRENCY: 4,
  LOCAL_NODE_BENCH_BASE_PORT: 43310,
  ACCOUNT_AIRPORTS: { 1: '一分机场', 2: '一分机场', 3: '一元机场', 6: 'iKuuu' },
  checkPortBusy: async () => false,
  writeClashLog: () => {},
  axios: fakeaxios
});

vm.runInContext(source.slice(source.indexOf('function hasRepeatedRouteGain('), source.indexOf('async function startClash(')), context);

(async () => {
  try {
    // 1. 三个高速名称组虽有六个账号别名，仍须继续二级，且清理临时监听端口
    speedPlan = {
      [n1a]: { mbps: 18 },
      [n2a]: { mbps: 14 },
      [n3a]: { mbps: 10 },
      [mid]: { mbps: 3.2 },
      [verySlow]: { mbps: 0.8 },
      [eprotoBad]: { error: 'EPROTO' }
    };
    speedProbes.length = 0;
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), 7, 'three fast groups / six account aliases must continue to tier 2');
    assert.equal(context.currentNodeTier, 2);
    // 6 个物理组各测 1 次（EPROTO 明确协议故障不重测，同机场多账号绝不重复测） = 6 次
    assert.equal(speedProbes.length, 11, 'six physical samples plus five refinements; aliases never separately sampled');
    let filtered = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.equal(filtered.listeners, undefined, 'temporary bench listeners must be cleaned from final config');
    assert.equal(filtered['proxy-groups'].some(g => g.name.startsWith('__BIODL_BENCH_')), false);
    assert.deepEqual(filtered['proxy-groups'][0].proxies, [n1a, n1b, n2a, n2b, n3a, n3b, mid]);
    assert.equal(filtered['proxy-groups'][0].type, 'fallback');
    assert.equal(filtered['proxy-groups'][0].strategy, undefined);
    assert.deepEqual(filtered['proxy-groups'][1].proxies, [n1a, mid]);
    assert.equal(context.currentPhysicalNodeCount, 4);
    assert.equal(context.currentNodeVerified, true);
    assert.ok(compareRequests >= 8, 'single and combined throughput were actually compared');
    assert.deepEqual(filtered['proxy-groups'][2].proxies, [eprotoBad], 'preserve group if filtering would make it empty');

    // 2. 一级高速节点过少 (仅 2 个 >=6Mbps): 自动放宽至二级 (>= 2.0Mbps)，补充中速节点
    speedPlan = {
      [n1a]: { mbps: 12 },
      [n2a]: { mbps: 3.5 },
      [mid]: { mbps: 2.8 },
      [verySlow]: { mbps: 0.6 },
      [eprotoBad]: { error: 'EPROTO' }
    };
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), 5); // n1a, n1b, n2a, n2b, mid
    assert.equal(context.currentNodeTier, 2);

    // 3. 二级仍不足 (仅 1 个 0.9Mbps 慢节点能走通 HTTPS，其余全 EPROTO): 自动降为三级，保留唯一能真下载的节点，绝不混入 EPROTO
    speedPlan = {
      [verySlow]: { mbps: 0.9 },
      [eprotoBad]: { error: 'EPROTO' }
    };
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), 1);
    assert.equal(context.currentNodeTier, 3);
    filtered = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(filtered['proxy-groups'][0].proxies, [verySlow]);

    // 4. 无测通节点必须失败，不用未验证云端节点伪装三级
    speedPlan = {};
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    await assert.rejects(context.validateLocalClashNodes(file), /未找到可用节点/);
    assert.equal(context.currentRealNodeCount, 0);

    // A repeatable aggregate win must create a real combined route; no gain
    // above already asserted fastest-first rather than swallowing a fake API error.
    speedPlan = { [n1a]: { mbps: 10 }, [n2a]: { mbps: 10 }, [mid]: { mbps: 3 } };
    compareGain = true;
    compareRequests = 0;
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    await context.validateLocalClashNodes(file);
    filtered = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.equal(compareRequests, 16, 'repeat both single and combined trials');
    assert.equal(filtered['proxy-groups'][0].proxies[0], 'BioDownloader 吞吐增益线路');
    assert.equal(filtered['proxy-groups'].find(g => g.name === 'BioDownloader 吞吐增益线路').type, 'load-balance');
    compareGain = false;

    // Bench reload and final reload errors must restore bytes and report failure.
    // Only one viable group suppresses the optional aggregate comparison reload.
    speedPlan = { [verySlow]: { mbps: 1 } };
    for (const failAt of [1, 2]) {
      const original = yaml.dump(baseConfig());
      fs.writeFileSync(file, original);
      reloadCount = 0; failReloadAt = failAt;
      const events = [];
      await assert.rejects(context.validateLocalClashNodes(file, { send: (_, data) => events.push(data) }), /injected reload failure/);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.equal(context.currentRealNodeCount, 0);
      assert.equal(context.currentPhysicalNodeCount, 0);
      assert.equal(context.currentNodeTier, null);
      assert.equal(context.currentNodeVerified, false);
      assert.equal(events.at(-1).failed, true);
      assert.equal(events.at(-1).passed, 0);
    }
    failReloadAt = 0;
    selectionCounts.clear(); failRefinement = true;
    const beforeRefinement = yaml.dump(baseConfig());
    fs.writeFileSync(file, beforeRefinement);
    await assert.rejects(context.validateLocalClashNodes(file), /injected refinement failure/);
    assert.equal(fs.readFileSync(file, 'utf8'), beforeRefinement);
    assert.equal(context.currentNodeVerified, false);
    failRefinement = false;
    fs.writeFileSync(file, yaml.dump({ 'proxy-groups': [] }));
    await assert.rejects(context.validateLocalClashNodes(file), /没有候选节点/);
    assert.equal(context.currentRealNodeCount, 0);
    assert.equal(context.currentNodeVerified, false);
    assert.ok(!source.includes('currentRealNodeCount || 38'));
    assert.ok(!source.includes('currentRealNodeCount = 80'));
    console.log('CLASH_VALIDATION_OK: real HTTPS throughput Tier 1/2/3, EPROTO elimination, alias dedup, bench listener cleanup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
