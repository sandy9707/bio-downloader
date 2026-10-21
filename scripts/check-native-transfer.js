'use strict';
const assert = require('assert/strict'), fs = require('fs'), fsp = require('fs/promises'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const { spawn } = require('child_process');
const { NativeTransfer } = require('../src/main/native-transfer');
const { Journal } = require('../src/main/native-transfer/journal');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-native-中文-'));
const data = crypto.randomBytes(2 * 1024 * 1024 + 37), blockSize = 65536;
const sha = x => crypto.createHash('sha256').update(x).digest('hex');
const evidence = [], sockets = new Set();
let mode = 'good', requests = [], attempts = new Map(), busy = 0, maxBusy = 0, etag = '"generation-1"';
const server = http.createServer((req, res) => {
  if(req.url.endsWith('/redirect') || req.url.endsWith('/downgrade')) { res.writeHead(302,{Location:(req.url.endsWith('/downgrade')?'http:':'https:')+'//not-a-real-host.invalid/file'});res.end();return; }
  const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
  if (!m) { res.writeHead(400); res.end(); return; }
  const start = +m[1], end = +m[2], probe = end === start;
  const index = Math.floor((start + 32) / blockSize), key = `${start}-${end}`, count = (attempts.get(key) || 0) + 1; attempts.set(key, count);
  requests.push({ start, end, ifMatch: req.headers['if-match'], url: req.url });
  if (!probe && mode === 'busy' && count <= 2) { res.writeHead(429, { 'Retry-After': '0' }); res.end(); return; }
  if (!probe && mode === 'unavailable') { res.writeHead(503); res.end(); return; }
  const headers = { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${mode === 'range' && !probe ? start + 1 : start}-${end}/${data.length}`, ETag: mode === 'change' && !probe ? '"generation-2"' : etag };
  if (mode === 'weak') headers.ETag = 'W/"generation-1"';
  if (mode === 'encoding' && !probe) headers['Content-Encoding'] = 'gzip';
  res.writeHead(mode === 'ignore-range' && !probe ? 200 : 206, headers);
  if (probe) return res.end(data.subarray(start, end + 1));
  busy++; maxBusy = Math.max(maxBusy, busy); let timer;
  res.on('close', () => { clearTimeout(timer); busy--; });
  if (mode === 'reset' && count <= 5) { res.write(data.subarray(start, start + 1024)); timer = setTimeout(() => res.destroy(), 10); return; }
  if (mode === 'stall' && count === 1) { res.write(data.subarray(start, start + 1024)); return; }
  let offset = start;
  function send() {
    if (res.destroyed) return;
    if (mode === 'hold') { timer = setTimeout(send, 50); return; }
    const next = Math.min(end + 1, offset + (offset === start && mode === 'slow' ? 1024 : 16384)); const chunk = Buffer.from(data.subarray(offset, next)); if (mode === 'boundary' && start > 0 && offset === start) chunk[0] ^= 1; res.write(chunk); offset = next;
    if (offset === end + 1) res.end(); else timer = setTimeout(send, mode === 'slow' ? 15 + index % 3 : 1);
  }
  send();
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
let base, child;
function reset(value = 'good') { mode = value; requests = []; attempts.clear(); maxBusy = 0; }
function task(name, extra = {}) {
  return new NativeTransfer({ url: base + '/file', filename: path.join(temp, name), proxy: false, blockSize, connections: 4,
    timeoutMs: 1000, retryBaseMs: 5, retryMaxMs: 20, retryBudgetMs: 2000, progressIntervalMs: 5, lockStaleMs: 2000, ...extra });
}
function equalFile(name) { assert.equal(sha(fs.readFileSync(path.join(temp, name))), sha(data)); }
async function test(name, fn) {
  const start = Date.now(); await fn(); evidence.push({ name, ms: Date.now() - start }); console.log('PASS', name);
}
async function pausePartial(name, extra = {}) {
  reset('slow'); let t;
  t = task(name, { ...extra, onEvent: e => { if (e.type === 'piece' && e.committedBytes >= blockSize * 2) t.pause(); } });
  const result = await t.run(); assert.equal(result.status, 'paused'); assert(result.committedBytes > 0 && result.committedBytes < data.length);
  return result.committedBytes;
}
async function childTask(name, killAfterCommit = false) {
  const options = { url: base + '/file', filename: path.join(temp, name), proxy: false, blockSize, connections: 4, lockStaleMs: 2000, progressIntervalMs: 10 };
  const source = `const {NativeTransfer}=require('./src/main/native-transfer');const options=JSON.parse(process.argv[1]);const t=new NativeTransfer({...options,onEvent:e=>{if(e.type==='piece')process.stdout.write('COMMIT '+e.committedBytes+'\\n')}});t.run().then(()=>process.exit(0)).catch(e=>{process.stderr.write(e.code||e.message);process.exit(1)});`;
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, ['-e', source, JSON.stringify(options)], { cwd: path.join(__dirname, '..'), stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', killed = false; const timer = setTimeout(() => { child.kill('SIGKILL'); reject(Error('Child fixture timed out')); }, 30000);
    child.stdout.on('data', b => { output += b; if (killAfterCommit && !killed && /COMMIT/.test(output)) { killed = true; child.kill('SIGKILL'); } });
    child.stderr.on('data', b => output += b); child.once('error', reject);
    child.once('close', (code, signal) => { clearTimeout(timer); child = null; resolve({ code, signal, output, killed }); });
  });
}
const deadline = setTimeout(() => { console.error('NATIVE_TEST_TIMEOUT'); child?.kill('SIGKILL'); process.exit(2); }, 180000);
(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`;
  await test('parallel range coverage, fractional progress, independent complete SHA256', async () => {
    reset('slow'); const progress = [];
    const t = task('并行.bin', { onEvent: e => { if (e.type === 'progress') progress.push(e); } });
    assert.equal((await t.run()).status, 'completed'); equalFile('并行.bin'); assert(maxBusy > 1 && maxBusy <= 4);
    assert(progress.some(e => e.percentage > 0 && e.percentage < 1));
    for (const p of progress) { assert(p.receivedBytes <= data.length); assert(p.committedBytes <= p.receivedBytes); assert(p.percentage < 100); }
    assert(requests.filter(r => r.end > r.start).every(r => r.ifMatch === etag));
    assert(!fs.existsSync(path.join(temp, '并行.bin.biodl-part')));
  });
  await test('interrupted publication cleans only its own verified hardlink', async () => {
    reset();await task('publication.bin').run();const output=path.join(temp,'publication.bin'),part=output+'.biodl-part';
    // Recreate the exact filesystem state between publishing and removing part.
    fs.linkSync(output,part);const recovered=await task('publication.bin').run();assert(recovered.recovered);assert(!fs.existsSync(part));equalFile('publication.bin');
    const events=[];await task('publication.bin',{onEvent:e=>events.push(e)}).run();assert(events.find(e=>e.type==='resume').fast);
    fs.writeFileSync(part,'unrelated partial bytes');await assert.rejects(task('publication.bin').run(),e=>e.code==='PUBLISH_CONFLICT');
    assert.equal(fs.readFileSync(part,'utf8'),'unrelated partial bytes');equalFile('publication.bin');
  });
  await test('five resets per block recover automatically; no three-error whole-file abort', async () => {
    reset('reset'); const events = []; await task('reset.bin', { onEvent: e => events.push(e) }).run(); equalFile('reset.bin');
    assert(events.some(e => e.type === 'retry' && e.attempt >= 5)); assert(events.some(e => e.type === 'retry' && e.connections === 1));
  });
  await test('429 throttling and timeout recover on the same route', async () => {
    reset('busy'); await task('busy.bin').run(); equalFile('busy.bin');
    reset('stall'); await task('stall.bin', { timeoutMs: 80 }).run(); equalFile('stall.bin');
  });
  await test('clean pause quickly resumes only missing blocks', async () => {
    const done = await pausePartial('pause.bin'); reset(); const events = [];
    await task('pause.bin', { onEvent: e => events.push(e) }).run(); equalFile('pause.bin');
    assert(events.find(e => e.type === 'resume').fast); assert.equal(events.find(e => e.type === 'resume').verifiedBytes, 0);
    assert(requests.filter(r => r.end > r.start).length < Math.ceil(data.length / blockSize)); assert(done > 0);
  });
  await test('local corruption repairs the affected committed block', async () => {
    await pausePartial('repair.bin'); const part = path.join(temp, 'repair.bin.biodl-part');
    const fd = fs.openSync(part, 'r+'); fs.writeSync(fd, Buffer.from('corrupt'), 0, 7, 1); fs.closeSync(fd);
    reset(); const events = []; await task('repair.bin', { onEvent: e => events.push(e) }).run(); equalFile('repair.bin');
    assert(events.some(e => e.type === 'repair' && e.block === 0)); assert(requests.some(r => r.start === 0 && r.end === blockSize + 31));
  });
  await test('real process kill recovers durable journal without overwriting committed blocks', async () => {
    reset('slow'); const killed = await childTask('crash.bin', true); assert(killed.killed);
    // proper-lockfile's first timestamp is rounded up to the next second when
    // probing filesystem precision. Measure its expiry rather than assuming
    // 2400 ms after process exit is sufficient on every platform.
    const lockStat = await fsp.stat(path.join(temp, 'crash.bin.lock'));
    await sleep(Math.max(0, lockStat.mtimeMs + 2000 - Date.now()) + 150);
    reset(); const events = [];
    await task('crash.bin', { onEvent: e => events.push(e) }).run(); equalFile('crash.bin');
    const resumed = events.find(e => e.type === 'resume'); assert(resumed.committedBytes > 0); assert(!resumed.fast); assert(resumed.verifiedBytes > 0);
    assert(requests.filter(r => r.end > r.start).length < Math.ceil(data.length / blockSize));
  });
  await test('torn final journal append rolls back to last durable record', async () => {
    await pausePartial('torn.bin'); fs.appendFileSync(path.join(temp, 'torn.bin.biodl-journal'), '{"type":"piece"');
    reset(); await task('torn.bin').run(); equalFile('torn.bin');
  });
  await test('complete journal corruption never trusts sparse file length', async () => {
    await pausePartial('journal-bad.bin'); const p = path.join(temp, 'journal-bad.bin.biodl-journal');
    const raw = fs.readFileSync(p); raw[15] ^= 1; fs.writeFileSync(p, raw); reset();
    await assert.rejects(task('journal-bad.bin').run(), e => e.code === 'JOURNAL_CORRUPT'); assert(!fs.existsSync(path.join(temp, 'journal-bad.bin')));
  });
  for (const [fault, code] of [['boundary','BOUNDARY_MISMATCH'],['range','RANGE_INVALID'],['ignore-range','RANGE_INVALID'],['change','SOURCE_CHANGED'],['encoding','ENCODING_CHANGED'],['weak','VALIDATOR_REQUIRED']]) {
    await test('reject invalid source: ' + fault, async () => { reset(fault); await assert.rejects(task(fault + '.bin').run(), e => e.code === code); assert(!fs.existsSync(path.join(temp, fault + '.bin'))); });
  }
  await test('source change after restart preserves old bytes', async () => {
    await pausePartial('changed-resume.bin'); const before = sha(fs.readFileSync(path.join(temp,'changed-resume.bin.biodl-part')));
    reset(); etag = '"new-generation"';
    try { await assert.rejects(task('changed-resume.bin').run(), e => e.code === 'SOURCE_CHANGED'); }
    finally { etag = '"generation-1"'; }
    assert.equal(sha(fs.readFileSync(path.join(temp,'changed-resume.bin.biodl-part'))), before);
  });
  await test('explicit proxy carries every request; broken proxy never falls back direct', async () => {
    reset(); await task('proxy.bin', { url:'http://not-a-real-host.invalid/file', proxy:{protocol:'http',host:'127.0.0.1',port:server.address().port} }).run(); equalFile('proxy.bin');
    assert(requests.every(r => r.url.startsWith('http://not-a-real-host.invalid/')));
    const probe = http.createServer(); await new Promise(r => probe.listen(0,'127.0.0.1',r)); const port=probe.address().port; await new Promise(r=>probe.close(r)); reset();
    await assert.rejects(task('no-fallback.bin',{proxy:{protocol:'http',host:'127.0.0.1',port},retryBudgetMs:30}).run(),e=>e.code==='NETWORK_WAIT');assert.equal(requests.length,0);
  });
  await test('HTTPS CDN redirects stay on the HTTP proxy; TLS downgrade is rejected', async () => {
    reset(); const cert=fs.readFileSync(path.join(__dirname,'fixtures/native-tls/test-cert.pem'));
    const tlsSockets=new Set(), tls=require('https').createServer({cert,key:fs.readFileSync(path.join(__dirname,'fixtures/native-tls/test-key.pem'))},(req,res)=>{
      if(req.url==='/redirect'||req.url==='/downgrade'){res.writeHead(302,{Location:(req.url==='/downgrade'?'http:':'https:')+'//localhost:'+tls.address().port+'/file'});res.end();return;}
      server.emit('request',req,res);
    });
    tls.on('connection',s=>{tlsSockets.add(s);s.on('close',()=>tlsSockets.delete(s));});
    await new Promise(r=>tls.listen(0,'127.0.0.1',r));let tunnels=0;
    const connect=(req,socket,head)=>{assert.equal(req.url,'localhost:'+tls.address().port);tunnels++;const upstream=require('net').connect(tls.address().port,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream).pipe(socket);});socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());socket.on('close',()=>upstream.destroy());};
    server.on('connect',connect);const proxy={protocol:'http',host:'127.0.0.1',port:server.address().port};
    try {
      const good=task('proxy-redirect.bin',{url:'https://localhost:'+tls.address().port+'/redirect',proxy});good.httpsAgent.options.ca=cert;
      await good.run();equalFile('proxy-redirect.bin');assert(tunnels>0);assert(requests.length>1);
      reset();const bad=task('proxy-downgrade.bin',{url:'https://localhost:'+tls.address().port+'/downgrade',proxy});bad.httpsAgent.options.ca=cert;
      await assert.rejects(bad.run(),/HTTPS/);assert.equal(requests.length,0);assert(!fs.existsSync(path.join(temp,'proxy-downgrade.bin')));
    } finally {server.off('connect',connect);for(const s of tlsSockets)s.destroy();await new Promise(r=>tls.close(r));}
  });
  await test('cross-process target lock prevents simultaneous writers', async () => {
    reset('slow'); const t = task('lock.bin'); let started;
    const ready = new Promise(r => started=r); t.options.onEvent = e => { if(e.type==='piece'){mode='hold';started();} };
    const first = t.run(); await ready;
    const other = await childTask('lock.bin'); assert.equal(other.code,1); assert(other.output.includes('ELOCKED'));
    t.pause(); await first;
  });
  await test('existing output and legacy engine checkpoints are never overwritten', async () => {
    reset(); fs.writeFileSync(path.join(temp,'existing.bin'),'user content');
    await assert.rejects(task('existing.bin').run(),e=>e.code==='OUTPUT_EXISTS');assert.equal(fs.readFileSync(path.join(temp,'existing.bin'),'utf8'),'user content');
    fs.writeFileSync(path.join(temp,'legacy.bin.aria2'),'old checkpoint');
    await assert.rejects(task('legacy.bin').run(),e=>e.code==='OTHER_ENGINE');
    await task('并行.bin').run(); equalFile('并行.bin');
  });
  await test('disk full leaves no false completion and releases file lock', async () => {
    reset(); const open=fsp.open; let injected=false;
    fsp.open=async function(name,...args){const h=await open.call(this,name,...args);if(String(name).endsWith('disk.bin.biodl-part')){const write=h.write.bind(h);h.write=async(...a)=>{if(!injected){injected=true;const e=new Error('test disk full');e.code='ENOSPC';throw e}return write(...a)}}return h};
    try{await assert.rejects(task('disk.bin').run(),e=>e.code==='ENOSPC')}finally{fsp.open=open}
    assert(!fs.existsSync(path.join(temp,'disk.bin')));assert(!fs.existsSync(path.join(temp,'disk.bin.lock')));
    await task('disk.bin').run();equalFile('disk.bin');
  });
  await test('journal write failure cannot mark data complete', async () => {
    reset();const append=Journal.prototype.append;
    Journal.prototype.append=function(r){if(r.type==='piece'){const e=new Error('test journal full');e.code='ENOSPC';throw e}return append.call(this,r)};
    try{await assert.rejects(task('journal-full.bin').run(),e=>e.code==='ENOSPC')}finally{Journal.prototype.append=append}
    assert(!fs.existsSync(path.join(temp,'journal-full.bin')));assert(!fs.existsSync(path.join(temp,'journal-full.bin.lock')));
    await task('journal-full.bin').run();equalFile('journal-full.bin');
  });
  await test('unsupported publication filesystem fails before downloading file data', async () => {
    reset(); const link = fsp.link;
    fsp.link = async () => { const error = new Error('fixture unsupported links'); error.code = 'EOPNOTSUPP'; throw error; };
    try { await assert.rejects(task('unsupported.bin').run(), error => error.code === 'FILESYSTEM_UNSUPPORTED'); }
    finally { fsp.link = link; }
    assert.equal(requests.length, 0); assert(!fs.existsSync(path.join(temp, 'unsupported.bin.biodl-part')));
  });
  await test('pause interrupts long retry sleep promptly', async()=>{
    reset('unavailable');let t;const started=Date.now();
    t=task('sleep.bin',{retryBaseMs:30000,retryMaxMs:30000,retryBudgetMs:60000,onEvent:e=>{if(e.type==='retry')setTimeout(()=>t.pause(),20)}});
    assert.equal((await t.run()).status,'paused');assert(Date.now()-started<2000);
  });
  fs.mkdirSync('.evidence',{recursive:true});fs.writeFileSync(`.evidence/native-transfer-${process.platform}.json`,JSON.stringify({platform:process.platform,node:process.version,cases:evidence.length,evidence},null,2));
  console.log('NATIVE_TRANSFER_OK',process.platform,evidence.length,'cases');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{clearTimeout(deadline);child?.kill('SIGKILL');for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
