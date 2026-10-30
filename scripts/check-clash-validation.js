const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const yaml = require('js-yaml');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-clash-validation-'));
const file = path.join(dir, '配置.yaml');

const n1a = '凤凰城1 [账号1]', n1b = '凤凰城1 [账号2]';
const n2a = '凤凰城2 [账号1]', n2b = '凤凰城2 [账号2]';
const n3a = '凤凰城3 [账号1]', n3b = '凤凰城3 [账号2]';
const mid = '东京专线 [账号3]';
const verySlow = '高延迟保底 [账号6]';
const bad = '故障节点 [账号3]';

const allNodes = [n1a, n1b, n2a, n2b, n3a, n3b, mid, verySlow, bad];
const baseConfig = () => ({
  proxies: allNodes.map(name => ({ name, type: 'ss' })),
  'proxy-groups': [
    { name: '⚡ 多账号并发下载池', type: 'load-balance', proxies: [...allNodes] },
    { name: '一分机场', type: 'url-test', proxies: [n1a, mid, bad] },
    { name: '备用', type: 'select', proxies: [bad] }
  ]
});

let delayMap = {};
const calls = [], probes = [];
const context = vm.createContext({
  fs, yaml, currentRealNodeCount: 0, currentNodeTier: null,
  CLASH_CONTROL_URL: 'http://127.0.0.1:43299', LOCAL_NODE_TEST_URL: 'http://example.test',
  LOCAL_NODE_TEST_TIMEOUT_MS: 4500,
  LOCAL_NODE_TIER1_DELAY_MS: 1200,
  LOCAL_NODE_TIER2_DELAY_MS: 3000,
  LOCAL_NODE_MIN_POOL_SIZE: 6,
  LOCAL_NODE_TEST_CONCURRENCY: 8,
  ACCOUNT_AIRPORTS: { 1: '一分机场', 2: '一分机场', 3: '一元机场', 6: 'iKuuu' },
  writeClashLog: () => {},
  axios: {
    get: async url => {
      probes.push(url);
      for (const [k, v] of Object.entries(delayMap)) {
        if (url.includes(encodeURIComponent(k))) return { data: { delay: v } };
      }
      return { data: { delay: 0 } };
    },
    put: async (url, body, options) => {
      calls.push({ url, body, options });
      assert.equal(typeof body.payload, 'string', 'Mihomo requires JSON payload');
      assert.equal(options.proxy, false, 'controller must stay local');
      const parsed = yaml.load(body.payload);
      assert.ok(parsed['proxy-groups'].every(group => group.proxies.length), 'no empty strategy groups');
      return { status: 204 };
    }
  }
});

vm.runInContext(source.slice(source.indexOf('function getLocalNodePhysicalKey('), source.indexOf('async function startClash(')), context);

(async () => {
  try {
    // 1. 一级节点充足 (>= 6): 仅保留 <=1200ms 优秀节点，剔除 1800ms 与故障节点
    delayMap = { [n1a]: 180, [n2a]: 220, [n3a]: 310, [mid]: 1800, [verySlow]: 3600, [bad]: 0 };
    probes.length = 0;
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), 6);
    assert.equal(context.currentNodeTier, 1);
    // 6 个物理组: n1, n2, n3, mid, verySlow(各1次) + bad(失败重试共2次) = 7 次探测
    assert.equal(probes.length, 7, 'same-airport aliases must be tested once, dead node retried once');
    let filtered = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(filtered['proxy-groups'][0].proxies, [n1a, n1b, n2a, n2b, n3a, n3b]);
    assert.deepEqual(filtered['proxy-groups'][1].proxies, [n1a]);
    assert.deepEqual(filtered['proxy-groups'][2].proxies, [bad], 'preserve group if filtering would make it empty');

    // 2. 一级节点不足 (< 6, 仅有 2 个): 自动放宽至二级 (<= 3000ms)，纳入 mid 节点
    delayMap = { [n1a]: 200, [n2a]: 2100, [mid]: 1800, [verySlow]: 3800, [bad]: 0 };
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), 5); // n1a, n1b, n2a, n2b, mid
    assert.equal(context.currentNodeTier, 2);

    // 3. 二级节点仍不足 (< 4, 仅有 1 个超慢节点测通): 自动降为三级保底，保留唯一测通节点
    delayMap = { [verySlow]: 3900 };
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), 1);
    assert.equal(context.currentNodeTier, 3);

    // 4. 极端网络全部探测 0 响应: 不抛错中断，自动降为三级保底保留线上初筛池
    delayMap = {};
    fs.writeFileSync(file, yaml.dump(baseConfig()));
    assert.equal(await context.validateLocalClashNodes(file), allNodes.length);
    assert.equal(context.currentNodeTier, 3);

    console.log('CLASH_VALIDATION_OK: Tier 1/2/3 auto-relaxation, alias deduplication, retry-once, zero-node cloud fallback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
