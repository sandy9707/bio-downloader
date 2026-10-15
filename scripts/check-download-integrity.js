const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const { parseEnaReport, enaIdentity, createEnaResolver, verifyFile } = require('../src/main/download-integrity');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-integrity-test-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
process.env.BIODL_TEST_PRIVATE_VALUE = 'must-not-appear-in-diagnostics';
const md5 = bytes => crypto.createHash('md5').update(bytes).digest('hex');
const good = require('zlib').gzipSync(crypto.randomBytes(32768)), bad = Buffer.from(good);
bad[50] ^= 0xff; // Same size, valid header/trailer; quick checks cannot prove middle content.
const badHeader = Buffer.from(good); badHeader[0] = 0;
const enaUrl = (run, mate = 1) => `https://ftp.sra.ebi.ac.uk/vol1/fastq/${run.slice(0, 6)}/${run}/${run}_${mate}.fastq.gz`;
const row = (run = 'SRR123456') => ({ run_accession: run, fastq_ftp: [enaUrl(run), enaUrl(run, 2)].join(';'), fastq_md5: `${md5(good)};${md5(bad)}`, fastq_bytes: `${good.length};${bad.length}` });
const axios = require('axios');
let metadataCalls = 0;
axios.get = async url => {
  assert.ok(url.startsWith('https://www.ebi.ac.uk/ena/portal/api/filereport?'), 'tests must never query production data');
  assert.ok(url.includes('fastq_md5,fastq_bytes'));
  metadataCalls++;
  const accession = new URL(url).searchParams.get('accession');
  if (accession === 'SRR999999') throw new Error('fixture metadata outage');
  return { data: [row(accession)] };
};
const charges = [];
axios.post = async (url, data) => {
  assert.ok(url.endsWith('/api/user/consume'), 'no real account changes allowed');
  charges.push(data.bytes);
  return { data: { success: true } };
};
// Transport is exercised against real HTTP/Axel in check-bio-transfer-guard.
// Keep these ENA metadata fixtures offline and focused on checksum policy.
require('../src/main/bio-transfer-guard').bioSource = () => null;
const engine = require('../main');
const events = [];
engine.eventBus.on('download-status', event => events.push(event));
const dest = path.join(temp, 'files');
fs.mkdirSync(dest);
const requests = [];
const server = http.createServer((req, res) => {
  requests.push(req.url);
  const bytes = req.url.includes('bad-header') ? badHeader : req.url.includes('bad') ? bad : good;
  let start = 0, end = bytes.length - 1;
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (range) {
    start = Number(range[1]);
    if (range[2]) end = Math.min(end, Number(range[2]));
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
  }
  res.setHeader('Content-Length', end - start + 1);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Accept-Ranges', 'bytes');
  res.end(req.method === 'HEAD' ? undefined : bytes.subarray(start, end + 1));
});
let index = 100;
function start(file) {
  file.originalIndex = ++index;
  return engine.callIpcHandler('start-download', { files: [file], targetDir: dest, token: 'fixture-no-real-account', maxConcurrent: 1 });
}
const finalEvent = id => events.filter(e => e.index === id && ['completed', 'failed', 'cancelled'].includes(e.status)).at(-1);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const files = parseEnaReport([row()]);
  assert.equal(files[0].md5, md5(good));
  assert.equal(files[1].md5, md5(bad));
  assert.equal(files[1].size, bad.length);
  assert.equal(parseEnaReport([{ ...row(), fastq_md5: md5(good) }])[1].md5, null, 'misaligned arrays must not borrow another mate checksum');
  assert.equal(parseEnaReport([{ ...row(), fastq_md5: `;${md5(bad)}` }])[1].md5, md5(bad));
  assert.equal(parseEnaReport([{ ...row(), run_accession: 'SRR000000' }]).length, 0);
  assert.equal(enaIdentity(enaUrl('SRR123456').replace('ebi.ac.uk', 'ebi.ac.uk.example.com')), null);
  assert.equal(enaIdentity(enaUrl('SRR123456').replace(/_1.fastq.gz$/, '/SRR987654_1.fastq.gz')), null);
  let calls = 0;
  const resolver = createEnaResolver(async () => { calls++; await delay(5); return [row()]; });
  const refs = await Promise.all([1, 2].map(mate => resolver.reference({ url: enaUrl('SRR123456', mate).replace('https:', 'http:') }, { deep: true })));
  assert.equal(calls, 1, 'paired files must share one metadata request');
  assert.equal(refs[1].expectedMd5, md5(bad));
  assert.equal(refs[0].expectedSize, good.length);

  // Streaming checks must stop safely and detect changes during verification.
  const changed = path.join(dest, 'changed.bin');
  fs.writeFileSync(changed, good);
  await assert.rejects(verifyFile(changed, { expectedSize: good.length, expectedMd5: md5(good) }, {
    deep: true,
    onProgress: bytes => { if (!bytes) fs.appendFileSync(changed, 'changed'); }
  }), /校验期间文件被修改/);
  fs.unlinkSync(changed);

  engine.ensureBinaries();
  assert.equal(Boolean((await engine.callIpcHandler('get-settings')).deepIntegrityCheck), false, 'full MD5 must be opt-in');
  await engine.callIpcHandler('save-settings', { loggingEnabled: true, deepIntegrityCheck: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function check(name, { size = good.length, expected = md5(good), existing, url = `${base}/${name}`, status = 'failed', verification, charged = 0 } = {}) {
    const file = { name, url, size, md5: expected };
    if (existing) fs.writeFileSync(path.join(dest, name), existing);
    const beforeCharges = charges.length, beforeRequests = requests.length;
    await start(file);
    const result = finalEvent(file.originalIndex);
    assert.ok(result, `${name}: missing final status`);
    assert.equal(result.status, status, name);
    if (verification) assert.equal(result.verification.status, verification, name);
    assert.equal(charges.length - beforeCharges, charged, `${name}: consumption must occur only for completed new downloads`);
    if (existing) {
      assert.deepEqual(fs.readFileSync(path.join(dest, name)), existing, 'existing bytes must be preserved');
      assert.equal(requests.length, beforeRequests, 'existing files must never be silently overwritten');
    }
    return result;
  }
  await check('existing-bad.fastq.gz', { existing: bad, status: 'failed', verification: 'mismatch' });
  const badResult = await check('new-bad.fastq.gz', { status: 'completed', verification: 'mismatch', charged: 1 });
  assert.equal(badResult.verification.actualMd5, md5(bad));
  assert.deepEqual(fs.readFileSync(path.join(dest, 'new-bad.fastq.gz')), bad, 'mismatch must preserve downloaded bytes');
  const wrongReference = await check('wrong-reference.fastq.gz', { expected: md5(bad), status: 'completed', verification: 'mismatch', charged: 1 });
  assert.match(wrongReference.verification.reason, /参考信息都可能有问题/);
  await check('short.fastq.gz', { size: good.length * 2, verification: 'failed' });
  await check('valid.fastq.gz', { status: 'completed', verification: 'verified', charged: 1 });
  await check('valid-existing.fastq.gz', { existing: good, status: 'completed', verification: 'verified' });
  await check('ordinary.bin', { expected: null, status: 'completed', verification: 'quick-checked', charged: 1 });
  await check('unknown-size.bin', { expected: null, size: 0, status: 'completed', verification: 'unchecked', charged: 1 });

  // Old histories/direct links without MD5 obtain the correct ENA mate reference.
  await check('SRR123456_1.fastq.gz', { url: enaUrl('SRR123456'), expected: null, existing: bad, status: 'failed', verification: 'mismatch' });
  const metaBefore = metadataCalls;
  const secondMate = await check('SRR123456_2.fastq.gz', { url: enaUrl('SRR123456', 2), expected: null, existing: bad, status: 'completed', verification: 'verified' });
  assert.equal(metadataCalls, metaBefore, 'metadata must be cached across paired tasks');
  assert.equal(secondMate.md5, md5(bad));
  const unavailable = await check('SRR999999_1.fastq.gz', { url: enaUrl('SRR999999'), expected: null, existing: good, status: 'completed', verification: 'unavailable' });
  assert.match(unavailable.speed, /MD5 未核验/);
  const listed = await engine.callIpcHandler('check-download-size', { type: 'ebi_raw', inputVal: 'SRR123456' });
  assert.equal(listed[0].md5, md5(good), 'EBI file discovery must retain checksums');

  // Pause and resume the same verification without downloading again or losing billing.
  const pausedFile = { name: 'pause-hash.bin', url: `${base}/pause-hash.bin`, size: good.length, md5: md5(good) };
  let pausedResolve;
  const paused = new Promise(resolve => { pausedResolve = resolve; });
  const pauseListener = event => {
    if (event.index === pausedFile.originalIndex && event.phase === 'verifying' && event.speed.includes('MD5')) {
      engine.eventBus.removeListener('download-status', pauseListener);
      pausedResolve(engine.callIpcHandler('pause-download', pausedFile.originalIndex));
    }
  };
  engine.eventBus.on('download-status', pauseListener);
  const beforePauseCharges = charges.length;
  const pending = start(pausedFile);
  assert.equal((await paused).suspended, true);
  await delay(100);
  assert.equal(finalEvent(pausedFile.originalIndex), undefined, 'paused hashing must not complete or charge');
  assert.equal(charges.length, beforePauseCharges);
  assert.equal((await engine.callIpcHandler('resume-download', pausedFile.originalIndex)).resumed, true);
  await pending;
  assert.equal(finalEvent(pausedFile.originalIndex).verification.status, 'verified');
  assert.equal(charges.length, beforePauseCharges + 1);

  for (const cancelAll of [false, true]) {
    const file = { name: `cancel-hash-${cancelAll}.bin`, url: `${base}/cancel.bin`, size: good.length, md5: md5(good) };
    fs.writeFileSync(path.join(dest, file.name), good);
    const listener = event => {
      if (event.index === file.originalIndex && event.phase === 'verifying') {
        engine.eventBus.removeListener('download-status', listener);
        engine.callIpcHandler('pause-download', file.originalIndex);
        engine.callIpcHandler('cancel-download', cancelAll ? undefined : file.originalIndex);
      }
    };
    engine.eventBus.on('download-status', listener);
    await start(file);
    assert.equal(finalEvent(file.originalIndex).status, 'cancelled');
    assert.deepEqual(fs.readFileSync(path.join(dest, file.name)), good);
  }

  // Default fast mode must not read/hash the full file or wait on MD5 metadata.
  await engine.callIpcHandler('save-settings', { deepIntegrityCheck: false });
  const originalStream = fs.createReadStream;
  let fullReads = 0;
  fs.createReadStream = (...args) => { fullReads++; return originalStream(...args); };
  try {
    const quick = await check('quick-good.fastq.gz', { status: 'completed', verification: 'quick-checked', charged: 1 });
    assert.equal(quick.verification.actualMd5, null);
    assert.equal(quick.verification.sampledBytes, 18);
    await check('quick-bad-middle.fastq.gz', { status: 'completed', verification: 'quick-checked', charged: 1 });
    await check('quick-bad-header.fastq.gz', { verification: 'failed' });
    await check('quick-short.fastq.gz', { size: good.length * 2, verification: 'failed' });
    const callsBeforeQuick = metadataCalls;
    await check('SRR888888_1.fastq.gz', { url: enaUrl('SRR888888'), expected: null, existing: good, status: 'completed', verification: 'quick-checked' });
    assert.equal(metadataCalls, callsBeforeQuick, 'known-size fast checks need no extra MD5 API call');
    assert.equal(fullReads, 0, 'fast mode must never open a full-file read stream');
  } finally { fs.createReadStream = originalStream; }

  // Gzip tail fields can legitimately be zero or describe only the last member.
  for (const bytes of [require('zlib').gzipSync(Buffer.alloc(0)), Buffer.concat([good, require('zlib').gzipSync(Buffer.alloc(0))])]) {
    const p = path.join(dest, 'members.gz'); fs.writeFileSync(p, bytes);
    const quick = await verifyFile(p, { expectedSize: bytes.length, gzip: true });
    assert.equal(quick.status, 'quick-checked');
    assert.equal(quick.gzipTrailer.isizeModulo32, 0);
  }
  const withState = path.join(dest, 'state-remains.gz');
  fs.writeFileSync(withState, good); fs.writeFileSync(withState + '.st', 'unfinished');
  await assert.rejects(verifyFile(withState, { expectedSize: good.length, gzip: true }), /断点状态仍存在/);
  assert.deepEqual(fs.readFileSync(withState), good);

  // A full-size file + .st must enter the resume path, never the size-only skip.
  const partial = { name: 'preallocated.bin', url: `${base}/preallocated.bin`, size: good.length };
  fs.writeFileSync(path.join(dest, partial.name), good);
  fs.writeFileSync(path.join(dest, partial.name + '.st'), 'fixture-sidecar');
  let enteredDownload = false;
  const stopBeforeEngine = event => {
    if (event.index === partial.originalIndex && event.status === 'downloading') {
      enteredDownload = event.phase !== 'verifying';
      engine.eventBus.removeListener('download-status', stopBeforeEngine);
      engine.eventBus.emit('cancel-all-downloads-signal');
    }
  };
  engine.eventBus.on('download-status', stopBeforeEngine);
  await start(partial);
  await delay(50);
  assert.equal(enteredDownload, true, 'resume metadata must prevent premature completion');
  assert.notEqual(finalEvent(partial.originalIndex)?.status, 'completed');
  assert.deepEqual(fs.readFileSync(path.join(dest, partial.name)), good);
  assert.equal(fs.readFileSync(path.join(dest, partial.name + '.st'), 'utf8'), 'fixture-sidecar');

  await delay(50); // Allow diagnostic streams to finish on Windows before cleanup.
  const logsDir = path.join(process.env.BIODL_DATA_DIR, 'download_logs');
  const logs = fs.readdirSync(logsDir).map(name => fs.readFileSync(path.join(logsDir, name), 'utf8')).join('\n');
  assert.ok(logs.includes('actualMd5') && logs.includes(md5(bad)) && logs.includes('版本:'));
  assert.ok(!logs.includes(process.env.BIODL_TEST_PRIVATE_VALUE), 'unrelated environment secrets must not be logged');
  assert.ok(charges.every(bytes => bytes === good.length), 'consumption must use real file size');
  assert.equal(engine.eventBus.listenerCount('cancel-all-downloads-signal'), 0, 'finished batches must release cancellation handlers');
  console.log('完整性回归通过：默认快速检查仅读18字节、不做全文MD5、不额外查询MD5；短文件/错误gzip头拦截；可选MD5差异提示、同名检查、断点保护、暂停恢复取消、计费与诊断脱敏');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
