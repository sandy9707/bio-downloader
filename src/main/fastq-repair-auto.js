'use strict';
const fs=require('node:fs/promises');
const {verifyFile,validMd5,knownSize}=require('./download-integrity');
const {verifyRepairedFastq}=require('./fastq-repair-final');
const {scanFastqGzip}=require('./fastq-repair-scan');
const {probeRepairSource,fetchRepairRange}=require('./fastq-repair-network');
const {applyRepairPatch}=require('./fastq-repair-patch');
const {acquireRepairLock,checkRepairLock}=require('./fastq-repair-lock');
function failure(code,message){return Object.assign(Error(message),{code});}
// Source eligibility is resolved by the product caller, not inferred from a filename.
async function repairFastqAutomatically(options){
 const budget=Object.getOwnPropertyDescriptor(options,'maxUncompressedBytes');
 if((!budget&&'maxUncompressedBytes' in options)||(budget&&!Object.hasOwn(budget,'value')))throw failure('REPAIR_BUDGET_EXCEEDED','扫描字节预算无效');
 const {filename,sourceUrl,reference,proxy,maxTotalBytes=16*1024*1024,maxPatches=8,maxDurationMs=6*60*60*1000,maxUncompressedBytes=4*1024**4,maxLineBytes=1024*1024,checkControl=async()=>{},signal,onProgress=()=>{}}=options;
 if(!validMd5(reference?.expectedMd5)||!knownSize(reference?.expectedSize))throw failure('REPAIR_FINAL_REFERENCE_REQUIRED','需要官方大小与MD5');
 if(!Number.isSafeInteger(maxTotalBytes)||maxTotalBytes<1||maxTotalBytes>64*1024*1024||!Number.isSafeInteger(maxPatches)||maxPatches<1||maxPatches>30)throw failure('REPAIR_BUDGET_EXCEEDED','修复预算无效');
 if(!Number.isSafeInteger(maxDurationMs)||maxDurationMs<1||maxDurationMs>24*60*60*1000||![maxUncompressedBytes,maxLineBytes].every(n=>Number.isSafeInteger(n)&&n>0))throw failure('REPAIR_BUDGET_EXCEEDED','扫描时长或字节预算无效');
 const started=performance.now();
 function remaining(){const value=Math.ceil(maxDurationMs-(performance.now()-started));if(value<=0)throw failure('REPAIR_TIME_BUDGET_EXCEEDED','达到局部修复时长预算，文件与证据保留');return value;}
 const owned=await acquireRepairLock(filename);let primaryError,fetchedBytes=0,version;
 const patches=[];let identity;
 async function control(context={}){if(context.signal?.aborted)throw context.signal.reason;checkRepairLock(owned.lease,filename);if(signal?.aborted)throw failure('ABORT_ERR','Cancelled');remaining();await checkControl(context);if(context.signal?.aborted)throw context.signal.reason;remaining();const current=await fs.lstat(filename);if(current.isSymbolicLink()||['dev','ino','size','mtimeMs','ctimeMs'].some(key=>current[key]!==identity[key]))throw failure('FASTQ_SOURCE_CHANGED','自动修复期间文件变化');}
 try{
  identity=await fs.lstat(filename);
  await control();
  const initial=await verifyFile(filename,{...reference,gzip:true},{deep:true,checkControl:control});
  if(initial.status!=='verified'&&initial.status!=='mismatch')throw failure('REPAIR_NOT_APPLICABLE','不符合局部修复前提');
  if(initial.status==='mismatch'){
   const pending=(await require('./fastq-repair-recovery').discoverRepairTransactions(filename)).filter(item=>['recovery-required','recover-or-verify'].includes(item.action));
   if(pending.length)throw Object.assign(failure('REPAIR_RECOVERY_REQUIRED','先处理未完成修补事务'),{transactions:pending.map(item=>item.directory)});
  }
  async function applyCandidate(candidate,requestSignal=signal){
   const patchControl=async()=>{if(requestSignal?.aborted)throw requestSignal.reason||failure('ABORT_ERR','Cancelled');await control({signal:requestSignal});};
   if(initial.status==='verified')throw failure('REPAIR_PROFILE_UNSUPPORTED','官方MD5匹配但结构不符合当前配置，禁止修补');
   const length=candidate.end-candidate.start;
   if(patches.length>=maxPatches||fetchedBytes+length>maxTotalBytes)throw failure('REPAIR_BUDGET_EXCEEDED','达到局部修复预算，文件与补丁证据保留');
   await patchControl();version ||= await probeRepairSource(sourceUrl,reference.expectedSize,{proxy,signal:requestSignal,timeoutMs:Math.min(60000,remaining())});
   const expected={...candidate,size:reference.expectedSize,etag:version.etag,maxBytes:Math.min(16*1024*1024,maxTotalBytes-fetchedBytes)};
   onProgress({phase:'repair-fetch',fetchedBytes,start:expected.start,end:expected.end});
   const data=await fetchRepairRange(sourceUrl,expected,{proxy,signal:requestSignal,timeoutMs:Math.min(60000,remaining())});fetchedBytes+=data.length;
   const patch=await applyRepairPatch({filename,sourceUrl,expected,response:{status:206,headers:{etag:version.etag,'content-range':`bytes ${expected.start}-${expected.end-1}/${expected.size}`},data},expectedIdentity:identity,lease:owned.lease,checkControl:patchControl});
   if(patch.status==='unchanged')throw failure('REPAIR_CANDIDATE_UNCHANGED','候选区段与源站一致，不能继续猜测修补');
   patches.push(patch);identity=patch.identity;
   return {patched:true};
  }
   // This preview ships only the bounded JavaScript diagnostic scanner.
   while(true){
   let candidate;
   try{await scanFastqGzip(filename,{checkControl:control,maxUncompressedBytes,maxLineBytes,onProgress:progress=>onProgress({phase:'repair-scan',...progress})});}
   catch(error){if(error.candidate?.heuristic)candidate=error.candidate;else if(error.code==='FASTQ_GZIP_INVALID')throw Object.assign(failure('REPAIR_CANDIDATE_REQUIRED','gzip错误不能可靠定位坏块，文件保留'),{cause:error});else throw error;}
   if(!candidate)break;
   await applyCandidate(candidate);
  }
  const verified=await verifyRepairedFastq(filename,reference,{checkControl:control,onProgress,expectedIdentity:identity,maxUncompressedBytes,maxLineBytes});
  await control();await require('./fastq-repair-seal').sealRepairPatches(patches,verified,identity);
  return {...verified,fetchedBytes,patches};
 }catch(error){primaryError=error;error.repair={fetchedBytes,patches};throw error;}
 finally{try{await owned.release();}catch(error){if(primaryError)primaryError.cleanupErrors=[...(primaryError.cleanupErrors||[]),error];else throw error;}}
}
module.exports={repairFastqAutomatically};
