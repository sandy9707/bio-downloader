// Release gate: a whole public ENA file through the actual main IPC and bundled
// native range engine, with an independent full MD5 afterward. No login or real billing.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-live-ebi-'));
process.env.BIODL_DATA_DIR = path.join(temp, '用户配置 profile');
const axios = require('axios'), charges = [];
axios.post = async (url, body) => {
  assert.ok(url.endsWith('/api/user/consume'));
  charges.push(body.bytes); return { data: { success: true } };
};
const engine = require('../main');
let final, lastProgress = null, lastStatus = null;
engine.eventBus.on('download-status', e => { if (['completed', 'failed'].includes(e.status)) final = e; });
engine.eventBus.on('download-progress', e => { lastProgress = { engine:e.engine, receivedBytes:e.receivedBytes, totalBytes:e.totalBytes, speed:e.speed }; });
engine.eventBus.on('download-status', e => { lastStatus = {status:e.status,phase:e.phase}; });
const started = Date.now();
// A slow public route must not be confused with data corruption. Keep the full
// file + independent digest gate, but allow the engine's bounded retry budget.
const heartbeat = setInterval(()=>console.log('LIVE_EBI_PROGRESS',JSON.stringify({seconds:(Date.now()-started)/1000,lastStatus,lastProgress})),30000);
const timer = setTimeout(() => { console.error('Live ENA download exceeded 20 minutes',JSON.stringify({lastStatus,lastProgress})); process.exit(2); }, 1200000);
(async () => {
  engine.ensureBinaries();
  const files = await engine.callIpcHandler('check-download-size', { type: 'ebi_raw', inputVal: 'SRR390728' });
  const file = files.find(f => f.name === 'SRR390728_1.fastq.gz');
  assert.ok(file?.size > 100000000 && file.md5, 'live ENA size and checksum required');
  assert.ok(file.url.startsWith('http://ftp.sra.ebi.ac.uk/'));
  await engine.callIpcHandler('start-download', { files: [{ ...file, originalIndex: 1 }], targetDir: path.join(temp, 'files'), token: 'test-no-account', maxConcurrent: 1 });
  assert.equal(final?.status, 'completed', JSON.stringify(final));
  assert.equal(final.engine, 'native');
  assert.equal(final.verification.method, 'md5', 'known source checksum must be verified automatically');
  assert.equal(final.verification.status, 'verified');
  assert.equal(final.verification.actualMd5, file.md5);
  assert.equal(final.verification.transport.status, 'range-verified');
  assert.equal(final.verification.transport.boundaries, 'overlap-checked');
  const hash = crypto.createHash('md5');
  for await (const bytes of fs.createReadStream(final.savePath)) hash.update(bytes);
  const actualMd5 = hash.digest('hex');
  assert.equal(actualMd5, file.md5);
  assert.deepEqual(charges, [file.size]);
  const ebiVerification = final.verification;
  // Also exercise the engine's own TLS stack (bio transport uses the guard).
  await engine.callIpcHandler('start-download', { files: [{ name: 'aria2-source.tar.gz', url: 'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.gz', size: 3904613, originalIndex: 2 }], targetDir: path.join(temp, 'files'), token: 'test-no-account', maxConcurrent: 1 });
  assert.equal(final?.status, 'completed', JSON.stringify(final));
  const httpsSha256 = crypto.createHash('sha256').update(fs.readFileSync(final.savePath)).digest('hex');
  assert.equal(httpsSha256, '8e7021c6d5e8f8240c9cc19482e0c8589540836747744724d86bf8af5a21f0e8');
  assert.deepEqual(charges, [file.size, 3904613]);
  const result = { platform: process.platform, engine: final.engine, file: file.name, size: file.size, actualMd5, expectedMd5: file.md5, seconds: (Date.now() - started) / 1000, verification: ebiVerification, httpsSha256 };
  const evidence = path.resolve('.evidence'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, `live-ebi-${process.platform}.json`), JSON.stringify(result, null, 2));
  console.log('FULL_EBI_VERIFIED', JSON.stringify(result));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timer); clearInterval(heartbeat); await engine.callIpcHandler('cancel-download');
  fs.rmSync(temp, { recursive: true, force: true });
});
