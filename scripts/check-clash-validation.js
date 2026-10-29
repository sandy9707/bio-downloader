const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), vm = require('vm');
const yaml = require('js-yaml');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-clash-validation-'));
const file = path.join(dir, '配置.yaml');
const good = '香港 [账号1]', alias = '香港 [账号2]', slow = '慢节点 [账号1]', bad = '日本 [账号3]';
const config = { proxies: [good, alias, slow, bad].map(name => ({ name, type: 'ss' })),
  'proxy-groups': [
    { name: '⚡ 多账号并发下载池', type: 'load-balance', proxies: [good, alias, slow, bad] },
    { name: '一分机场', type: 'url-test', proxies: [good, slow, bad] },
    { name: '备用', type: 'select', proxies: [bad] }
  ] };
const calls = [], probes = [];
const context = vm.createContext({ fs, yaml, currentRealNodeCount: 0,
  CLASH_CONTROL_URL: 'http://127.0.0.1:43299', LOCAL_NODE_TEST_URL: 'http://example.test',
  LOCAL_NODE_TEST_TIMEOUT_MS: 2500, LOCAL_NODE_MAX_DELAY_MS: 900, LOCAL_NODE_TEST_CONCURRENCY: 8,
  ACCOUNT_AIRPORTS: { 1: '一分机场', 2: '一分机场', 3: '一元机场' },
  writeClashLog: () => {},
  axios: {
    get: async url => {
      probes.push(url);
      if (url.includes(encodeURIComponent(bad))) return { data: { delay: 0 } };
      if (url.includes(encodeURIComponent(slow))) return { data: { delay: 1800 } };
      return { data: { delay: 20 } };
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
    fs.writeFileSync(file, yaml.dump(config));
    assert.equal(await context.validateLocalClashNodes(file), 2);
    assert.equal(probes.length, 3, 'same-airport aliases must be tested once');
    const filtered = yaml.load(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(filtered['proxy-groups'][0].proxies, [good, alias], 'download pool drops dead and high-delay nodes');
    assert.deepEqual(filtered['proxy-groups'][1].proxies, [good], 'non-empty strategy group drops dead/slow nodes');
    assert.deepEqual(filtered['proxy-groups'][2].proxies, [bad], 'preserve group if filtering would make it empty');
    assert.equal(calls.length, 1);
    const original = yaml.dump(config); fs.writeFileSync(file, original);
    context.axios.get = async () => ({ data: { delay: 0 } });
    await assert.rejects(context.validateLocalClashNodes(file), /未找到可用高速节点/);
    assert.equal(fs.readFileSync(file, 'utf8'), original, 'all-failed check must preserve config');
    console.log('CLASH_VALIDATION_OK: JSON reload, alias deduplication, partial failures, strategy preservation, all-failed preservation');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
