const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(require.resolve('../renderer.js'),'utf8');
const start=source.indexOf('async function downloadUpdate(platform)'),end=source.indexOf('\nasync function ',start+10);
const script=source.slice(start,end);
(async()=>{
 for(const fail of [false,true]){
  const jobs=[],statuses=[],elements=new Map();let opened;
  const context={console,URL,isUpdating:false,updateInfoGlobal:{latestVersion:'2.0.47',winUrl:'https://example.org/BioDownloader-Setup-2.0.47.exe'},activeDownloads:[],defaultDir:'/tmp',currentUser:null,maxConcurrentDownloadsSetting:3,
   document:{getElementById:id=>{if(!elements.has(id))elements.set(id,{innerText:'下载',disabled:false});return elements.get(id);}},
   renderDownloadingList(){},updateTransferCounts(){},showToast(){},switchTab(){},switchTransferSubTab(){},handleDownloadStatus:data=>statuses.push(data),
   window:{location:{href:'https://example.org/'},api:{getClashStatus:async()=>false,checkSize:async()=>[{size:101520057}],startDownload:async(files)=>{jobs.push(files[0]);return {outcomes:[{status:fail?'failed':'completed',speed:fail?'fixture failure':'done'}]};},openExternalUrl:url=>{opened=url;}}}};
  vm.createContext(context);vm.runInContext(script,context);await context.downloadUpdate('win');
  assert.equal(jobs[0].size,101520057);assert.equal(statuses.length,1);assert.equal(context.isUpdating,false);
  if(fail){assert(opened);assert(!elements.get('downloadWinUpdateBtn').innerText.includes('下载完成'));}
 }
 console.log('INSTALLER_DOWNLOAD_OK: real metadata size; terminal failures cannot become success');
})().catch(e=>{console.error(e);process.exitCode=1});
