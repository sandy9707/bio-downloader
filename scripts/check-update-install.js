// Transaction tests use an ephemeral signing key in a COPY of the updater.
// Production code keeps its fixed release key; signed release/real Electron
// acceptance is performed separately against packaged desktop applications.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict'),asar=require('@electron/asar');
const linux=require('../src/main/linux-update');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-install-测试-'));
(async()=>{
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519');
 const helper=path.join(root,'hot-update.cjs');
 const source=fs.readFileSync(path.join(__dirname,'../src/main/hot-update.js'),'utf8');
 fs.writeFileSync(helper,source.replace(/const PUBLIC_KEY = '[^']+';/,'const PUBLIC_KEY = '+JSON.stringify(publicKey.export({type:'spki',format:'pem'}))+';'));
 const up=require(helper),content=path.join(root,'content'),resources=path.join(root,'resources'),profile=path.join(root,'profile');
 for(const p of [content,resources,profile])fs.mkdirSync(p);
 fs.writeFileSync(path.join(content,'package.json'),JSON.stringify({version:'9.0.0-preview.1'}));fs.writeFileSync(path.join(content,'main.js'),'void 0;');fs.writeFileSync(path.join(content,'index.html'),'<html></html>');
 const patch=path.join(root,'patch.asar');await asar.createPackage(content,patch);
 const sha256=crypto.createHash('sha256').update(fs.readFileSync(patch)).digest('hex');
 const manifest={version:'9.0.0-preview.1',sha256,signature:crypto.sign(null,Buffer.from(sha256),privateKey).toString('base64')};
 const target=path.join(resources,'app.asar');fs.writeFileSync(target,'original');
 const args={patch,manifest,resources,userData:profile,executable:process.execPath,pid:2147483647};
 assert.throws(()=>up.prepare({...args,manifest:{...manifest,signature:'invalid'}}));assert.equal(fs.readFileSync(target,'utf8'),'original');
 assert.throws(()=>up.prepare({...args,manifest:{...manifest,version:'wrong'}}));
 let p=up.prepare({...args,pid:process.pid});await assert.rejects(up.apply(p.job,{relaunch:false,waitMs:1}));assert.equal(fs.readFileSync(target,'utf8'),'original');
 p=up.prepare({...args,executable:path.join(root,'absent.exe')});await assert.rejects(up.apply(p.job));assert.equal(fs.readFileSync(target,'utf8'),'original');
 p=up.prepare(args);fs.writeFileSync(p.job.patch,'corrupt');await assert.rejects(up.apply(p.job,{relaunch:false}));assert.equal(fs.readFileSync(target,'utf8'),'original');
 p=up.prepare(args);await up.apply(p.job,{relaunch:false});assert.equal(up.archiveVersion(target),manifest.version);assert.equal(fs.readFileSync(p.job.backup,'utf8'),'original');
 up.acknowledge(p.job.result,manifest.version,target);assert.equal(JSON.parse(fs.readFileSync(p.job.result)).status,'running');
 if(process.platform==='win32') {
  // Linux directory installation is unreachable on Windows. Run that suite on
  // Linux/macOS, not through Windows Node's recursive Unicode-directory copy.
  console.log('UPDATE_INSTALL_OK win32: signature/version/corruption rejection, parent-exit wait, failed-launch rollback, installed version confirmation');
  return;
 }
 // Linux transaction replaces shipped entries but preserves arbitrary user files.
 const dest=path.join(root,'linux'),next=path.join(root,'next');for(const dir of [dest,next]){
  fs.mkdirSync(path.join(dir,'packages/cli'),{recursive:true});fs.mkdirSync(path.join(dir,'packages/web'),{recursive:true});fs.mkdirSync(path.join(dir,'node_modules/axios'),{recursive:true});
  for(const file of ['biodl','packages/cli/bin.js','packages/web/index.html','node_modules/axios/package.json'])fs.writeFileSync(path.join(dir,file),'marker');
  fs.writeFileSync(path.join(dir,'main.js'),'void 0;');fs.writeFileSync(path.join(dir,'package.json'),JSON.stringify({version:dir===next?'9.0.0':'8.0.0'}));
 }
 fs.writeFileSync(path.join(dest,'keep.fastq'),'download');fs.mkdirSync(path.join(dest,'runtime'));fs.writeFileSync(path.join(dest,'runtime/node'),'runtime');
 const rename=fs.renameSync;let injected=false;
 try{fs.renameSync=(a,b)=>{if(!injected&&b===path.join(dest,'main.js')){injected=true;throw Object.assign(Error('simulated disk failure'),{code:'EIO'})}return rename(a,b)};
 assert.throws(()=>linux.install({source:next,root:dest,version:'9.0.0',userData:profile}),/原程序已保留/);
 }finally{fs.renameSync=rename}
 assert(injected);assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'package.json'))).version,'8.0.0');
 assert.throws(()=>linux.install({source:next,root:dest,version:'wrong'}));
 const installed=linux.install({source:next,root:dest,version:'9.0.0',userData:profile});
 assert.equal(JSON.parse(fs.readFileSync(path.join(dest,'package.json'))).version,'9.0.0');assert.equal(JSON.parse(fs.readFileSync(path.join(installed.backup,'package.json'))).version,'8.0.0');assert.equal(fs.readFileSync(path.join(dest,'keep.fastq'),'utf8'),'download');assert.equal(fs.readFileSync(path.join(dest,'runtime/node'),'utf8'),'runtime');
 console.log('UPDATE_INSTALL_OK: signature/version/corruption rejection; wait for exit; failed launch rollback; confirmed receipt; Linux failed-write rollback and data/runtime preservation');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>fs.rmSync(root,{recursive:true,force:true}));
