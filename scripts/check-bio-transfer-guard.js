const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const transport = require('../src/main/bio-transfer-guard');
const { createBioTransferGuard, bioSource, parseAxelState } = transport;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-guard-test-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
// Redirect only this isolated process's source selection to our fault server.
transport.bioSource = url => url.includes('/bio/') ? url : null;
const engine = require('../main');
engine.ensureBinaries();
const binary = path.join(process.env.BIODL_DATA_DIR, 'bin', process.platform === 'win32' ? 'axel.exe' : 'axel');
const bytes = require('zlib').gzipSync(crypto.randomBytes(2 * 1024 * 1024));
let etag = '"generation-1"', mode = 'good', received = [], slow = false, holdBody = false;
const transientFailures = new Map();
const server = http.createServer((req, res) => {
  const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const a = m ? +m[1] : 0, b = m && m[2] ? Math.min(+m[2], bytes.length - 1) : bytes.length - 1;
  received.push({ a, b, ifRange: req.headers['if-range'], url: req.url });
  // Main aria2 may finish this small local file before opening a second range.
  // Inject a wrong range into its first body too, so the fault is actually served.
  const bad = b - a > 4096 && (a > 0 || req.url.endsWith('/bio/bad.gz'));
  if (mode === 'transient-segments' && bad) {
    const key = `${a}-${b}`, failures = transientFailures.get(key) || 0;
    transientFailures.set(key, failures + 1);
    if (failures < 2) { res.writeHead(502, { 'Content-Length': 0 }); res.end(); return; }
  }
  const actual = mode === 'wrong-range' && bad ? (a === 0 ? 1 : 0) : a;
  const headers = { 'Content-Range': `bytes ${actual}-${actual + b - a}/${bytes.length}`, 'Content-Length': b - a + 1, 'Accept-Ranges': 'bytes', ETag: mode === 'changed' && bad ? '"generation-2"' : etag };
  if (mode === 'encoding' && bad) headers['Content-Encoding'] = 'gzip';
  res.writeHead(mode === 'ignored-range' && bad ? 200 : m ? 206 : 200, headers);
  if (['short', 'short-once'].includes(mode) && bad) { if (mode === 'short-once') mode = 'good'; res.write(bytes.subarray(a, a + 100)); setTimeout(() => res.destroy(), 5); }
  else if (slow && b - a > 4096) {
    let offset = actual, timer;
    const end = actual + b - a + 1;
    const send = () => { if (res.destroyed) return; if (holdBody && offset > actual) { timer = setTimeout(send, 20); return; } const next = Math.min(end, offset + 8192); res.write(bytes.subarray(offset, next)); offset = next; if (offset === end) res.end(); else timer = setTimeout(send, 70); };
    res.on('close', () => clearTimeout(timer)); send();
  } else res.end(bytes.subarray(actual, actual + b - a + 1));
});
const sockets = new Set(); server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const env = { ...process.env }; for (const k of Object.keys(env)) if (/proxy/i.test(k)) delete env[k];
const md5 = data => crypto.createHash('md5').update(data).digest('hex');
async function runAxel(url, filename, onProc = () => {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, ['-n', '4', '-T', '3', '-o', filename, url], { env });
    let output = ''; for (const stream of [proc.stdout, proc.stderr]) stream.on('data', b => { output = (output + b).slice(-1600); });
    onProc(proc);
    const timer = setTimeout(() => { proc.kill(); reject(new Error(`fixture Axel timed out: ${path.basename(filename)} ${output}`)); }, 30000);
    proc.on('error', reject); proc.on('close', code => { clearTimeout(timer); resolve(code); });
  });
}
function stateBytes(start, end = bytes.length) {
  const state = Buffer.alloc(26); state.writeUInt16LE(1); state.writeBigInt64LE(BigInt(bytes.length - (end - start)), 2);
  state.writeBigInt64LE(BigInt(start), 10); state.writeBigInt64LE(BigInt(end), 18); return state;
}
const guards = new Set();
async function open(options) { const guard = await createBioTransferGuard(options); guards.add(guard); return guard; }
async function close(guard) { await guard.close(); guards.delete(guard); }
(async () => {
  for (const scheme of ['http', 'https', 'ftp']) assert.equal(bioSource(`${scheme}://ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456_1.fastq.gz`), 'http://ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456_1.fastq.gz');
  assert.equal(bioSource('http://ftp.ncbi.nlm.nih.gov/file.gz'), 'https://ftp.ncbi.nlm.nih.gov/file.gz');
  assert.equal(bioSource('https://ftp.sra.ebi.ac.uk/vol1/fastq/a.gz?signature=x'), null);
  assert.equal(bioSource('https://user:pass@ftp.sra.ebi.ac.uk/vol1/fastq/a.gz'), null);
  assert.equal(bioSource('https://ftp.sra.ebi.ac.uk.evil.test/vol1/fastq/a.gz'), null);
  assert.equal(bioSource('https://ftp.ncbi.nlm.nih.gov/a?signature=x'), null, 'signed/browser links retain their native flow');
  assert.throws(() => parseAxelState(Buffer.alloc(28), bytes.length));
  assert.throws(() => parseAxelState(stateBytes(10), bytes.length + 1));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // Reproduce the actual shipped Axel accepting wrong Content-Range, not a mock engine.
  mode = 'wrong-range';
  const oldFile = path.join(temp, 'old.gz');
  assert.equal(await runAxel(base + '/old', oldFile), 0);
  assert.equal(fs.statSync(oldFile).size, bytes.length);
  assert.notEqual(md5(fs.readFileSync(oldFile)), md5(bytes));
  assert.equal(fs.existsSync(oldFile + '.st'), false);

  for (const fault of ['wrong-range', 'ignored-range', 'changed', 'encoding', 'short']) {
    mode = fault;
    const filename = path.join(temp, fault + '.gz'); let proc;
    const guard = await open({ url: base + '/file', filename, expectedSize: bytes.length, onFatal: () => proc?.kill() });
    await runAxel(guard.url, filename, p => { proc = p; });
    assert.ok(guard.error, `${fault} must be detected during transfer`);
    await assert.rejects(guard.verify());
    assert.ok(fs.existsSync(filename), 'bad transfer must retain data');
    await close(guard);
  }
  mode = 'good';
  const retryFile = path.join(temp, 'retry.gz'); let retryProc;
  const retry = await open({ url: base + '/file', filename: retryFile, expectedSize: bytes.length, onFatal: () => retryProc?.kill() });
  mode = 'short-once';
  assert.equal(await runAxel(retry.url, retryFile, p => { retryProc = p; }), 0);
  const recovered = await retry.verify();
  assert.equal(recovered.recoveredResponses, 1);
  assert.deepEqual(fs.readFileSync(retryFile), bytes, 'a short response must resume without duplicated or missing bytes');
  await close(retry);
  mode = 'transient-segments';
  const transientFile = path.join(temp, 'transient.gz'); let transientProc;
  const transient = await open({ url: base + '/file', filename: transientFile, expectedSize: bytes.length, onFatal: () => transientProc?.kill() });
  assert.equal(await runAxel(transient.url, transientFile, p => { transientProc = p; }), 0);
  const transientResult = await transient.verify();
  assert.ok(transientResult.recoveredResponses > 3, 'separate segments must have independent retry budgets');
  assert.deepEqual(fs.readFileSync(transientFile), bytes);
  await close(transient); mode = 'good';
  const filename = path.join(temp, 'good.gz');
  const guard = await open({ url: base + '/file', filename, expectedSize: bytes.length });
  await assert.rejects(open({ url: base + '/file', filename, expectedSize: bytes.length }), /已有下载任务/);
  assert.equal(await runAxel(guard.url, filename), 0);
  const verified = await guard.verify();
  assert.deepEqual(fs.readFileSync(filename), bytes);
  assert.equal(verified.fullContentVerified, false);
  assert.ok(verified.sampledBytes <= 128 * 1024);
  await guard.complete({ status: 'quick-checked', transport: verified }); await close(guard);

  // Existing same-size corruption in an interior sampled window cannot be skipped.
  const middle = transport.sampleWindows(bytes.length)[16].offset;
  const fd = fs.openSync(filename, 'r+'); fs.writeSync(fd, Buffer.from([bytes[middle] ^ 255]), 0, 1, middle); fs.closeSync(fd);
  const check = await open({ url: base + '/file', filename, expectedSize: bytes.length });
  await assert.rejects(check.verify({ existing: true }), /抽样与源文件不一致/); await close(check);

  // Restart with a valid .st: only missing ranges are transferred, completed bytes stay intact.
  const resumed = path.join(temp, 'resume.gz'), split = 1024 * 1024;
  const partial = Buffer.alloc(bytes.length); bytes.copy(partial, 0, 0, split);
  fs.writeFileSync(resumed, partial); fs.writeFileSync(resumed + '.st', stateBytes(split));
  let resume = await open({ url: base + '/file', filename: resumed, expectedSize: bytes.length });
  await resume.checkpoint(); await close(resume);
  fs.writeFileSync(resumed + '.st', 'torn checkpoint');
  resume = await open({ url: base + '/file', filename: resumed, expectedSize: bytes.length });
  assert.equal(parseAxelState(fs.readFileSync(resumed + '.st'), bytes.length).done, split, 'restore atomic last-valid checkpoint');
  received = [];
  assert.equal(await runAxel(resume.url, resumed), 0);
  await resume.verify();
  assert.deepEqual(fs.readFileSync(resumed), bytes);
  assert.ok(received.filter(r => r.b - r.a > 4096 && r.b !== bytes.length - 1 || r.b - r.a > 4096 && r.a > 0).every(r => r.a >= split), 'resume must not restart completed portions');
  await resume.complete({ status: 'quick-checked' }); await close(resume);
  etag = '"new-generation"';
  await assert.rejects(open({ url: base + '/file', filename: resumed, expectedSize: bytes.length }), /源文件版本已变化/);
  assert.deepEqual(fs.readFileSync(resumed), bytes);
  etag = '"generation-1"';

  // A configured upstream proxy failure must never leak into a direct download.
  received = [];
  await assert.rejects(open({ url: base + '/must-not-request', filename: path.join(temp, 'proxy.gz'), expectedSize: bytes.length, proxy: { protocol: 'http', host: '127.0.0.1', port: 1 }, timeout: 1000 }));
  assert.equal(received.filter(r => r.url.includes('must-not-request')).length, 0);

  // A briefly refused proxy connection is retryable on the SAME route, without
  // confusing it with corrupt data or leaking a direct request to the origin.
  const recoveringProxy = http.createServer(server.listeners('request')[0]);
  await new Promise(resolve => recoveringProxy.listen(0, '127.0.0.1', resolve));
  const proxyPort = recoveringProxy.address().port;
  await new Promise(resolve => recoveringProxy.close(resolve));
  const proxyReady = new Promise(resolve => setTimeout(() => recoveringProxy.listen(proxyPort, '127.0.0.1', resolve), 100));
  let recoveredProxy;
  try {
    recoveredProxy = await open({ url: base + '/proxy-only', filename: path.join(temp, 'recover-proxy.gz'), expectedSize: bytes.length, proxy: { protocol: 'http', host: '127.0.0.1', port: proxyPort } });
    assert.ok(received.length > 0);
    assert.ok(received.every(r => r.url.startsWith('http://')), 'every request must use the proxy absolute URL');
  } finally {
    if (recoveredProxy) await close(recoveredProxy);
    await proxyReady; recoveringProxy.closeAllConnections();
    await new Promise(resolve => recoveringProxy.close(resolve));
  }

  // Real main IPC: completion, dedup, failed response, no consumption for skipped/bad files.
  const axios = require('axios'), charges = [], events = [];
  axios.post = async (_url, body) => { charges.push(body.bytes); return { data: { success: true } }; };
  engine.eventBus.on('download-status', e => events.push(e));
  const targetDir = path.join(temp, 'ipc'); fs.mkdirSync(targetDir);
  async function ipc(name, index) {
    await engine.callIpcHandler('start-download', { files: [{ name, url: base + '/bio/' + name, size: bytes.length, originalIndex: index }], targetDir, token: 'fixture', maxConcurrent: 1 });
    return events.filter(e => e.index === index && ['completed', 'failed', 'cancelled'].includes(e.status)).at(-1);
  }
  const first = await ipc('fresh.gz', 1);
  assert.equal(first.status, 'completed'); assert.equal(first.verification.transport.status, 'sampled');
  assert.equal(charges.length, 1);
  assert.equal((await ipc('fresh.gz', 2)).status, 'completed'); assert.equal(charges.length, 1);
  mode = 'wrong-range';
  assert.equal((await ipc('bad.gz', 3)).status, 'failed'); assert.equal(charges.length, 1);
  mode = 'good'; slow = true;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function waitForBody(name) {
    const deadline = Date.now() + 10000;
    while (!received.some(r => r.url.endsWith(name) && r.b - r.a > 4096 && (r.a > 0 || r.b < bytes.length - 1))) {
      if (Date.now() > deadline) throw new Error('body did not start');
      await sleep(20);
    }
  }
  // Windows' first PowerShell/Add-Type startup can outlast a small fixture.
  // Keep the body open until native suspension is confirmed, then send while
  // suspended so the unchanged-file assertion still tests actual OS control.
  holdBody = true;
  const paused = ipc('paused.gz', 4); await waitForBody('paused.gz');
  assert.equal((await engine.callIpcHandler('pause-download', 4)).suspended, true);
  holdBody = false;
  const snapshot = fs.readFileSync(path.join(targetDir, 'paused.gz'));
  await sleep(150);
  assert.deepEqual(fs.readFileSync(path.join(targetDir, 'paused.gz')), snapshot, 'paused native Axel must not write');
  assert.equal(charges.length, 1);
  assert.equal((await engine.callIpcHandler('resume-download', 4)).resumed, true);
  assert.equal((await paused).status, 'completed'); assert.equal(charges.length, 2);
  const cancelled = ipc('cancelled.gz', 5); await waitForBody('cancelled.gz');
  await engine.callIpcHandler('cancel-download', 5);
  assert.equal((await cancelled).status, 'cancelled'); assert.equal(charges.length, 2);
  console.log('Axel 分段保护通过: 实际错位分段复现/拦截、源变化、短响应、编码、抽样、断点恢复、代理边界与主流程计费');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await engine.callIpcHandler('cancel-download');
  for (const guard of guards) await guard.close();
  server.close(); for (const socket of sockets) socket.destroy();
  fs.rmSync(temp, { recursive: true, force: true });
});
