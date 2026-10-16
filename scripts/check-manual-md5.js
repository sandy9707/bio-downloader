const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),vm=require('vm');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-manual-md5-'));process.env.BIODL_DATA_DIR=path.join(temp,'profile');
const bytes=crypto.randomBytes(8*1024*1024),expected=crypto.createHash('md5').update(bytes).digest('hex'),filename=path.join(temp,'existing.bin');fs.writeFileSync(filename,bytes);
const axios=require('axios');axios.post=async()=>{throw Error('manual verification must never charge or submit network mutations');};
const engine=require('../main');
let id=0;
const verify=file=>engine.callIpcHandler('verify-transfer-md5',{id:'test-'+(++id),savePath:filename,file:{name:'existing.bin',size:bytes.length,...file}});
(async()=>{
  const settings=await engine.callIpcHandler('get-settings');assert.ok(!settings.deepIntegrityCheck);
  let result=await verify({md5:expected});assert.equal(result.verification.status,'verified');assert.equal(result.verification.actualMd5,expected);
  result=await verify({md5:'0'.repeat(32)});assert.equal(result.verification.status,'mismatch');assert.deepEqual(fs.readFileSync(filename),bytes);
  result=await verify({});assert.equal(result.verification.status,'computed');assert.equal(result.verification.actualMd5,expected);
  fs.writeFileSync(filename+'.st','unfinished');await assert.rejects(verify({md5:expected}),/下载断点/);fs.unlinkSync(filename+'.st');
  const cancel=event=>{if(event.phase==='hashing')engine.callIpcHandler('cancel-transfer-md5',event.id);};
  engine.eventBus.on('md5-verification-progress',cancel);result=await verify({md5:expected});assert.equal(result.cancelled,true);engine.eventBus.off('md5-verification-progress',cancel);
  const {createEnaResolver}=require('../src/main/download-integrity');let attempts=0;
  const retryResolver=createEnaResolver(async()=>{if(++attempts===1)throw Error('temporary');return [{run_accession:'SRR123456',fastq_ftp:'ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456.fastq.gz',fastq_md5:expected,fastq_bytes:String(bytes.length)}]});
  const referenceFile={url:'https://ftp.sra.ebi.ac.uk/vol1/fastq/SRR123/SRR123456/SRR123456.fastq.gz',size:bytes.length};
  assert.equal((await retryResolver.reference(referenceFile,{deep:true})).expectedMd5,null);
  assert.equal((await retryResolver.reference(referenceFile,{deep:true,refresh:true})).expectedMd5,expected,'manual retry must bypass cached outage');
  const {createManualMd5}=require('../src/main/manual-md5');let release;const service=createManualMd5(()=>new Promise(r=>release=r));
  const pending=service.verify({id:'one',savePath:filename,file:{}});await new Promise(r=>setTimeout(r,20));
  await assert.rejects(service.verify({id:'two',savePath:filename,file:{}}),/已有 MD5/);service.cancel('one');release({});assert.equal((await pending).cancelled,true);
  await assert.rejects(engine.callIpcHandler('verify-transfer-md5',{id:'missing',savePath:filename+'.missing',file:{}}),/找不到本地文件/);
  const source=fs.readFileSync(path.join(__dirname,'../renderer.js'),'utf8'),messages=[],saved=[];
  const items=[{name:'one',savePath:filename},{name:'two',savePath:filename}],requests=[];
  const context=vm.createContext({window:{api:{getClashStatus:async()=>false,verifyTransferMd5:async request=>{requests.push(request);context.completedDownloads.unshift({name:'new',savePath:filename});return {verification:{status:'verified',actualMd5:expected}};}}},
    currentUser:null,currentTransferSubTab:'completed',completedDownloads:items.slice(),document:{getElementById:()=>null},
    allocateTransferId:()=>++id,showToast:(...v)=>messages.push(v),renderCompletedList(){},syncTransfersToStorage:()=>saved.push(JSON.stringify(context.completedDownloads))});
  vm.runInContext(source.slice(source.indexOf('// Manual MD5 checks'),source.indexOf('function renderCompletedList()')),context);
  await context.verifyAllCompletedMd5();assert.equal(requests.length,2);assert.equal(items[0].verification.status,'verified');assert.equal(items[1].verification.status,'verified');assert.ok(saved.length);
  assert.ok(items.every(item=>!item.md5Progress));assert.equal(items[0].verification.actualMd5,expected);
  console.log('手动 MD5 回归通过：已有文件、开关关闭也可主动校验、正确/错误/无参考、进度取消、禁止重入、路径丢失、历史列表变化、持久化、不下载不计费');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
