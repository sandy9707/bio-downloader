'use strict';
const fs=require('node:fs/promises');
const {validMd5,knownSize,verifyFile}=require('./download-integrity');
const {scanFastqGzip}=require('./fastq-repair-scan');
// The caller supplies the official reference resolved for the exact source file,
// never a checksum generated from the damaged local file or an unrelated mirror.
async function verifyRepairedFastq(filename,reference,{checkControl=async()=>{},onProgress=()=>{},expectedIdentity,maxLineBytes,maxUncompressedBytes,safeOpen=false}={}){
 if(!knownSize(reference?.expectedSize)||!validMd5(reference?.expectedMd5))throw Object.assign(Error('局部修复最终验收需要官方大小与 MD5'),{code:'REPAIR_FINAL_REFERENCE_REQUIRED'});
 reference={...reference,expectedSize:knownSize(reference.expectedSize),expectedMd5:validMd5(reference.expectedMd5)};
 const anchor=expectedIdentity||await fs.lstat(filename);
 async function control(){
  await checkControl();const current=await fs.lstat(filename);
  if(current.isSymbolicLink()||!current.isFile()||['dev','ino','size','mtimeMs','ctimeMs'].some(key=>current[key]!==anchor[key]))throw Object.assign(Error('最终验收目标与修补文件身份不一致'),{code:'FASTQ_SOURCE_CHANGED'});
 }
 await control();const before=await fs.stat(filename);
 const digest=await verifyFile(filename,{...reference,gzip:true},{deep:true,safeOpen,checkControl:control,onProgress:(bytes,total)=>onProgress({phase:'repair-final-md5',bytes,total})});
 if(digest.status!=='verified')throw Object.assign(Error('局部修复后官方 MD5 仍不一致，不能完成'),{code:'REPAIR_FINAL_MD5_MISMATCH',verification:digest});
 const structure=await scanFastqGzip(filename,{checkControl:control,safeOpen,maxLineBytes,maxUncompressedBytes,onProgress:progress=>onProgress({phase:'repair-final-gzip',...progress})});
 await control();const after=await fs.stat(filename);
 if(before.dev!==after.dev||before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs)throw Object.assign(Error('最终验收期间目标被修改或替换'),{code:'FASTQ_SOURCE_CHANGED'});
 return {...digest,gzip:'passed',records:structure.records,uncompressedBytes:structure.uncompressedBytes};
}
module.exports={verifyRepairedFastq};
