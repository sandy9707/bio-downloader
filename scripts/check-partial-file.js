const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-partial-test-'));
process.env.BIODL_DATA_DIR=path.join(temp,'data');
const engine=require('../main');
(async()=>{
  engine.ensureBinaries(); // Match application startup in the isolated test profile.
  const bundled=path.join(process.env.BIODL_DATA_DIR,'bin',process.platform==='win32'?'axel.exe':'axel');
  const {execFileSync}=require('child_process');
  assert.match(execFileSync(bundled,['--version'],{encoding:'utf8'}),/Axel\s+[\d.]+/,'bundled engine must start without system-installed tools');
  if(process.platform==='darwin' && process.arch==='arm64') {
    assert.ok(!execFileSync('otool',['-L',bundled],{encoding:'utf8'}).includes('/opt/homebrew/'),'portable engine must not depend on local Homebrew libraries');
  }
  const dest=path.join(temp,'downloads');fs.mkdirSync(dest);
  const file=path.join(dest,'partial.sra'),bytes=Buffer.from('existing-partial-data');fs.writeFileSync(file,bytes);
  const events=[];engine.eventBus.on('download-status',e=>events.push(e));
  await engine.callIpcHandler('start-download',{files:[{name:'partial.sra',url:'https://example.invalid/never-requested',size:10000,originalIndex:1}],targetDir:dest,token:'fixture',maxConcurrent:1});
  assert.deepEqual(fs.readFileSync(file),bytes,'missing resume metadata must never destroy existing bytes');
  assert.ok(events.some(e=>e.status==='failed'&&e.speed.includes('断点信息')));
  console.log('实际下载引擎检查通过: 缺少断点信息时保留原文件并提示');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>fs.rmSync(temp,{recursive:true,force:true}));
