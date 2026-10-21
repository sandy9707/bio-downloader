'use strict';
// Actual main IPC + worker, isolated profile and accounting sink. --stress
// crosses the 2 GiB offset boundary while other files run concurrently.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http'), crypto = require('crypto');
const assert = require('assert/strict'), { spawn } = require('child_process');
const stress = process.argv.includes('--stress'), root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-native-app-中文-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
const axios = require('axios'), charges = []; axios.post = async (_url, body) => { charges.push(body.bytes); return {data:{success:true}}; };
const main = require('../main'), MiB = 1048576, pattern = crypto.randomBytes(MiB), sockets = new Set();
const sizes = { '/large': (stress ? 2 * 1024 : 32) * MiB + 17, '/small1': 8 * MiB + 9, '/small2': 8 * MiB + 3, '/cancel': 16 * MiB + 37, '/weak': 2 * MiB + 7, '/kill': 64 * MiB + 11 };
let etag = '"app-generation-1"', requests = 0, child;
function bytesAt(start, length) {
  const data = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length;) { const local = (start + offset) % MiB, n = Math.min(length - offset, MiB - local); pattern.copy(data, offset, local, local + n); offset += n; }
  for (let tile = Math.floor(start / MiB); tile <= Math.floor((start + length - 1) / MiB); tile++) {
    const stamp = Buffer.alloc(8); stamp.writeUInt32LE(tile, 0); stamp.writeUInt32LE((tile ^ 0xA73B15C1) >>> 0, 4);
    const from = Math.max(start, tile * MiB), to = Math.min(start + length, tile * MiB + 8);
    if (to > from) stamp.copy(data, from - start, from - tile * MiB, to - tile * MiB);
  }
  return data;
}
const server = http.createServer((req, res) => {
  const route = req.url.split('?')[0], size = sizes[route]; if (!size) { res.writeHead(404); return res.end(); }
  requests++;
  if (req.headers['if-match'] && req.headers['if-match'] !== etag) { res.writeHead(412); return res.end(); }
  const match = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const start = match ? +match[1] : 0, end = Math.min(size - 1, match?.[2] ? +match[2] : size - 1);
  const headers = { 'Content-Length': end - start + 1, 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes' };
  if (match) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  if (route !== '/weak') headers.ETag = etag;
  res.writeHead(match ? 206 : 200, headers); if (req.method === 'HEAD') return res.end();
  let offset = start, timer;
  const send = () => {
    if (res.destroyed) return;
    const n = Math.min(128 * 1024, end + 1 - offset); res.write(bytesAt(offset, n)); offset += n;
    if (offset > end) res.end(); else timer = setTimeout(send, route === '/kill' ? 20 : stress && route === '/large' ? 15 : 6);
  };
  res.on('close', () => clearTimeout(timer)); send();
});
server.on('connection', s => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
const events = [], progress = [];
main.eventBus.on('download-status', data => events.push(data)); main.eventBus.on('download-progress', data => progress.push({...data,time:Date.now()}));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(check, ms = 30000) { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw new Error('IPC fixture timed out'); await sleep(20); } }
let base;
const file = (route, id) => ({url:base+route,name:route.slice(1)+'.bin',size:sizes[route],originalIndex:id});
const download = files => main.callIpcHandler('start-download', {files,targetDir:path.join(temp,'下载'),token:'local-fixture',maxConcurrent:3});
const final = id => events.filter(e => e.index === id && ['completed','failed','cancelled'].includes(e.status)).at(-1);
async function verify(route) {
  const expected = crypto.createHash('sha256'), actual = crypto.createHash('sha256');
  for (let at = 0; at < sizes[route]; at += MiB) expected.update(bytesAt(at, Math.min(MiB, sizes[route] - at)));
  for await (const bytes of fs.createReadStream(path.join(temp,'下载',route.slice(1)+'.bin'))) actual.update(bytes);
  const hash = actual.digest('hex'); assert.equal(hash, expected.digest('hex')); return hash;
}
const started = Date.now(), deadline = setTimeout(() => { child?.kill('SIGKILL'); console.error('NATIVE_APP_TIMEOUT'); process.exit(2); }, 480000);
(async () => {
  main.ensureBinaries(); await new Promise(r => server.listen(0,'127.0.0.1',r)); base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await main.callIpcHandler('get-settings')).downloadEngines.http, 'native');
  const batch = download([file('/large',1),file('/small1',2),file('/small2',3)]);
  await until(() => progress.some(e => e.index === 1 && e.committedBytes >= 4 * MiB));
  assert.equal((await main.callIpcHandler('pause-download',1)).suspended,true);
  const part = path.join(temp,'下载','large.bin.biodl-part'), before = fs.statSync(part).mtimeMs;
  await sleep(250); assert.equal(fs.statSync(part).mtimeMs,before,'paused writer must be closed');
  assert.equal((await main.callIpcHandler('resume-download',1)).resumed,true);
  await batch;
  for (const id of [1,2,3]) { assert.equal(final(id)?.status,'completed',JSON.stringify(final(id))); assert.equal(final(id).engine,'native'); }
  assert.deepEqual([...charges].sort((a,b)=>a-b),['/large','/small1','/small2'].map(r=>sizes[r]).sort((a,b)=>a-b));
  const largeHash = await verify('/large'); await verify('/small1'); await verify('/small2');
  const count = charges.length; await download([file('/large',4)]); assert.equal(final(4).status,'completed'); assert.equal(charges.length,count,'completed recovery must not charge again');
  const cancelled = download([file('/cancel',5)]); await until(()=>progress.some(e=>e.index===5&&e.receivedBytes>0));
  await main.callIpcHandler('cancel-download',5); await cancelled; assert.equal(final(5).status,'cancelled'); assert.equal(charges.length,count);
  etag='"app-generation-2"'; await download([file('/cancel',6)]); assert.equal(final(6).status,'failed'); assert.match(final(6).speed,/版本/); assert.equal(charges.length,count);
  etag='"app-generation-1"'; await main.callIpcHandler('save-settings',{downloadEngines:{http:'aria2',bio:'inherit'}});
  await download([file('/cancel',7)]); assert.equal(final(7).status,'completed'); assert.equal(final(7).engine,'native','native checkpoint pins engine despite preference change'); assert.equal(charges.length,count+1,'completed-after-cancel recovery reports consumption once'); await verify('/cancel');
  await main.callIpcHandler('save-settings',{downloadEngines:{http:'native',bio:'inherit'}});
  await download([file('/weak',8)]); assert.equal(final(8).status,'completed',JSON.stringify(final(8))); assert.equal(final(8).engine,'aria2'); await verify('/weak');
  const options = {files:[file('/kill',9)],targetDir:path.join(temp,'下载'),token:'local-fixture',maxConcurrent:1};
  const source = `process.env.BIODL_DATA_DIR=process.argv[1];require('axios').post=async()=>({data:{success:true}});const m=require('./main');m.eventBus.on('download-progress',e=>{if(e.committedBytes>0)process.stdout.write('DURABLE_COMMIT\\n')});m.callIpcHandler('start-download',JSON.parse(process.argv[2]));`;
  let observed=false;
  await new Promise((resolve,reject)=>{
    child=spawn(process.execPath,['-e',source,path.join(temp,'child-profile'),JSON.stringify(options)],{cwd:root,stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',b=>{if(String(b).includes('DURABLE_COMMIT')){observed=true;child.kill('SIGKILL')}});
    child.stderr.resume();child.on('error',reject);child.on('close',resolve);
  }); child=null; assert(observed,'kill must occur after main IPC received a durable block');
  await download([file('/kill',10)]); assert.equal(final(10).status,'completed',JSON.stringify(final(10))); await verify('/kill');
  const result={platform:process.platform,stress,largeBytes:sizes['/large'],largeHash,seconds:(Date.now()-started)/1000,requests,charges,mainProcessKill:true,concurrentFiles:3,progressSamples:progress.filter(e=>e.index===1).length};
  fs.mkdirSync('.evidence',{recursive:true});fs.writeFileSync(`.evidence/native-app-${process.platform}.json`,JSON.stringify(result,null,2));console.log('NATIVE_APP_OK',JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{clearTimeout(deadline);child?.kill('SIGKILL');await main.callIpcHandler('cancel-download');for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
