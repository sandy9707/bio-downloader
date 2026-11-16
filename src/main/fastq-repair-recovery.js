'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const {validateRepairHeaders}=require('./fastq-repair-range');
function invalid(message){throw Object.assign(Error('修补恢复证据无效：'+message),{code:'REPAIR_EVIDENCE_INVALID'});}
async function readBounded(filename,limit){
 const stat=await fs.lstat(filename);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>limit)invalid('证据文件类型或大小不符');
 const handle=await fs.open(filename,'r');
 try{const data=Buffer.alloc(limit+1);let offset=0;while(offset<data.length){const r=await handle.read(data,offset,data.length-offset,offset);if(!r.bytesRead)break;offset+=r.bytesRead;}if(offset>limit)invalid('证据超过读取上限');return data.subarray(0,offset);}finally{await handle.close();}
}
async function json(filename){try{return JSON.parse((await readBounded(filename,65536)).toString('utf8'));}catch(error){if(error.code==='ENOENT')throw error;invalid('JSON不可读或损坏');}}
async function marker(directory,name){try{const value=await json(path.join(directory,name+'.json'));if(value.version!==1||value.state!==name)invalid('状态标记不符');return value;}catch(error){if(error.code==='ENOENT')return null;throw error;}}
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
async function inspectRepairTransaction(filename,directory){
 const parent=await fs.realpath(path.dirname(filename));
 const folder=await fs.lstat(directory);
 if(folder.isSymbolicLink()||!folder.isDirectory()||path.dirname(await fs.realpath(directory))!==parent||!/^\.biodl-repair-[0-9a-f-]{36}$/.test(path.basename(directory)))invalid('恢复目录不属于目标父目录');
 const record=await json(path.join(directory,'record.json'));
 if(record.version!==1||record.state!=='backed-up'||record.filename!==path.basename(filename))invalid('目标记录不符');
 const sealed=await marker(directory,'verified');
 if(sealed){
  if(!/^[a-f0-9]{32}$/.test(sealed.expectedMd5)||sealed.size!==record.size||sealed.fileIdentity?.dev!==record.fileIdentity?.dev||sealed.fileIdentity?.ino!==record.fileIdentity?.ino)invalid('封存记录无效');
  return {action:'archived-verified',bytes:'historical',record};
 }
 try{validateRepairHeaders({...record,maxBytes:16*1024*1024},{status:206,headers:{etag:record.etag,'content-range':`bytes ${record.start}-${record.end-1}/${record.size}`}});}catch(_){invalid('记录范围无效');}
 const length=record.end-record.start;
 const original=await readBounded(path.join(directory,'original.bin'),length);
 if(original.length!==length||hash(original)!==record.sha256)invalid('原片段哈希不符');
 const prepared=await marker(directory,'prepared');
 if(!prepared)return {action:'original-backup-only',bytes:'not-inspected',record};
 const replacement=await readBounded(path.join(directory,'replacement.bin'),length);
 if(replacement.length!==length||hash(replacement)!==prepared.replacementSha256)invalid('新片段哈希不符');
 const completed=await marker(directory,'patched-unverified'),rolledBack=await marker(directory,'rolled-back'),restored=await marker(directory,'restored-original');
 const handle=await fs.open(filename,'r');let current;
 try{
  const stat=await handle.stat(),named=await fs.lstat(filename),id=record.fileIdentity;
  if(!id||named.isSymbolicLink()||!stat.isFile()||stat.dev!==id.dev||stat.ino!==id.ino||stat.size!==record.size||named.dev!==stat.dev||named.ino!==stat.ino)invalid('原文件已替换或大小变化');
  current=Buffer.alloc(length);let n=0;while(n<length){const r=await handle.read(current,n,length-n,record.start+n);if(!r.bytesRead)invalid('原文件区段不足');n+=r.bytesRead;}
  const after=await handle.stat();if(after.mtimeMs!==stat.mtimeMs||after.size!==stat.size)invalid('检查期间文件变化');
 }finally{await handle.close();}
 const bytes=current.equals(original)?'original':current.equals(replacement)?'replacement':'mixed-or-unknown';
 if((rolledBack||restored)&&bytes!=='original')invalid('回滚状态与字节冲突');
 return {record,bytes,action:bytes==='original'?'original-intact':bytes==='replacement'?(completed&&!rolledBack?'verify-whole-file':'recover-or-verify'):'recovery-required'};
}
async function restoreRepairTransaction(filename,directory,{checkControl=async()=>{}}={}){
 await checkControl();let compromised,handle,primaryError;
 const release=await require('proper-lockfile').lock(filename,{realpath:false,retries:0,onCompromised:error=>{compromised=error;}});
 try{
  const info=await inspectRepairTransaction(filename,directory);
  if(info.action==='original-intact')return {status:'original-intact'};
  if(!['recovery-required','recover-or-verify','verify-whole-file'].includes(info.action))invalid('事务未准备提交，不能恢复');
  const {record}=info,length=record.end-record.start;
  const original=await readBounded(path.join(directory,'original.bin'),length),replacement=await readBounded(path.join(directory,'replacement.bin'),length);
  const prepared=await marker(directory,'prepared');
  if(hash(original)!==record.sha256||hash(replacement)!==prepared?.replacementSha256)invalid('恢复前证据改变');
  handle=await fs.open(filename,'r+');
  async function identity(){
   if(compromised)throw compromised;
   const [stat,named]=await Promise.all([handle.stat(),fs.lstat(filename)]),id=record.fileIdentity;
   if(named.isSymbolicLink()||stat.dev!==id.dev||stat.ino!==id.ino||named.dev!==stat.dev||named.ino!==stat.ino||stat.size!==record.size||named.size!==record.size)invalid('恢复目标身份改变');
  }
  await identity();
  const current=Buffer.alloc(length);let n=0;
  while(n<length){const r=await handle.read(current,n,length-n,record.start+n);if(!r.bytesRead)invalid('恢复读取不足');n+=r.bytesRead;}
  for(let i=0;i<length;i++)if(current[i]!==original[i]&&current[i]!==replacement[i])invalid('区段含不属于原/新片段的未知字节，不能自动覆盖');
  await checkControl();await identity();
  // Commit restoration without mid-write cancellation. Original evidence is retained
  // if a write fails; next locked recovery can classify the resulting mixture again.
  let offset=0;while(offset<length){const r=await handle.write(original,offset,length-offset,record.start+offset);if(!r.bytesWritten)throw Error('恢复写入未前进');offset+=r.bytesWritten;}
  await handle.sync();await identity();
  const readback=Buffer.alloc(length);n=0;while(n<length){const r=await handle.read(readback,n,length-n,record.start+n);if(!r.bytesRead)invalid('恢复读回不足');n+=r.bytesRead;}
  if(!readback.equals(original))invalid('恢复读回不符');
  const {writeExclusive,syncDirectory}=require('./fastq-repair-backup');
  const existing=await marker(directory,'restored-original');
  if(!existing)await writeExclusive(path.join(directory,'restored-original.json'),JSON.stringify({version:1,state:'restored-original',time:new Date().toISOString()})+'\n');
  await syncDirectory(directory);
  return {status:'restored-original',backupPath:directory};
 }catch(error){primaryError=error;error.backupPath=directory;throw error;}
 finally{
  const errors=[];if(handle)try{await handle.close();}catch(error){errors.push(error);}
  try{await release();}catch(error){errors.push(error);}
  if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else{const error=errors.shift();error.cleanupErrors=errors;error.backupPath=directory;throw error;}}
 }
}
async function discoverRepairTransactions(filename,{maxTransactions=128,maxEntries=10000}={}){
 if(!Number.isSafeInteger(maxTransactions)||maxTransactions<1||maxTransactions>1024||!Number.isSafeInteger(maxEntries)||maxEntries<1)throw Object.assign(Error('修复证据扫描预算无效'),{code:'REPAIR_EVIDENCE_LIMIT'});
 const parent=await fs.realpath(path.dirname(filename)),found=[];
 let entries=0,transactions=0;
 const listing=await fs.opendir(parent);
 for await(const entry of listing){
  if(++entries>maxEntries)throw Object.assign(Error('目录条目超过修复证据扫描预算'),{code:'REPAIR_EVIDENCE_LIMIT'});
  if(!/^\.biodl-repair-[0-9a-f-]{36}$/.test(entry.name))continue;
  if(++transactions>maxTransactions)throw Object.assign(Error('修复事务超过扫描预算'),{code:'REPAIR_EVIDENCE_LIMIT'});
  if(!entry.isDirectory()||entry.isSymbolicLink())invalid('修复证据目录类型无效');
  const directory=path.join(parent,entry.name);
  // Unreadable/incomplete metadata cannot safely be attributed to another target.
  const record=await json(path.join(directory,'record.json'));
  if(record.filename!==path.basename(filename))continue;
  found.push({directory,...await inspectRepairTransaction(filename,directory)});
 }
 return found;
}
module.exports={inspectRepairTransaction,restoreRepairTransaction,discoverRepairTransactions};
