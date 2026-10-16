const assert = require('node:assert/strict');
const fs = require('fs'), vm = require('vm'), path = require('path'), os = require('os'), http = require('http');
const source = fs.readFileSync(path.join(__dirname, '../renderer.js'), 'utf8');
function harness(startDownload) {
  const elements = new Map(), messages = [], calls = [];
  const el = id => { if (!elements.has(id)) elements.set(id, { style: {}, disabled: false, hidden: true }); return elements.get(id); };
  let id = 10000;
  const context = vm.createContext({ console, Set, Date, currentUser: { token: 'fixture', trafficLimit: 1e12, trafficConsumed: 0 },
    defaultDir: 'G:\\batch03-https', currentQueue: [{name:'a',url:'https://example.invalid/a',size:100}], activeDownloads: [], completedDownloads: [], failedDownloads: [],
    maxConcurrentDownloadsSetting: 3, isDownloading: false, window: { api: {startDownload} }, document: {getElementById:el},
    ensureTransferConnection: async()=>true, allocateTransferId:()=>++id, formatBytes:String,
    switchTab:tab=>calls.push(tab), switchTransferSubTab(){}, renderDownloadingList(){}, updateTransferCounts(){}, refreshUserInfo:async()=>{},
    showToast:(...m)=>messages.push(m) });
  vm.runInContext(source.slice(source.indexOf('async function startDownload()'),source.indexOf('async function cancelDownload()')),context);
  return {context,elements,messages,calls};
}
(async()=>{
  const failure=harness(async()=>{throw Error('fixture IPC startup failure');});
  await failure.context.startDownload();
  assert.equal(failure.context.activeDownloads.length,1);
  assert.equal(failure.context.activeDownloads[0].status,'paused');
  assert.match(failure.messages.at(-1)[0],/fixture IPC startup failure/);
  assert.equal(failure.messages.at(-1)[1],'error');
  assert.equal(failure.elements.get('transferBatchError').hidden,false);
  assert.equal(failure.context.isDownloading,false);
  assert.equal(failure.elements.get('downloadBtn').disabled,false);
  let starts=0, release;
  const ok=harness(async files=>{starts++; assert.equal(files[0].name,'a'); await new Promise(r=>release=r);});
  let connect;
  ok.context.ensureTransferConnection=()=>new Promise(r=>connect=r);
  const pending=ok.context.startDownload();
  ok.context.currentQueue=[{name:'wrong',url:'https://example.invalid/wrong'}];
  await ok.context.startDownload(); // double click must not dispatch twice
  connect(true); await new Promise(r=>setImmediate(r));
  release();await pending;
  assert.equal(starts,1);
  assert.ok(ok.context.activeDownloads[0].originalIndex>9999);
  const empty=harness(async()=>{throw Error('must not start');});empty.context.currentQueue=[];await empty.context.startDownload();assert.equal(empty.calls.length,0);

  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-batch-'));
  process.env.BIODL_DATA_DIR=path.join(temp,'profile');
  const axios=require('axios');let charges=0;
  axios.post=async(url)=>{assert.ok(url.endsWith('/api/user/consume'));charges++;return {data:{success:true}};};
  const engine=require('../main');engine.ensureBinaries();
  const payload=Buffer.alloc(65536,42), events=[];
  const server=http.createServer((req,res)=>{
    let start=0,end=payload.length-1;
    const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
    if(range){start=Number(range[1]);if(range[2])end=Math.min(Number(range[2]),end);res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${payload.length}`);}
    res.setHeader('Content-Length',end-start+1);res.end(req.method==='HEAD'?undefined:payload.subarray(start,end+1));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  engine.eventBus.on('download-status',e=>events.push(e));
  const statfs=fs.promises.statfs;
  try {
    const dest=path.join(temp,'files'),files=Array.from({length:3},(_,i)=>({name:`file${i}.bin`,url:`http://127.0.0.1:${server.address().port}/${i}`,size:payload.length,originalIndex:10000+i}));
    await assert.rejects(engine.callIpcHandler('start-download',{files:[],targetDir:dest}),/队列为空/);
    fs.promises.statfs=async()=>({bavail:0,bsize:4096});
    await assert.rejects(engine.callIpcHandler('start-download',{files,targetDir:dest}),/可用空间不足/);
    assert.equal(charges,0);assert.equal(events.length,0);
    fs.promises.statfs=statfs;
    await engine.callIpcHandler('cancel-download',0); // stale legacy ID cannot cancel this batch
    await engine.callIpcHandler('start-download',{files,targetDir:dest,token:'fixture',maxConcurrent:2});
    assert.equal(events.filter(e=>e.status==='completed').length,3);assert.equal(charges,3);
    for(const file of files)assert.deepEqual(fs.readFileSync(path.join(dest,file.name)),payload);
    const {additionalSpace}=require('../src/main/download-space');
    assert.equal(await additionalSpace(files,f=>path.join(dest,f.name)),0);
    events.length=0;
    fs.promises.statfs=async()=>({bavail:0,bsize:4096});
    await engine.callIpcHandler('start-download',{files,targetDir:dest,token:'fixture',maxConcurrent:-2});
    assert.equal(events.filter(e=>e.status==='completed').length,3,'existing complete files need no duplicate free space and invalid concurrency cannot hang');
    assert.equal(charges,3,'skips must not charge again');
  } finally {fs.promises.statfs=statfs;server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true});}
  console.log('批量启动回归通过：真实三文件传输、并发、旧取消标记、启动报错保留、重复点击、切换队列、已有文件空间、空队列');
})().catch(e=>{console.error(e);process.exitCode=1;});
