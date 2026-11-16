'use strict';
const fs=require('node:fs/promises');
const {validateRepairRange}=require('./fastq-repair-range');
const {createRepairBackup,writeExclusive,syncDirectory}=require('./fastq-repair-backup');
const path=require('node:path'),crypto=require('node:crypto');
async function mark(directory,state,fields={}){
 await writeExclusive(path.join(directory,state+'.json'),JSON.stringify({version:1,state,...fields,time:new Date().toISOString()})+'\n');
 await syncDirectory(directory);
}
async function readExact(handle,length,start){
 const bytes=Buffer.alloc(length);let offset=0;
 while(offset<length){const r=await handle.read(bytes,offset,length-offset,start+offset);if(!r.bytesRead)throw Error('补丁原区段读取不足');offset+=r.bytesRead;}return bytes;
}
async function writeExact(handle,bytes,start){
 let offset=0;while(offset<bytes.length){const r=await handle.write(bytes,offset,bytes.length-offset,start+offset);if(!r.bytesWritten)throw Error('补丁写入未前进');offset+=r.bytesWritten;}
}
async function applyRepairPatch({filename,sourceUrl,expected,response,expectedIdentity,lease,checkControl=async()=>{}}){
 const replacement=Buffer.from(validateRepairRange(expected,response));
 if(replacement.length>16*1024*1024)throw Error('单补丁超过16MiB预算');
 await checkControl();
 const {acquireRepairLock,checkRepairLock}=require('./fastq-repair-lock');
 const owned=lease?null:await acquireRepairLock(filename);
 const activeLease=lease||owned.lease;
 checkRepairLock(activeLease,filename);
 const release=owned?()=>owned.release():async()=>{};
 let handle,backupPath,original,touched=false,primaryError;
 try{
  const identity=await fs.lstat(filename);
  if(expectedIdentity&&['dev','ino','size','mtimeMs','ctimeMs'].some(key=>identity[key]!==expectedIdentity[key]))throw Object.assign(Error('补取期间目标文件发生变化'),{code:'FASTQ_PATCH_IDENTITY_CHANGED'});
  if(!identity.isFile()||identity.isSymbolicLink()||identity.size!==expected.size)throw Error('补丁目标不是匹配的普通文件');
  handle=await fs.open(filename,'r+');
  async function checkIdentity(){
   checkRepairLock(activeLease,filename);
   const [current,opened]=await Promise.all([fs.lstat(filename),handle.stat()]);
   if(current.isSymbolicLink()||current.dev!==identity.dev||current.ino!==identity.ino||opened.dev!==identity.dev||opened.ino!==identity.ino||opened.size!==expected.size||current.mtimeMs!==identity.mtimeMs)throw Error('修补前文件身份发生变化');
  }
  await checkIdentity();original=await readExact(handle,replacement.length,expected.start);
  if(original.equals(replacement))return {status:'unchanged',patchedBytes:0,identity};
  backupPath=await createRepairBackup({filename,sourceUrl,...expected,bytes:original});
  await writeExclusive(path.join(backupPath,'replacement.bin'),replacement);
  await mark(backupPath,'prepared',{replacementSha256:crypto.createHash('sha256').update(replacement).digest('hex')});
  await checkControl();await checkIdentity();
  if(!(await readExact(handle,original.length,expected.start)).equals(original))throw Error('备份后原区段发生变化');
  // Commit section: do not interrupt midway; failure restores on the same descriptor.
  touched=true;await writeExact(handle,replacement,expected.start);await handle.sync();
  if(!(await readExact(handle,replacement.length,expected.start)).equals(replacement))throw Error('补丁读回不一致');
  checkRepairLock(activeLease,filename);
  const published=await fs.lstat(filename);
  if(published.isSymbolicLink()||published.dev!==identity.dev||published.ino!==identity.ino||published.size!==expected.size)throw Object.assign(Error('修补提交时目标路径已被替换'),{code:'FASTQ_PATCH_IDENTITY_CHANGED'});
  await mark(backupPath,'patched-unverified');
  return {status:'patched-unverified',patchedBytes:replacement.length,backupPath,identity:published};
 }catch(error){
  primaryError=error;if(backupPath)error.backupPath=backupPath;
  if(touched&&handle&&original){
   try{await writeExact(handle,original,expected.start);await handle.sync();if(!(await readExact(handle,original.length,expected.start)).equals(original))throw Error('回滚读回不一致');error.rollback='restored';await mark(backupPath,'rolled-back');}
   catch(rollbackError){error.rollback='failed';error.rollbackError=rollbackError;}
  }
  throw error;
 }finally{
  const errors=[];if(handle)try{await handle.close();}catch(error){errors.push(error);}
  try{await release();}catch(error){errors.push(error);}
  if(errors.length){if(primaryError)primaryError.cleanupErrors=errors;else{const error=errors.shift();error.cleanupErrors=errors;error.backupPath=backupPath;throw error;}}
 }
}
module.exports={applyRepairPatch};
