// App integration gate: an eligible failed local repair may not silently turn
// into a whole-file redownload, nor report a successful traffic charge.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),crypto=require('crypto');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-repair-preserve-'));process.env.BIODL_DATA_DIR=path.join(root,'profile');
const integrity=require('../src/main/download-integrity');
const url='http://ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456_1.fastq.gz';
const bytes=require('zlib').gzipSync(Buffer.from('@a\nACGT\n+\nIIII\n'));
const ref={expectedSize:bytes.length,expectedMd5:'0'.repeat(32),gzip:true,required:true};
integrity.createEnaResolver=()=>({reference:async()=>({...ref})});
require('../src/main/bio-transfer-guard').bioSource=()=>null;
let repairs=0,downloads=0,charges=0;
const policy=require('../src/main/fastq-repair-policy');
policy.repairSource=()=>({url});
policy.repairMismatch=async options=>{repairs++;assert.equal(options.verification.status,'mismatch');const e=Error('cannot locate safely');e.verification={...options.verification,repair:{status:'stopped'}};e.preserveMismatch=true;throw e;};
require('../src/main/download-engines').runAria=async()=>{downloads++;throw Error('must not download');};
require('axios').post=async()=>{charges++;throw Error('must not charge');};
const main=require('../main'),events=[];main.eventBus.on('download-status',e=>events.push(e));
(async()=>{
 const dest=path.join(root,'data');fs.mkdirSync(dest);const filename=path.join(dest,'sample.fastq.gz');fs.writeFileSync(filename,bytes);
 await main.callIpcHandler('save-settings',{deepIntegrityCheck:true,downloadEngines:{http:'aria2'}});
 await main.callIpcHandler('start-download',{files:[{name:'sample.fastq.gz',url,size:bytes.length,md5:ref.expectedMd5,originalIndex:901,networkMode:'direct'}],targetDir:dest,token:'fixture',maxConcurrent:1});
 assert.equal(repairs,1);assert.equal(downloads,0);assert.equal(charges,0);assert(fs.readFileSync(filename).equals(bytes));assert(!fs.existsSync(path.join(dest,'.biodl-replaced')));
 const final=events.filter(e=>['failed','completed'].includes(e.status)).at(-1);assert.equal(final.status,'failed');assert.equal(final.verification.status,'mismatch');assert.equal(final.verification.repair.status,'stopped');
 console.log('REPAIR_PRESERVE_APP_OK: failed bounded repair never starts whole redownload or success charge');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
