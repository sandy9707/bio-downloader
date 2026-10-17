// Native engine -> main IPC regression. Slow disjoint ranges deliberately make
// the sparse file look nearly complete while very few bytes have arrived.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-progress-测试-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
const axios = require('axios');
axios.post = async url => { assert(url.endsWith('/api/user/consume')); return { data: { success: true } }; };
const main = require('../main');
const bytes = crypto.randomBytes(32 * 1024 * 1024), hash = crypto.createHash('sha256').update(bytes).digest('hex');
let slow = true, sent = 0, firstByteAt = 0;
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  let offset = m ? +m[1] : 0;
  const end = m?.[2] ? +m[2] : bytes.length - 1;
  res.writeHead(m ? 206 : 200, { 'Content-Length': end - offset + 1, 'Accept-Ranges': 'bytes', ...(m ? { 'Content-Range': `bytes ${offset}-${end}/${bytes.length}` } : {}) });
  if (req.method === 'HEAD') return res.end();
  let timer;
  const send = () => {
    if (res.destroyed) return;
    if (!firstByteAt) firstByteAt = Date.now();
    const next = Math.min(end + 1, offset + (slow ? 4096 : 65536));
    res.write(bytes.subarray(offset, next)); sent += next - offset; offset = next;
    if (offset > end) res.end(); else timer = setTimeout(send, slow ? 200 : 1);
  };
  res.on('close', () => clearTimeout(timer)); send();
});
const wait = ms => new Promise(r => setTimeout(r, ms));
const evidence = [];
let pending;
(async () => {
  main.ensureBinaries();
  const aria = (await main.callIpcHandler('plugin-get-status')).plugins.find(p => p.id === 'aria2');
  assert.equal(aria.source, 'bundled', 'the actual bundled runtime must work in a Unicode profile; never hide failures behind PATH');
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  for (const engine of ['aria2', 'axel']) {
    slow = true; sent = 0; firstByteAt = 0;
    const samples = [], statuses = [], filename = path.join(temp, `${engine}.bin`);
    const progress = p => { if (p.index === 71) samples.push({ ...p, at: Date.now(), sent, logicalSize: fs.existsSync(filename) ? fs.statSync(filename).size : 0 }); };
    const status = s => statuses.push(s);
    main.eventBus.on('download-progress', progress); main.eventBus.on('download-status', status);
    await main.callIpcHandler('save-settings', { downloadEngines: { http: engine } });
    pending = main.callIpcHandler('start-download', { files: [{ name: `${engine}.bin`, url: `http://127.0.0.1:${server.address().port}/file`, size: bytes.length, originalIndex: 71 }], targetDir: temp, token: 'test-no-account', maxConcurrent: 1 });
    for (let i = 0; i < 200 && !firstByteAt; i++) await wait(50);
    assert(firstByteAt, engine + ' must receive data');
    await wait(7000);
    const readings = samples.filter(p => p.receivedBytes > 0);
    assert(readings.length >= 3, engine + ' must emit repeated progress before completion');
    assert(readings[0].at - firstByteAt < 5000, engine + ' progress must not be delayed until near completion');
    if (engine === 'aria2') assert(readings.some(p => p.percentage > 0 && p.percentage < 1), 'show sub-1% progress on slow connections');
    assert(readings.some(p => p.logicalSize > p.sent * 3), 'fixture must actually create a sparse high-offset file');
    for (const p of readings) {
      // Axel's native console rounds whole percentages; its estimate must be
      // explicitly marked and stay within that precision, never sparse length.
      const tolerance = engine === 'axel' ? bytes.length / 100 : 0;
      if (engine === 'axel') assert.equal(p.receivedBytesApproximate, true);
      assert(p.receivedBytes <= p.sent + tolerance, engine + ' must not count sparse holes');
      assert(p.percentage < 10, engine + ' must not jump near 100% on this slow fixture');
      assert(Math.abs(p.percentage - p.receivedBytes * 100 / p.totalBytes) <= 0.11, 'bar and byte counters must agree');
      assert(parseFloat(p.speed) < 500, 'speed must reflect the throttled data stream');
    }
    assert.equal((await main.callIpcHandler('pause-download', 71)).suspended, true);
    await wait(300); const pausedCount = samples.length; await wait(1300);
    assert.equal(samples.length, pausedCount, engine + ' must stop progress while suspended');
    slow = false;
    assert.equal((await main.callIpcHandler('resume-download', 71)).resumed, true);
    await pending; pending = null;
    assert.equal(statuses.at(-1).status, 'completed', JSON.stringify(statuses.at(-1)));
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'), hash);
    evidence.push({ engine, firstProgressMs: readings[0].at - firstByteAt, readings: readings.map(({ at, ...p }) => ({ ...p, elapsedMs: at - firstByteAt })), checks: ['sparse size excluded', 'timely fractional progress', 'pause and resume', 'whole-file SHA256'] });
    main.eventBus.off('download-progress', progress); main.eventBus.off('download-status', status);
  }
  fs.mkdirSync('.evidence', { recursive: true });
  fs.writeFileSync(`.evidence/download-progress-${process.platform}.json`, JSON.stringify({ platform: process.platform, evidence }, null, 2));
  console.log('DOWNLOAD_PROGRESS_OK', JSON.stringify(evidence.map(e => ({ engine: e.engine, firstProgressMs: e.firstProgressMs, samples: e.readings.length }))));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  await main.callIpcHandler('cancel-download'); if (pending) await pending.catch(() => {});
  server.closeAllConnections(); server.close(); fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
