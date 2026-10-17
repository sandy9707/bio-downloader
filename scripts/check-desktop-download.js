const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),http=require('http'),crypto=require('crypto');
const root=process.cwd(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-electron-batch-'));process.env.BIODL_DATA_DIR=path.join(dir,'profile');
fs.mkdirSync(process.env.BIODL_DATA_DIR,{recursive:true});fs.writeFileSync(path.join(process.env.BIODL_DATA_DIR,'settings.json'),JSON.stringify({loggingEnabled:true,token:null}));
const {app,BrowserWindow,ipcMain,session}=require('electron');app.setAppPath(root);app.getVersion=()=>require(path.join(root,'package.json')).version;
const axios=require('axios');axios.get=async()=>({data:{success:false,error:'Offline test fixture'}});let charges=0;axios.post=async(url)=>{assert(url.endsWith('/api/user/consume'));charges++;return {data:{success:true}}};
const mode='fixed';
require('../main');
ipcMain.removeHandler('clash-status');ipcMain.handle('clash-status',()=>true);
const bytes=Buffer.alloc(32768,42),server=http.createServer((req,res)=>{let start=0,end=bytes.length-1;const range=/bytes=(\d+)-(\d*)/.exec(req.headers.range||'');if(range){start=Number(range[1]);if(range[2])end=Math.min(Number(range[2]),end);res.statusCode=206;res.setHeader('Content-Range',`bytes ${start}-${end}/${bytes.length}`);}res.setHeader('Content-Length',end-start+1);res.end(req.method==='HEAD'?undefined:bytes.subarray(start,end+1));});
const timeout=setTimeout(()=>{console.error('SMOKE_TIMEOUT');app.exit(2)},60000);
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 await app.whenReady();
 const win=BrowserWindow.getAllWindows()[0]; await new Promise(r=>win.webContents.once('did-finish-load',r));
 await new Promise(r=>setTimeout(r,1000));
 const errors=[];win.webContents.on('console-message',(_,level,message)=>{if(level>=2)errors.push(message)});
 const files=Array.from({length:3},(_,i)=>({name:`test${i}.bin`,url:`http://127.0.0.1:${server.address().port}/${i}`,size:bytes.length,md5:crypto.createHash('md5').update(bytes).digest('hex')}));
 await win.webContents.executeJavaScript(`currentUser={token:'fixture',trafficLimit:1e12,trafficConsumed:0};defaultDir=${JSON.stringify(path.join(dir,'files'))};currentQueue=${JSON.stringify(files)};renderQueue();document.getElementById('downloadBtn').disabled=false;document.getElementById('downloadBtn').click();`);
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
 for (const i of [0,1]) fs.writeFileSync(path.join(dir,'files',files[i].name),Buffer.alloc(bytes.length,99));
 await win.webContents.executeJavaScript(`runCompletedMd5(completedDownloads.filter(f=>['test0.bin','test1.bin'].includes(f.name)))`);
 assert.equal(await win.webContents.executeJavaScript(`completedDownloads.filter(f=>f.verification?.status==='mismatch').length`),2);
 await win.webContents.executeJavaScript(`switchTransferSubTab('completed');document.getElementById('btnRedownloadMismatched').click();`);
 for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript(`!mismatchQueueBusy`))break;}
 assert.equal(charges,6,'one-click must redownload only two mismatches');
 let records=await win.webContents.executeJavaScript(`completedDownloads`);
 assert.equal(records.length,4,'replacement updates existing records');
 for(const file of files.slice(0,2)){const record=records.find(r=>r.name===file.name);assert.equal(record.verification.status,'verified');assert(record.backupPath);assert.deepEqual(fs.readFileSync(record.backupPath),Buffer.alloc(bytes.length,99));assert.deepEqual(fs.readFileSync(record.savePath),bytes);}
 fs.writeFileSync(path.join(dir,'files',files[0].name),Buffer.alloc(bytes.length,77));
 await win.webContents.executeJavaScript(`verifyCompletedMd5(completedDownloads.findIndex(f=>f.name===${JSON.stringify(files[0].name)}))`);
 await win.webContents.executeJavaScript(`currentQueue=${JSON.stringify(files)};renderQueue();document.getElementById('downloadBtn').disabled=false;document.getElementById('downloadBtn').click();`);
 for(let i=0;i<150;i++){await new Promise(r=>setTimeout(r,100));if(await win.webContents.executeJavaScript(`!isDownloading`))break;}
 assert.equal(charges,7,'repaste all links redownloads only confirmed mismatch');
 records=await win.webContents.executeJavaScript(`completedDownloads`);assert.equal(records.length,4);
 const replaced=records.find(r=>r.name===files[0].name);assert.equal(replaced.verification.status,'verified');assert.deepEqual(fs.readFileSync(replaced.backupPath),Buffer.alloc(bytes.length,77));
 await win.webContents.executeJavaScript(`document.getElementById('engine-http').value='axel';saveDownloadEngines()`);
 assert.equal(await win.webContents.executeJavaScript(`window.api.getSettings().then(s=>s.downloadEngines.http)`),'axel');
 await win.webContents.executeJavaScript(`document.getElementById('engine-http').value='aria2';saveDownloadEngines()`);
 assert.equal(await win.webContents.executeJavaScript(`window.api.getSettings().then(s=>s.downloadEngines.http)`),'aria2');
 fs.mkdirSync(path.join(root,'.evidence'),{recursive:true});
 await win.webContents.executeJavaScript(`switchTab('transfers-tab');switchTransferSubTab('completed');`);
 await new Promise(r=>setTimeout(r,200));
 fs.writeFileSync(path.join(root,'.evidence','desktop-'+process.platform+'.png'),(await win.webContents.capturePage()).toPNG());
 console.log('ELECTRON_SMOKE',JSON.stringify({mode,state,errors,charges}));
})().catch(e=>{console.error('ELECTRON_SMOKE_ERROR',e.message);process.exitCode=1}).finally(()=>{clearTimeout(timeout);server.closeAllConnections();server.close();app.exit(process.exitCode||0)});
