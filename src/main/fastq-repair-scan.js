'use strict';
const fs=require('node:fs'),zlib=require('node:zlib');
const {FastqParser}=require('./fastq-repair-parser');
const INPUT_BYTES=64*1024,LOOKBACK_BYTES=1024*1024,LOOKAHEAD_BYTES=64*1024;
// Read-only, from byte zero, using only public zlib stream APIs. A candidate is
// [start,end), heuristic, and NOT a guarantee of containing all damaged bytes.
// It authorizes remote comparison only, never a write. After any verified patch
// the caller must scan again from the beginning, not seek or reuse decoder state.
async function scanFastqGzip(filename,{checkControl=async()=>{},onProgress=()=>{},maxLineBytes,maxUncompressedBytes,safeOpen=false}={}){
 await checkControl();
 const before=await fs.promises.stat(filename);
 if(!before.isFile())throw Error('FASTQ 扫描目标不是普通文件');
 const parser=new FastqParser({maxLineBytes,maxUncompressedBytes});
 const gunzip=zlib.createGunzip({chunkSize:INPUT_BYTES});
 let primaryError,input,blockStart=0,blockEnd=0,parserError,gzipError,pendingOutput=Promise.resolve();
 // Pause on every output buffer so asynchronous pause/cancel callbacks cannot
 // build an unbounded output queue. Fence BOTH the public write callback and the
 // last parser/control task before reading the next compressed block.
 gunzip.on('data',chunk=>{
  if(parserError)return;
  gunzip.pause();
  pendingOutput=(async()=>{await checkControl();parser.push(chunk);})()
   .catch(error=>{parserError=error;gunzip.destroy(error);}).finally(()=>{if(!gunzip.destroyed)gunzip.resume();});
 });
 gunzip.on('error',error=>{gzipError=error;});
 function checkErrors(){if(gzipError)throw gzipError;if(parserError)throw parserError;}
 async function feed(chunk){
  await new Promise((resolve,reject)=>{
   // Some zlib errors emit 'error' without invoking the pending write callback.
   const failed=error=>reject(error);gunzip.once('error',failed);
   gunzip.write(chunk,error=>{gunzip.removeListener('error',failed);if(error)reject(error);else resolve();});
  });
  // A write callback may precede draining paused readable buffers. Wait for
  // those too; readableLength is public and never used as a compressed offset.
  do{
   await pendingOutput;
   await new Promise(resolve=>setImmediate(resolve));
  }while(gunzip.readableLength&&!parserError&&!gzipError);
  await pendingOutput;checkErrors();
 }
 try{
  input=safeOpen?await require('./fastq-tail-open').openTailSource(filename,before):await fs.promises.open(filename,'r');
  const buffer=Buffer.allocUnsafe(INPUT_BYTES);
  while(true){
   await checkControl();
   // Omit position: strictly sequential reads, no random seek or prefetch.
   const {bytesRead}=await input.read(buffer,0,buffer.length,null);
   if(!bytesRead)break;
   blockStart=blockEnd;blockEnd+=bytesRead;
   await feed(buffer.subarray(0,bytesRead));
   await checkControl();
   onProgress({compressedBytes:blockEnd,totalBytes:before.size,records:parser.records,uncompressedBytes:parser.bytes});
  }
  await new Promise((resolve,reject)=>{
   gunzip.once('end',resolve);gunzip.once('error',reject);gunzip.end();
  });
  await pendingOutput;checkErrors();await checkControl();
  const result=parser.end(),after=await fs.promises.stat(filename);
  if(after.size!==before.size||after.mtimeMs!==before.mtimeMs||after.ino!==before.ino||after.dev!==before.dev)throw Object.assign(Error('扫描期间文件发生变化'),{code:'FASTQ_SOURCE_CHANGED'});
  return {status:'scan-complete',...result,compressedBytes:before.size};
 }catch(error){
  primaryError=error;
  if(['Z_DATA_ERROR','Z_BUF_ERROR','Z_NEED_DICT'].includes(error.code)){
   primaryError=Object.assign(Error('gzip 完整性未通过：'+error.message),{code:'FASTQ_GZIP_INVALID',candidate:null,cause:error,compressedBytes:gunzip.bytesWritten});throw primaryError;
  }
  if(['FASTQ_STRUCTURE_INVALID','FASTQ_PROFILE_UNSUPPORTED'].includes(error.code)){
   error.candidate={start:Math.max(0,Math.min(before.size,blockStart)-LOOKBACK_BYTES),end:Math.min(before.size,blockEnd+LOOKAHEAD_BYTES),heuristic:true};
   error.compressedBytes=blockEnd;
  }
  throw error;
 }finally{gunzip.destroy();if(input)try{await input.close();}catch(error){if(primaryError)primaryError.cleanupErrors=[...(primaryError.cleanupErrors||[]),error];else throw error;}}
}
module.exports={scanFastqGzip};
