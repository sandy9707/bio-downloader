const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-fallback-test-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
// Shorten only the retry backoff; the actual bundled Axel and HTTP streams run normally.
const originalTimeout = global.setTimeout;
global.setTimeout = (fn, ms, ...args) => originalTimeout(fn, [4000, 8000].includes(ms) ? 10 : ms, ...args);
const engine = require('../main');
const axios = require('axios'), charges = [], events = [], requests = [];
axios.post = async (_url, body) => { charges.push(body.bytes); return { data: { success: true } }; };
engine.eventBus.on('download-status', event => events.push(event));
const bytes = crypto.randomBytes(128 * 1024);
let mode = 'fallback';
const server = http.createServer((req, res) => {
  const node = /^axios\//.test(req.headers['user-agent'] || '');
  requests.push({ node, url: req.url });
  if (!node || mode === 'failure') { res.writeHead(503, { 'Content-Length': 0 }); res.end(); return; }
  res.writeHead(200, { 'Content-Length': bytes.length, 'Content-Type': 'application/octet-stream' });
  if (mode === 'short') { res.write(bytes.subarray(0, 1000)); originalTimeout(() => res.destroy(), 20); }
  else if (mode === 'slow') {
    let offset = 0;
    const timer = setInterval(() => {
      const end = Math.min(offset + 2048, bytes.length);
      res.write(bytes.subarray(offset, end)); offset = end;
      if (offset === bytes.length) { clearInterval(timer); res.end(); }
    }, 20);
    res.on('close', () => clearInterval(timer));
  } else res.end(bytes);
});
const sockets = new Set(); server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const dest = path.join(temp, 'files'); fs.mkdirSync(dest);
let index = 0, base;
async function download(name) {
  const id = ++index;
  await engine.callIpcHandler('start-download', { files: [{ name, url: base + '/' + name, size: bytes.length, originalIndex: id }], targetDir: dest, token: 'fixture', maxConcurrent: 1 });
  return events.filter(e => e.index === id && ['completed', 'failed', 'cancelled'].includes(e.status)).at(-1);
}
(async () => {
  engine.ensureBinaries();
  await engine.callIpcHandler('save-settings', {downloadEngines: {http: 'axel'}});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  const result = await download('fresh.bin');
  assert.equal(result?.status, 'completed', JSON.stringify(result));
  assert.deepEqual(fs.readFileSync(path.join(dest, 'fresh.bin')), bytes);
  assert.equal(requests.filter(r => !r.node).length, 3, 'exercise all three real Axel failures');
  assert.equal(requests.filter(r => r.node).length, 1, 'fallback must run after retry loop');
  assert.deepEqual(charges, [bytes.length]);
  mode = 'failure';
  const failed = await download('failed.bin');
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.speed, /is not defined/);
  assert.match(failed.speed, /503/);
  assert.equal(charges.length, 1);
  mode = 'short';
  assert.equal((await download('short.bin')).status, 'failed');
  assert.equal(charges.length, 1, 'truncated fallback must never complete or charge');
  // Retrying an Axel partial must not delete .st or truncate already downloaded bytes.
  const partial = path.join(dest, 'partial.bin'), state = Buffer.alloc(26);
  state.writeUInt16LE(1); state.writeBigInt64LE(1000n, 2);
  state.writeBigInt64LE(1000n, 10); state.writeBigInt64LE(BigInt(bytes.length), 18);
  fs.writeFileSync(partial, bytes.subarray(0, 1000)); fs.writeFileSync(partial + '.st', state);
  const nodeRequests = requests.filter(r => r.node).length;
  assert.equal((await download('partial.bin')).status, 'failed');
  assert.deepEqual(fs.readFileSync(partial), bytes.subarray(0, 1000));
  assert.deepEqual(fs.readFileSync(partial + '.st'), state);
  assert.equal(requests.filter(r => r.node).length, nodeRequests);
  const sleep = ms => new Promise(resolve => originalTimeout(resolve, ms));
  async function waitForBytes(name) {
    const deadline = Date.now() + 10000, filename = path.join(dest, name);
    while (!fs.existsSync(filename) || fs.statSync(filename).size < 4096) {
      if (Date.now() > deadline) throw new Error('fallback body did not start');
      await sleep(10);
    }
  }
  mode = 'slow';
  const paused = download('paused.bin'), pausedIndex = index;
  await waitForBytes('paused.bin');
  assert.equal((await engine.callIpcHandler('pause-download', pausedIndex)).suspended, true);
  await sleep(50);
  const snapshot = fs.readFileSync(path.join(dest, 'paused.bin'));
  await sleep(150);
  assert.deepEqual(fs.readFileSync(path.join(dest, 'paused.bin')), snapshot);
  assert.equal((await engine.callIpcHandler('resume-download', pausedIndex)).resumed, true);
  assert.equal((await paused).status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(dest, 'paused.bin')), bytes);
  assert.equal(charges.length, 2);
  for (const all of [false, true]) {
    const name = `cancel-${all}.bin`, cancelled = download(name), id = index;
    await waitForBytes(name);
    await engine.callIpcHandler('cancel-download', all ? undefined : id);
    assert.equal((await cancelled).status, 'cancelled');
    const retained = fs.readFileSync(path.join(dest, name));
    await sleep(100);
    assert.deepEqual(fs.readFileSync(path.join(dest, name)), retained, 'cancel must close the writer');
    assert.equal(charges.length, 2);
  }
  console.log('下载失败回退通过：实际 Axel 三次失败后 Node 完整下载、503、截断、保留断点、暂停恢复、单个/全部取消与计费');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await engine.callIpcHandler('cancel-download');
  server.close(); for (const socket of sockets) socket.destroy();
  global.setTimeout = originalTimeout;
  fs.rmSync(temp, { recursive: true, force: true });
});
