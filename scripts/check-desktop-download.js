const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),http=require('http'),crypto=require('crypto');
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-electron-batch-'));process.env.BIODL_DATA_DIR=path.join(dir,'profile');
fs.mkdirSync(process.env.BIODL_DATA_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.BIODL_DATA_DIR,'settings.json'),JSON.stringify({loggingEnabled:true,token:null}));
const {app,BrowserWindow,ipcMain,session}=require('electron');app.setAppPath(root);app.getVersion=()=>require(path.join(root,'package.json')).version;
const axios=require('axios');axios.get=async()=>({data:{success:false,error:'Offline test fixture'}});let charges=0;axios.post=async(url)=>{assert(url.endsWith('/api/user/consume'));charges++;return {data:{success:true}}};
const mode='fixed';
require('../main');
ipcMain.removeHandler('clash-status');ipcMain.handle('clash-status',()=>true);
let slowTransfer=true;
const slowBytes=Buffer.alloc(32*1024*1024,42);
const bytes=Buffer.alloc(32768,42),server=http.createServer((req,res)=>{const bytes=req.url==='/slow'?slowBytes:Buffer.alloc(32768,42);let start=0,end=bytes.length-1;const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');if(range){start=Number(range[1]);if(range[2])end=Math.min(Number(range[2]),end);res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`);}res.setHeader('Content-Length',end-start+1);if(req.url==='/slow'&&req.method!=='HEAD'){let timer,at=start;const send=()=>{if(res.destroyed)return;const next=Math.min(end+1,at+(slowTransfer?4096:65536));res.write(bytes.subarray(at,next));at=next;if(at>end)res.end();else timer=setTimeout(send,slowTransfer?200:1);};res.on('close',()=>clearTimeout(timer));send();}else res.end(req.method==='HEAD'?undefined:bytes.subarray(start,end+1));});
const timeout=setTimeout(()=>{console.error('SMOKE_TIMEOUT');app.exit(2)},60000);
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await app.whenReady();
 const win=BrowserWindow.getAllWindows()[0];win.webContents.setBackgroundThrottling(false); await new Promise(r=>win.webContents.once('did-finish-load',r));
 await new Promise(r=>setTimeout(r,1000));
 const errors=[];win.webContents.on('console-message',(_,level,message)=>{if(level>=2)errors.push(message)});
 const files=Array.from({length:3},(_,i)=>({name:`test${i}.bin`,url:`http://127.0.0.1:${server.address().port}/${i}`,size:bytes.length,md5:crypto.createHash('md5').update(bytes).digest('hex')}));
 await win.webContents.executeJavaScript(`currentUser={token:'fixture',trafficLimit:1e12,trafficConsumed:0};defaultDir=${JSON.stringify(path.join(dir,'下载 files'))};currentQueue=${JSON.stringify(files)};renderQueue();document.getElementById('downloadBtn').disabled=false;document.getElementById('downloadBtn').click();`);
 let state;
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,200));state=await win.webContents.executeJavaScript(`({downloading:isDownloading,active:activeDownloads.map(f=>({name:f.name,status:f.status})),completed:completedDownloads.length,failed:failedDownloads.length,toast:document.getElementById('notificationToast').innerText})`);if(state.completed===3||!state.downloading)break;}
 assert.equal(state.completed,3,JSON.stringify({state,errors}));assert.equal(charges,3);assert.match(state.toast,/完成 3/);
 if(mode==='fixed'){
  await win.webContents.executeJavaScript(`switchTransferSubTab('completed');verifyAllCompletedMd5();`);
  for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript(`manualMd5Run===null`))break;}
  const verified=await win.webContents.executeJavaScript(`completedDownloads.map(f=>f.verification?.status)`);assert(verified.every(s=>s==='verified'),JSON.stringify(verified));assert.equal(charges,3);
 }
 const single={...files[0],name:'single.bin'};
 await win.webContents.executeJavaScript(`currentQueue=${JSON.stringify([single])};renderQueue();document.getElementById('btn-single-dl-0').click();`);
 let singleCount=0;
 for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,100));singleCount=await win.webContents.executeJavaScript(`completedDownloads.length`);if(singleCount===4)break;}
 assert.equal(singleCount,4,'single-file button must still complete');assert.equal(charges,4);
 // Native Electron: both user-requested entry points must actually download.
 for (const i of [0,1]) fs.writeFileSync(path.join(dir,'下载 files',files[i].name),Buffer.alloc(bytes.length,99));
 await win.webContents.executeJavaScript(`runCompletedMd5(completedDownloads.filter(f=>['test0.bin','test1.bin'].includes(f.name)))`);
 assert.equal(await win.webContents.executeJavaScript(`completedDownloads.filter(f=>f.verification?.status==='mismatch').length`),2);
 await win.webContents.executeJavaScript(`switchTransferSubTab('completed');document.getElementById('btnRedownloadMismatched').click();`);
 for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript(`!mismatchQueueBusy`))break;}
 assert.equal(charges,6,'one-click must redownload only two mismatches');
 let records=await win.webContents.executeJavaScript(`completedDownloads`);
 assert.equal(records.length,4,'replacement updates existing records');
 for(const file of files.slice(0,2)){const record=records.find(r=>r.name===file.name);assert.equal(record.verification.status,'verified');assert(record.backupPath);assert.deepEqual(fs.readFileSync(record.backupPath),Buffer.alloc(bytes.length,99));assert.deepEqual(fs.readFileSync(record.savePath),bytes);}
 fs.writeFileSync(path.join(dir,'下载 files',files[0].name),Buffer.alloc(bytes.length,77));
 await win.webContents.executeJavaScript(`verifyCompletedMd5(completedDownloads.findIndex(f=>f.name===${JSON.stringify(files[0].name)}))`);
 await win.webContents.executeJavaScript(`currentQueue=${JSON.stringify(files)};renderQueue();document.getElementById('downloadBtn').disabled=false;document.getElementById('downloadBtn').click();`);
 for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript(`!isDownloading`))break;}
 assert.equal(charges,7,'repaste all links redownloads only confirmed mismatch');
 records=await win.webContents.executeJavaScript(`completedDownloads`);assert.equal(records.length,4);
 const replaced=records.find(r=>r.name===files[0].name);assert.equal(replaced.verification.status,'verified');assert.deepEqual(fs.readFileSync(replaced.backupPath),Buffer.alloc(bytes.length,77));
 await win.webContents.executeJavaScript(`switchTab('settings-tab');document.getElementById('configureDownloaders').click();`);
 assert.equal(await win.webContents.executeJavaScript(`currentTab`),'download-engines-tab');
 assert.equal(await win.webContents.executeJavaScript(`document.querySelectorAll('#download-engines-tab select').length`),5);
 fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
 await win.webContents.executeJavaScript(`document.getAnimations().forEach(a=>a.finish())`);
 await new Promise(r=>setTimeout(r,600));
 fs.writeFileSync(path.join(root,'.evidence','settings-engines-'+process.platform+'.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript(`document.getElementById('engine-http').value='axel';saveDownloadEngines()`);
 assert.equal(await win.webContents.executeJavaScript(`window.api.getSettings().then(s=>s.downloadEngines.http)`),'axel');
 await win.webContents.executeJavaScript(`document.getElementById('engine-http').value='aria2';saveDownloadEngines()`);
 assert.equal(await win.webContents.executeJavaScript(`window.api.getSettings().then(s=>s.downloadEngines.http)`),'aria2');
 fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
 await win.webContents.executeJavaScript(`document.getElementById('backToSettings').click();document.getElementById('settingsDeepIntegrityToggle').scrollIntoView({block:'center'});`);
 assert.equal(await win.webContents.executeJavaScript(`currentTab`),'settings-tab');
 const toggleSizes=await win.webContents.executeJavaScript(`['settingsDeepIntegrityToggle','settingsLowPowerToggle','settingsLoggingToggle'].map(id=>{const r=document.getElementById(id).parentElement.getBoundingClientRect();return [r.width,r.height];})`);
 assert(toggleSizes.every(([w,h])=>w===44&&h===24),JSON.stringify(toggleSizes));
 await win.webContents.executeJavaScript(`document.getAnimations().forEach(a=>a.finish())`);
 await new Promise(r=>setTimeout(r,600));
 fs.writeFileSync(path.join(root,'.evidence','settings-md5-'+process.platform+'.png'),(await win.webContents.capturePage()).toPNG());
 await win.webContents.executeJavaScript(`switchTab('transfers-tab');switchTransferSubTab('completed');`);
 await new Promise(r=>setTimeout(r,200));
 fs.writeFileSync(path.join(root,'.evidence','desktop-'+process.platform+'.png'),(await win.webContents.capturePage()).toPNG());
 // Exercise the actual renderer while native aria2 downloads sparse ranges slowly.
 const slowFile={name:'slow-progress.bin',url:`http://127.0.0.1:${server.address().port}/slow`,size:slowBytes.length};
 await win.webContents.executeJavaScript(`currentQueue=${JSON.stringify([slowFile])};renderQueue();document.getElementById('downloadBtn').disabled=false;document.getElementById('downloadBtn').click();`);
 let visible;
 for(let i=0;i<100;i++){
  await new Promise(r=>setTimeout(r,100));
  visible=await win.webContents.executeJavaScript(`(()=>{const f=activeDownloads.find(f=>f.name==='slow-progress.bin');return f&&{...f};})()`);
  if(visible?.receivedBytes>0)break;
 }
 assert(visible?.receivedBytes>0,'native aria2 must update the real UI before completion');
 assert(visible.percentage>0&&visible.percentage<10,JSON.stringify(visible));
 const displayed=await win.webContents.executeJavaScript(`(()=>{
  const f=activeDownloads.find(f=>f.name==='slow-progress.bin'),id=f.originalIndex;
  const read=()=>['trans-pct-','trans-size-','trans-eta-'].map(p=>document.getElementById(p+id).innerText);
  const before=read();renderDownloadingList();const after=read();
  return {before,after,expected:[transferProgressView(f).percentage+'%',formatBytes(f.receivedBytes)+' / '+formatBytes(f.totalBytes),computeEta(f.totalBytes-f.receivedBytes,f.speed)]};
 })()`);
 assert.deepEqual(displayed.before,displayed.after,'re-render must not change progress, bytes or ETA');
 assert.deepEqual(displayed.after,displayed.expected,'all three indicators must use the same counters');
 await win.webContents.executeJavaScript(`document.getAnimations().forEach(a=>a.finish())`);
 fs.writeFileSync(path.join(root,'.evidence','progress-'+process.platform+'.png'),(await win.webContents.capturePage()).toPNG());
 slowTransfer=false;
 for(let i=0;i<200;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript(`!isDownloading`))break;}
 assert.equal(await win.webContents.executeJavaScript(`completedDownloads.some(f=>f.name==='slow-progress.bin')`),true);
 assert.deepEqual(fs.readFileSync(path.join(dir,'下载 files',slowFile.name)),slowBytes);
 console.log('ELECTRON_PROGRESS_OK',JSON.stringify(displayed));
 console.log('ELECTRON_SMOKE',JSON.stringify({mode,state,errors,charges}));
})().catch(e=>{console.error('ELECTRON_SMOKE_ERROR',e.message);process.exitCode=1}).finally(()=>{clearTimeout(timeout);server.closeAllConnections();server.close();app.exit(process.exitCode||0)});
