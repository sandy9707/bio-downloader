const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const { Readable } = require('stream');
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

let speedPlan = {}; // representative -> { mbps } or { error: 'EPROTO' }
const groupSelections = new Map(); // __BIODL_BENCH_w -> current representative
const calls = [], speedProbes = [];

const SAMPLE = 262144;
function fakeaxios(req) {
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
  if (url.includes('/proxies/__BIODL_BENCH_')) {
    const groupName = decodeURIComponent(url.split('/proxies/')[1]);
    groupSelections.set(groupName, body.name);
    return { status: 204 };
  }
  calls.push({ url, body, options });
  assert.equal(typeof body.payload, 'string', 'Mihomo requires JSON payload');
  assert.equal(options.proxy, false, 'controller must stay local');
  const parsed = yaml.load(body.payload);
  assert.ok(parsed['proxy-groups'].every(group => group.proxies.length), 'no empty strategy groups');
  return { status: 204 };
};

const context = vm.createContext({
  fs, yaml, AbortController, setTimeout, clearTimeout,
  currentRealNodeCount: 0, currentNodeTier: null,
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

vm.runInContext(source.slice(source.indexOf('function getLocalNodePhysicalKey('), source.indexOf('async function startClash(')), context);

(async () => {
  try {
    // 1. 一级高速节点充足 (>= 6Mbps 且满 6 个): 只保留高速节点，剔除中低速及 EPROTO 假存活节点，且清理临时 bench 监听端口
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
    assert.equal(await context.validateLocalClashNodes(file), 6);
    assert.equal(context.currentNodeTier, 1);
    // 6 个物理组各测 1 次（EPROTO 明确协议故障不重测，同机场多账号绝不重复测） = 6 次
    assert.equal(speedProbes.length, 11, 'six physical samples plus five refinements; aliases never separately sampled');
    let filtered = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.equal(filtered.listeners, undefined, 'temporary bench listeners must be cleaned from final config');
    assert.equal(filtered['proxy-groups'].some(g => g.name.startsWith('__BIODL_BENCH_')), false);
    assert.deepEqual(filtered['proxy-groups'][0].proxies, [n1a, n1b, n2a, n2b, n3a, n3b]);
    assert.equal(filtered['proxy-groups'][0].type, 'fallback');
    assert.equal(filtered['proxy-groups'][0].strategy, undefined);
    assert.deepEqual(filtered['proxy-groups'][1].proxies, [n1a]);
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

    // 4. 极端网络本地测速源被整体屏蔽 (0 个测通): 三级云端保底不报错中断
    speedPlan = {};
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    await assert.rejects(context.validateLocalClashNodes(file), /未找到可用节点/);
    assert.equal(context.currentRealNodeCount, 0);

    console.log('CLASH_VALIDATION_OK: real HTTPS throughput Tier 1/2/3, EPROTO elimination, alias dedup, bench listener cleanup');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
