const assert=require('node:assert/strict'), fs=require('fs'), vm=require('vm'), path=require('path');
const source=fs.readFileSync(path.join(__dirname,'../renderer.js'),'utf8');
function harness(overrides={}) {
  const calls=[];
  const api={resumeDownload:async()=>({success:true,resumed:false}), getClashStatus:async()=>false,
    startClash:async()=>calls.push('connect'),startDownload:async(...args)=>calls.push(['download',...args]),
    extractionPause:async()=>({success:false,error:'no active download'}),extractionDownload:async data=>{calls.push(['extract',data]);return {success:true};},...overrides};
  const context=vm.createContext({Date,Set,Promise,Array,Math,console,currentUser:{token:'fixture'},defaultDir:'new-default',
    maxConcurrentDownloadsSetting:2,activeDownloads:[],failedDownloads:[],extractionJobs:{},
    window:{api},document:{getElementById:()=>null},showToast:(...args)=>calls.push(['toast',...args]),
    switchTab(){},switchTransferSubTab(){},renderDownloadingList(){},renderFailedList(){},updateTransferCounts(){},renderExtractionTransferCards(){}});
  vm.runInContext(source.slice(source.indexOf('let transferConnectionPromise'),source.indexOf('// ---- 全部任务操作')),context);
  vm.runInContext(source.slice(source.indexOf('async function resumeExtractionDownload'),source.indexOf('async function cancelExtractionDownload')),context);
  return {context,calls,api};
}
(async()=>{
  const h=harness(), task={name:'partial.sra',url:'https://example.invalid/a',originalIndex:9,status:'paused',targetDir:'original-dir',receivedBytes:100,md5:'12345678901234567890123456789012'};
  h.context.activeDownloads.push(task);
  await Promise.all([h.context.resumeSingleDownload(9),h.context.resumeSingleDownload(9)]);
  const starts=h.calls.filter(x=>Array.isArray(x)&&x[0]==='download');
  assert.equal(starts.length,1,'rapid double click must start only one transfer');
  assert.equal(starts[0][2],'original-dir');
  assert.equal(starts[0][1][0].md5,task.md5,'resume must retain checksum across application restarts');
  assert.ok(h.calls.indexOf('connect')<h.calls.indexOf(starts[0]),'accelerator must reconnect before download');
  const direct=harness({getClashStatus:async()=>assert.fail('direct resume must retain the original route')});
  const original={...task, status:'paused', originalIndex:11, networkMode:'direct', engine:'native', folder:'run', sourceName:'official.fastq.gz', transport:'https'};
  direct.context.activeDownloads.push(original);
  await Promise.all([direct.context.resumeSingleDownload(11),direct.context.resumeSingleDownload(11)]);
  const restarts=direct.calls.filter(call=>Array.isArray(call)&&call[0]==='download');
  assert.equal(restarts.length,1);assert.equal(restarts[0][2],original.targetDir);
  for (const key of ['networkMode','url','name','folder','originalIndex','md5','sourceName','transport']) assert.equal(restarts[0][1][0][key],original[key],key);
  assert.equal(restarts[0][1][0].downloadEngine,'native');
  h.api.startDownload=async()=>{throw Error('fixture startup failure');};task.status='paused';
  await h.context.resumeSingleDownload(9);
  assert.equal(task.status,'paused');assert.equal(task.receivedBytes,100);
  h.api.resumeDownload=async()=>({success:false,error:'OS resume failed'});
  await h.context.resumeSingleDownload(9);assert.equal(task.status,'paused');
  const f={name:'failed.sra',url:'https://example.invalid/b',targetDir:'failed-dir',fileObj:{md5:task.md5}};
  h.context.failedDownloads.push(f);h.context.currentUser=null;
  await h.context.retryFailedDownload(0);assert.equal(h.context.failedDownloads.length,1);
  h.context.currentUser={token:'fixture'};
  await h.context.retryFailedDownload(0);
  assert.equal(h.context.failedDownloads.length,0);
  assert.equal(h.context.activeDownloads[1].name,'failed.sra');
  assert.equal(h.context.activeDownloads[1].url,f.url);
  assert.equal(h.context.activeDownloads[1].targetDir,'failed-dir');
  assert.equal(h.context.activeDownloads[1].md5,task.md5,'retry must retain the expected checksum');
  assert.equal(h.context.activeDownloads[1].status,'paused');
  const historic=harness({getClashStatus:async()=>assert.fail('direct retry connected')});
  const oldSra={name:'renamed.sra',fileObj:{name:'renamed.sra',url:'https://sra-pub-run-odp.s3.amazonaws.com/sra/ERR12/ERR12',sourceName:'ERR12.sra',format:'sra',networkMode:'direct',downloadEngine:'aria2',targetDir:'original'}};
  historic.context.failedDownloads.push(oldSra);await historic.context.retryFailedDownload(0);
  const retry=historic.calls.find(c=>c[0]==='download');assert.equal(retry[1].length,1);
  for (const key of ['url','sourceName','name','format','networkMode','downloadEngine','targetDir']) assert.equal(retry[1][0][key],oldSra.fileObj[key]);
  const mismatch = harness();
  Object.assign(mismatch.context, {manualMd5Run:null, syncTransfersToStorage(){}, ensureTransferConnection:async()=>{ throw Error('direct redownload contacted accelerator'); }});
  vm.runInContext(source.slice(source.indexOf('let mismatchQueueBusy'),source.indexOf('// Manual MD5 checks')),mismatch.context);
  const expectedMd5 = 'd'.repeat(32);
  const item = {name:'local.fastq.gz',url:'https://example.invalid/official.fastq.gz',size:80,savePath:'/original/run/local.fastq.gz',engine:'native',
    verification:{status:'mismatch',expectedMd5},fileObj:{sourceName:'official.fastq.gz',format:'fastq',transport:'https',sourceSelection:'manual',networkMode:'direct'}};
  await mismatch.context.queueMismatches([item,item]);
  const [redownload] = mismatch.calls.filter(call=>Array.isArray(call)&&call[0]==='download');
  assert.equal(redownload[1].length,1);
  const [job] = redownload[1];
  for (const key of Object.keys(item.fileObj)) assert.equal(job[key],item.fileObj[key]);
  assert.equal(job.targetDir,'/original/run/');assert.equal(job.downloadEngine,'native');assert.equal(job.md5,expectedMd5);
  const ex={id:'restored-ex',url:'https://example.invalid/c',name:'extract.fastq',paused:true,saveDir:'ex-dir',received:200,total:900};
  h.context.extractionJobs[ex.id]=ex;
  await Promise.all([h.context.resumeExtractionDownload(ex.id),h.context.resumeExtractionDownload(ex.id)]);
  const extractions=h.calls.filter(x=>Array.isArray(x)&&x[0]==='extract');
  assert.equal(extractions.length,1);assert.equal(extractions[0][1].saveDir,'ex-dir');
  assert.equal(extractions[0][1].replacesId,ex.id);assert.equal(h.context.extractionJobs[ex.id],ex);
  const failedEx={...ex,type:'extraction'};h.context.failedDownloads.push(failedEx);
  await h.context.retryFailedDownload(0);
  assert.equal(h.calls.filter(x=>Array.isArray(x)&&x[0]==='extract').length,2);
  let running=0,peak=0;
  const many=harness({getClashStatus:async()=>true,startDownload:async()=>{running++;peak=Math.max(peak,running);await new Promise(r=>setTimeout(r,10));running--;}});
  many.context.failedDownloads.push(...Array.from({length:5},(_,i)=>({name:'file'+i,url:'https://example.invalid/'+i})));
  await many.context.retryAllFailedDownloads();assert.equal(peak,2);assert.equal(many.context.failedDownloads.length,0);
  assert.equal(new Set(many.context.activeDownloads.map(x=>x.originalIndex)).size,5);
  console.log('恢复下载回归通过: 重连、原目录、重复点击、启动失败保留、未登录保留、提取路由、批量重试并发');
})().catch(error=>{console.error(error);process.exitCode=1;});
