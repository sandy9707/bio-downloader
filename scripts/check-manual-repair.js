const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {createManualMd5}=require('../src/main/manual-md5');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-manual-repair-'));
(async()=>{
 const filename=path.join(root,'existing.bin'),bytes=Buffer.from('damaged existing bytes');fs.writeFileSync(filename,bytes);
 const md5='0'.repeat(32),file={name:'existing.bin',url:'https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456_1.fastq.gz',sourceSelection:'manual',transport:'https',size:bytes.length,md5,networkMode:'direct'};
 let calls=0;const progress=[];
 const service=createManualMd5(async()=>({expectedMd5:md5,expectedSize:bytes.length}),{
  getRepairProxy: f=>{assert.equal(f.networkMode,'direct');return false;},
  repair:async options=>{calls++;assert.equal(options.proxy,false);assert.equal(options.verification.status,'mismatch');assert.equal(options.filename,filename);options.onProgress({phase:'repair-scan'});const error=Error('cannot locate safely');error.verification={...options.verification,repair:{status:'stopped',code:'REPAIR_CANDIDATE_REQUIRED'}};throw error;}
 });
 let r=await service.verify({id:'verify-only',savePath:filename,file});assert.equal(calls,0);assert.equal(r.verification.status,'mismatch');
 r=await service.verify({id:'repair',savePath:filename,file,repair:true},p=>progress.push(p));assert.equal(calls,1);assert.equal(r.verification.status,'mismatch');assert.equal(r.verification.repair.status,'stopped');assert(progress.some(p=>p.phase==='repair-scan'));assert(fs.readFileSync(filename).equals(bytes));
 const sidecar=JSON.parse(fs.readFileSync(filename+'.biodl-verification.json'));assert.equal(sidecar.verification.status,'mismatch');assert.equal(sidecar.verification.repair.status,'stopped');
 const policy=require('../src/main/fastq-repair-policy'),ref={expectedSize:bytes.length,expectedMd5:md5};
 assert.deepEqual(policy.repairSource(file,ref,{deep:true}),{url:file.url});
 const httpUrl=file.url.replace(/^https:/,'http:');
 assert.deepEqual(policy.repairSource({...file,url:httpUrl,transport:'http'},ref,{deep:true}),{url:httpUrl});
 assert.deepEqual(policy.repairSource({url:file.url},ref,{deep:true}),{url:httpUrl});
 const ineligible=createManualMd5(async()=>ref,{getRepairProxy:()=>assert.fail('ineligible repair must not request a proxy')});
 for (const candidate of [{...file,transport:'ftp'}, {...file,transport:'ftp',url:file.url.replace(/^https:/,'ftp:')}]) {
  assert.equal(policy.repairSource(candidate,ref,{deep:true}),null);
  const result=await ineligible.verify({id:'skip',savePath:filename,file:candidate,repair:true});
  assert.equal(result.verification.status,'mismatch');assert.deepEqual(fs.readFileSync(filename),bytes);
 }
 let entered;const started=new Promise(r=>entered=r);
 const cancel=createManualMd5(async()=>({expectedMd5:md5,expectedSize:bytes.length}),{repair:async options=>{entered();await new Promise((_,reject)=>{options.signal.addEventListener('abort',()=>reject(Error('Cancelled')),{once:true});});}});
 const pending=cancel.verify({id:'cancel',savePath:filename,file,repair:true});await started;assert(cancel.cancel('cancel'));assert.equal((await pending).cancelled,true);assert(fs.readFileSync(filename).equals(bytes));
 console.log('MANUAL_REPAIR_OK: opt-in, policy failure remains mismatch, persistence, cancellation, no download or billing');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
