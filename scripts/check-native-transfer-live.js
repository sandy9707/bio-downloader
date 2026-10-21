'use strict';
// Public fixtures only; no app account, subscription, settings or billing calls.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),axios=require('axios'),assert=require('assert/strict');
const {NativeTransfer}=require('../src/main/native-transfer');
const {parseEnaReport}=require('../src/main/download-integrity');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-native-live-中文-'));
const results=[];let task;
const timeout=setTimeout(()=>{console.error('NATIVE_LIVE_TIMEOUT');task?.pause();process.exitCode=2},360000);
const fileHash=async(filename,algorithm)=>{const hash=crypto.createHash(algorithm);for await(const bytes of fs.createReadStream(filename))hash.update(bytes);return hash.digest('hex')};
(async()=>{
 const report=await axios.get('https://www.ebi.ac.uk/ena/portal/api/filereport',{params:{accession:'SRR390728',result:'read_run',fields:'run_accession,fastq_ftp,fastq_md5,fastq_bytes',format:'json'},proxy:false,timeout:30000});
 const ebi=parseEnaReport(report.data).find(x=>x.name==='SRR390728_1.fastq.gz');assert(ebi?.md5&&ebi.size>100000000);
 const fixtures=[{...ebi,algorithm:'md5',hash:ebi.md5},{url:'https://github.com/aria2/aria2/releases/download/release-1.37.0/aria2-1.37.0.tar.gz',name:'aria2-source.tar.gz',size:3904613,algorithm:'sha256',hash:'8e7021c6d5e8f8240c9cc19482e0c8589540836747744724d86bf8af5a21f0e8'}];
 for(const fixture of fixtures){
  const filename=path.join(temp,fixture.name),events=[],start=Date.now();let retries=0;
  task=new NativeTransfer({url:fixture.url,filename,proxy:false,expectedSize:fixture.size,retryBudgetMs:120000,
   onEvent:e=>{if(e.type==='progress')events.push({elapsedMs:Date.now()-start,receivedBytes:e.receivedBytes,committedBytes:e.committedBytes,percentage:e.percentage});if(e.type==='retry')retries++}});
  const result=await task.run();assert.equal(result.status,'completed');assert.equal(fs.statSync(filename).size,fixture.size);
  const hash=await fileHash(filename,fixture.algorithm);assert.equal(hash,fixture.hash);
  results.push({name:fixture.name,size:fixture.size,etag:task.meta.etag,algorithm:fixture.algorithm,hash,reference:fixture.hash,seconds:(Date.now()-start)/1000,retries,samples:events.length,first:events.find(e=>e.receivedBytes>0),last:events.at(-1)});
 }
 fs.mkdirSync('.evidence',{recursive:true});const evidence={platform:process.platform,node:process.version,results};
 fs.writeFileSync(`.evidence/native-live-${process.platform}.json`,JSON.stringify(evidence,null,2));console.log('NATIVE_LIVE_OK',JSON.stringify(evidence));
})().catch(e=>{console.error(e.code||e.name,e.message);process.exitCode=1}).finally(()=>{clearTimeout(timeout);fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100})});
