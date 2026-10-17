const assert = require('node:assert/strict'), fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-aria-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
const main = require('../main');
const { runAria, selectEngine } = require('../src/main/download-engines');
const { createBioTransferGuard, parseAriaState } = require('../src/main/bio-transfer-guard');
const files = require('../src/main/download-files');
const { additionalSpace } = require('../src/main/download-space');
const data = crypto.randomBytes(8 * 1024 * 1024 + 17), size = data.length;
let slow = false, fault = '', requests = [], etag = '"v1"';
const server = http.createServer((req, res) => {
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const a = m ? +m[1] : 0, b = m && m[2] ? +m[2] : size - 1;
  const request = { a, b, sent: 0 }; requests.push(request);
  const bad = b - a > 4096;
  res.writeHead(m ? 206 : 200, { 'Content-Length': b - a + 1, 'Content-Range': `bytes ${fault === 'range' && bad ? a + 1 : a}-${b}/${size}`, 'Accept-Ranges': 'bytes', ETag: fault === 'etag' && bad ? '"v2"' : etag });
  if (req.method === 'HEAD') return res.end();
  if (fault === 'short' && bad) { res.write(data.subarray(a, a + 100)); setTimeout(() => res.destroy(), 10); return; }
  let offset = a, timer;
  const send = () => { if (res.destroyed) return; const end = Math.min(b + 1, offset + 65536); res.write(data.subarray(offset, end)); request.sent += end - offset; offset = end; if (offset > b) res.end(); else timer = setTimeout(send, slow ? 60 : 0); };
  res.on('close', () => clearTimeout(timer)); send();
});
const wait = ms => new Promise(r => setTimeout(r, ms));
let guard, proc;
(async () => {
  main.ensureBinaries();
  const plugins = await main.callIpcHandler('plugin-get-status');
  const aria = plugins.plugins.find(p => p.id === 'aria2');
  assert.equal(aria.usable, true, JSON.stringify(aria)); assert.equal(aria.source, 'bundled');
  const selected = await main.callIpcHandler('plugin-set-path', {pluginId:'aria2',binaryPath:aria.path});
  assert.equal(selected.version, aria.version);
  assert.equal((await main.callIpcHandler('plugin-get-status')).plugins.find(p=>p.id==='aria2').source, 'custom');
  await main.callIpcHandler('save-settings', {aria2Path:''});

  const env = { ...process.env, LD_LIBRARY_PATH: path.join(path.dirname(aria.path), 'lib') };
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/file`, filename = path.join(temp, 'resume.bin');
  const open = file => createBioTransferGuard({ url, filename: file, expectedSize: size, engine: 'aria2', onFatal: () => proc?.kill() });
  const run = file => runAria({ binary: aria.path, url: guard.url, filename: file, threads: 4, env, onProcess: p => proc = p });
  for (const [url, engine] of [['https://example.org/a','aria2'],['ftp://example.org/a','aria2'],['sftp://example.org/a','aria2'],['ftps://example.org/a','curl']]) assert.equal(selectEngine({url}), engine);
  assert.equal(selectEngine({url}, {downloadEngines:{http:'axel'}}), 'axel');
  slow = true; guard = await open(filename);
  const interrupted = run(filename).catch(e => e);
  let parsed, original;
  for (let i = 0; i < 150; i++) {
    await wait(50);
    try { original = fs.readFileSync(filename + '.aria2'); parsed = parseAriaState(original, size); if (parsed.done > 0) break; } catch (_) {}
  }
  assert(parsed?.done > 0 && parsed.done < size, 'real aria2 must save complete-piece checkpoints');
  proc.kill(); await interrupted;
  await guard.checkpoint(); await guard.close(); guard = null;
  const state = JSON.parse(fs.readFileSync(filename + '.biodl.json'));
  assert.equal(state.engine, 'aria2'); assert(state.resume);
  assert.throws(() => parseAriaState(Buffer.from('broken'), size));
  assert.throws(() => parseAriaState(Buffer.from(state.resume.data, 'base64'), size + 1));
  fs.writeFileSync(filename + '.aria2', 'broken');
  guard = await open(filename);
  assert.deepEqual(fs.readFileSync(filename + '.aria2'), Buffer.from(state.resume.data, 'base64'), 'restore only validated matching-engine checkpoint');
  requests = []; slow = false; await run(filename); await guard.verify();
  assert.deepEqual(fs.readFileSync(filename), data);
  assert.equal(fs.existsSync(filename + '.aria2'), false);
  const bodyBytes = requests.filter(r => r.b - r.a > 4096).reduce((n,r) => n + r.sent,0);
  assert(bodyBytes < size, 'restart must reuse completed pieces');
  await guard.complete({status:'quick-checked'}); await guard.close(); guard = null;
  for (const kind of ['range', 'etag', 'short']) {
    fault = kind; const file = path.join(temp, kind + '.bin'); guard = await open(file);
    await run(file).catch(() => {}); assert(guard.error, kind); await assert.rejects(guard.verify());
    await guard.close(); guard = null;
  }
  fault = ''; etag = '"v2"'; await assert.rejects(open(filename), /源文件版本已变化/); etag = '"v1"';
  // Legacy checkpoints cannot silently switch engines.
  fs.writeFileSync(filename + '.st','legacy'); assert.equal(selectEngine({url},{},filename),'axel');
  fs.writeFileSync(filename + '.aria2','other'); assert.throws(()=>selectEngine({url},{},filename),/同时存在/);
  fs.unlinkSync(filename+'.st'); fs.unlinkSync(filename+'.aria2');
  const mismatch = {status:'mismatch', expectedMd5:'0'.repeat(32)};
  await files.persistVerification(filename,url,mismatch); assert(await files.priorMismatch(filename,url));
  assert.equal(await files.priorMismatch(filename,url+'?other=1'),false);
  assert.equal(await additionalSpace([{size,url}],()=>filename),size,'retained originals consume space');
  const release = files.claimFile(filename); assert.throws(()=>files.claimFile(filename),/已有下载或校验/); release();
  const backup = await files.preserveForRedownload(filename); assert.deepEqual(fs.readFileSync(backup),data); assert(!fs.existsSync(filename));
  console.log('ARIA_RESUME_OK', JSON.stringify({platform:process.platform,version:aria.version,resumedBytes:size-bodyBytes,checks:['real crash checkpoint','restoration','sparse ranges','source changes','short responses','legacy isolation','mismatch backup','disk budget','file lock']}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{proc?.kill();if(guard)await guard.close();server.closeAllConnections();server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
