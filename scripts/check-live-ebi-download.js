// Release gate: a whole public ENA file through the actual main IPC and bundled
// Axel, with an independent full MD5 afterward. No login or real billing.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-live-ebi-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
const axios = require('axios'), charges = [];
axios.post = async (url, body) => {
  assert.ok(url.endsWith('/api/user/consume'));
  charges.push(body.bytes); return { data: { success: true } };
};
const engine = require('../main');
let final;
engine.eventBus.on('download-status', e => { if (['completed', 'failed'].includes(e.status)) final = e; });
const started = Date.now();
const timer = setTimeout(() => { console.error('Live ENA download exceeded 6 minutes'); process.exit(2); }, 360000);
(async () => {
  engine.ensureBinaries();
  const files = await engine.callIpcHandler('check-download-size', { type: 'ebi_raw', inputVal: 'SRR390728' });
  const file = files.find(f => f.name === 'SRR390728_1.fastq.gz');
  assert.ok(file?.size > 100000000 && file.md5, 'live ENA size and checksum required');
  assert.ok(file.url.startsWith('http://ftp.sra.ebi.ac.uk/'));
  await engine.callIpcHandler('start-download', { files: [{ ...file, originalIndex: 1 }], targetDir: path.join(temp, 'files'), token: 'test-no-account', maxConcurrent: 1 });
  assert.equal(final?.status, 'completed', JSON.stringify(final));
  assert.equal(final.verification.method, 'quick', 'production default must not perform full MD5');
  assert.equal(final.verification.transport.status, 'sampled');
  const hash = crypto.createHash('md5');
  for await (const bytes of fs.createReadStream(final.savePath)) hash.update(bytes);
  const actualMd5 = hash.digest('hex');
  assert.equal(actualMd5, file.md5);
  assert.deepEqual(charges, [file.size]);
  const result = { platform: process.platform, file: file.name, size: file.size, actualMd5, expectedMd5: file.md5, seconds: (Date.now() - started) / 1000, verification: final.verification };
  const evidence = path.resolve('.evidence'); fs.mkdirSync(evidence, { recursive: true });
  fs.writeFileSync(path.join(evidence, `live-ebi-${process.platform}.json`), JSON.stringify(result, null, 2));
  console.log('FULL_EBI_VERIFIED', JSON.stringify(result));
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(async () => {
  clearTimeout(timer); await engine.callIpcHandler('cancel-download');
  fs.rmSync(temp, { recursive: true, force: true });
});
