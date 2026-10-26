'use strict';
// Exercise actual main IPC, bundled aria2 and the native worker. The uploaded
// file must retain the original guard failure, even when aria2 is killed first.
const fs = require('fs'), path = require('path'), os = require('os'), http = require('http');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-log-测试-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
const {errorDetails, formatDiagnostic} = require('../src/main/download-diagnostics');
const sample = Object.assign(new Error('GET https://user:credential@example.org/a?token=URL_SECRET#fragment Bearer AUTH_SECRET'), {code:'ECONNRESET', config:{headers:{Authorization:'CONFIG_SECRET'}}});
const encoded = formatDiagnostic({type:'fixture',error:errorDetails(sample)});
for (const secret of ['credential','URL_SECRET','AUTH_SECRET','CONFIG_SECRET','fragment']) assert(!encoded.includes(secret),secret);
const transport = require('../src/main/bio-transfer-guard');
transport.bioSource = url => url.includes('/guard/') ? url : null;
const axios = require('axios'), charges=[]; axios.post = async (_url,body)=>{charges.push(body);return {data:{success:true}};};
const main = require('../main'), data=Buffer.alloc(4*1024*1024,71), events=[];
main.eventBus.on('download-status',e=>events.push(e));
let mode='short', timer;
const sockets=new Set();
const server=http.createServer((req,res)=>{
  if(mode==='503'||mode==='403'){res.writeHead(Number(mode));res.end();return;}
  const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
  const start=m?Number(m[1]):0,end=m?.[2]?Number(m[2]):data.length-1;
  res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${mode==='range'&&end>0?start+1:start}-${end}/${data.length}`,ETag:'"log-fixture"'});
  if(mode==='short'&&end-start>4096){res.write(data.subarray(start,start+16384));setTimeout(()=>res.destroy(),20);}
  else res.end(data.subarray(start,end+1));
});
server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s));});
async function run(name,engine,loggingEnabled=true){
  await main.callIpcHandler('save-settings',{loggingEnabled,downloadEngines:{http:engine,bio:'inherit'}});
  const before=new Set(fs.existsSync(path.join(temp,'profile','download_logs'))?fs.readdirSync(path.join(temp,'profile','download_logs')):[]);
  await main.callIpcHandler('start-download',{files:[{name,url:`http://127.0.0.1:${server.address().port}/${engine==='aria2'?'guard/':''}${name}`,size:data.length,originalIndex:events.length+1}],targetDir:temp,token:'fixture-never-sent',maxConcurrent:1});
  const dir=path.join(temp,'profile','download_logs');
  const files=fs.existsSync(dir)?fs.readdirSync(dir).filter(f=>!before.has(f)):[];
  const listed=await main.callIpcHandler('get-logs-list');
  for(const f of files) assert(listed.some(log=>log.name===f),'diagnostic must appear in upload picker');
  const text=(await Promise.all(files.map(f=>main.callIpcHandler('read-log-content',f)))).join('\n');
  const records=text.split('\n').filter(s=>s.startsWith('[diagnostic] ')).map(s=>JSON.parse(s.slice(13)));
  assert.equal(events.at(-1).status,'failed');
  return {files,text,records};
}
(async()=>{
  timer=setTimeout(()=>{console.error('DIAGNOSTIC_TIMEOUT');process.exit(2);},90000);
  main.ensureBinaries(); await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const short=await run('short.bin','aria2');
  const fatal=short.records.find(r=>r.type==='fatal');assert.equal(fatal.error.code,'ECONNRESET');assert(fatal.error.range);assert(fatal.error.receivedBytes>0);
  const terminal=short.records.find(r=>r.type==='attempt-failed');assert.equal(terminal.error.cause.code,'ECONNRESET');assert.equal(terminal.guardStopped,true);
  assert(short.records.some(r=>r.type==='task-result'&&r.status==='failed'));
  assert(short.records.some(r=>r.type==='segment-error'&&r.failures===3));
  assert(short.records.every(r=>Number.isFinite(Date.parse(r.time))));
  assert(fs.existsSync(path.join(temp,'short.bin.aria2')),'preserve actual aria2 checkpoint');
  mode='range';const range=await run('range.bin','aria2');assert(range.records.some(r=>r.type==='fatal'&&r.error.httpStatus===206));
  mode='503';const prepare=await run('probe.bin','aria2');assert(prepare.records.some(r=>r.type==='request-error'&&r.attempt===3));assert(prepare.records.some(r=>r.type==='task-failed'&&r.error.httpStatus===503));
  assert.equal(prepare.files.length,1,'preparation cause and final result belong in the same uploadable log');
  const nativeRetries=[];
  const {NativeTransfer}=require('../src/main/native-transfer');
  const retryTask=new NativeTransfer({url:`http://127.0.0.1:${server.address().port}/retry`,filename:path.join(temp,'retry-native.bin'),proxy:false,retryBaseMs:5,retryMaxMs:5,retryBudgetMs:60,onEvent:e=>nativeRetries.push(e)});
  await assert.rejects(retryTask.run(),e=>e.code==='NETWORK_WAIT'&&e.cause.code==='HTTP_503');
  assert(nativeRetries.some(r=>r.type==='retry'&&r.error.httpStatus===503));
  assert(nativeRetries.some(r=>r.type==='failure'&&r.error.cause.httpStatus===503));
  mode='403';const native=await run('native.bin','native');assert(native.records.some(r=>r.type==='failure'&&r.error.httpStatus===403));assert(native.records.some(r=>r.type==='attempt-failed'&&r.nativeError.code==='HTTP_403'));
  const disabled=await run('disabled.bin','native',false);assert.equal(disabled.files.length,0);
  assert.equal(charges.length,0,'failed transfers must not report successful usage');
  const result={platform:process.platform,checks:['original stream reset and range','guard fatal before process kill','attempt terminal flush','source validation status','preparation retries','native worker error detail','logging disabled','credentials redacted','checkpoints preserved','no success billing'],passed:true};
  fs.mkdirSync('.evidence',{recursive:true});fs.writeFileSync(`.evidence/download-diagnostics-${process.platform}.json`,JSON.stringify(result,null,2));
  console.log('DOWNLOAD_DIAGNOSTICS_OK',JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  clearTimeout(timer);await main.callIpcHandler('cancel-download');for(const s of sockets)s.destroy();server.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
