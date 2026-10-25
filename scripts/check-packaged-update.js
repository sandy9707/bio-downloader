// End-to-end acceptance against the built Electron runtime and full app.asar.
// A temporary old-version app uses a throwaway test key; release keys are never
// needed by CI. The target is the unmodified packaged application.
const fs=require('fs'),path=require('path'),os=require('os'),cp=require('child_process'),crypto=require('crypto'),assert=require('assert/strict'),asar=require('@electron/asar');
const runtime=path.resolve(process.argv[2]||'');
if(!process.argv[2]||!['darwin','win32'].includes(process.platform))throw Error('Usage: node check-packaged-update.js <built app directory>');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-packaged-update-')),profile=path.join(root,'profile');
const mac=process.platform==='darwin',install=path.join(root,mac?'BioDownloader.app':'app'),resources=path.join(install,mac?'Contents/Resources':'resources');
const exe=path.join(install,mac?'Contents/MacOS/BioDownloader':'BioDownloader.exe');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let testPid;
function stop(pid){if(!pid)return;try{if(mac)process.kill(pid,'SIGTERM');else cp.execFileSync('taskkill',['/PID',String(pid),'/T','/F'],{stdio:'ignore'});}catch(e){if(e.code!=='ESRCH'&&mac)throw e}}
async function wait(fn){const end=Date.now()+90000;while(Date.now()<end){const r=fn();if(r)return r;await sleep(200)}throw Error('Updated application did not confirm startup')}
(async()=>{
 if(mac)cp.execFileSync('ditto',[runtime,install]);else fs.cpSync(runtime,install,{recursive:true});
 fs.mkdirSync(profile);fs.writeFileSync(path.join(profile,'keep-history.json'),'history marker');
 const patch=path.join(root,'candidate.asar'),target=path.join(resources,'app.asar');fs.copyFileSync(target,patch);
 const version=JSON.parse(asar.extractFile(patch,'package.json')).version;
 const {privateKey,publicKey}=crypto.generateKeyPairSync('ed25519'),sha256=hash(patch);
 const manifest={version,sha256,signature:crypto.sign(null,Buffer.from(sha256),privateKey).toString('base64')};fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify(manifest));
 const fixture=path.join(root,'fixture');fs.mkdirSync(fixture);
 fs.writeFileSync(path.join(fixture,'package.json'),JSON.stringify({name:'bio-downloader',version:'0.0.1',main:'main.js'}));fs.writeFileSync(path.join(fixture,'index.html'),'<html>Update acceptance fixture</html>');
 fs.writeFileSync(path.join(fixture,'hot-update.js'),fs.readFileSync(path.join(__dirname,'../src/main/hot-update.js'),'utf8').replace(/const PUBLIC_KEY = '[^']+';/,'const PUBLIC_KEY = '+JSON.stringify(publicKey.export({type:'spki',format:'pem'}))+';'));
 fs.writeFileSync(path.join(fixture,'main.js'),`const {app}=require('electron'),fs=require('fs'),path=require('path'),up=require('./hot-update');app.setPath('userData',process.env.BIODL_DATA_DIR);app.whenReady().then(async()=>{try{const root=process.env.BIODL_UPDATE_TEST_ROOT;const p=up.prepare({patch:path.join(root,'candidate.asar'),manifest:JSON.parse(fs.readFileSync(path.join(root,'manifest.json'))),resources:process.resourcesPath,userData:app.getPath('userData'),executable:process.execPath});await up.launchHelper(p);fs.writeFileSync(path.join(root,'armed.json'),JSON.stringify(p));setTimeout(()=>app.quit(),2000)}catch(e){console.error(e);app.exit(1)}});`);
 await asar.createPackage(fixture,target);
 const oldHash=hash(target),env={...process.env,BIODL_DATA_DIR:profile,BIODL_UPDATE_TEST_ROOT:root};delete env.ELECTRON_RUN_AS_NODE;
 const child=cp.spawn(exe,[],{env,cwd:install,detached:true,stdio:'ignore'});testPid=child.pid;child.unref();
 const armed=await wait(()=>fs.existsSync(path.join(root,'armed.json'))&&JSON.parse(fs.readFileSync(path.join(root,'armed.json'))));assert.equal(hash(target),oldHash,'must wait for old process exit');
 const read=()=>{const r=JSON.parse(fs.readFileSync(armed.job.result));if(['failed','recovery-required'].includes(r.status))throw Error(r.error);return r.status==='running'&&r};
 const first=await wait(read);testPid=first.runningPid;assert.equal(first.runningVersion,version);assert.equal(hash(target),sha256);
 stop(testPid);testPid=null;await sleep(1000);
 fs.writeFileSync(armed.job.result,JSON.stringify({...first,status:'testing-second-start'}));
 const secondChild=cp.spawn(exe,[],{env:{...env,BIODL_UPDATE_RECEIPT:armed.job.result},cwd:install,detached:true,stdio:'ignore'});testPid=secondChild.pid;secondChild.unref();
 const second=await wait(read);testPid=second.runningPid;assert.equal(second.runningVersion,version);assert.notEqual(first.runningPid,second.runningPid);assert.equal(fs.readFileSync(path.join(profile,'keep-history.json'),'utf8'),'history marker');
 fs.mkdirSync('.evidence',{recursive:true});fs.writeFileSync(path.join('.evidence',`packaged-update-${process.platform}.json`),JSON.stringify({version,sha256,first,second,profilePreserved:true},null,2));
 console.log('PACKAGED_UPDATE_OK',process.platform,version,'two real process starts, verified bytes, preserved profile');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{stop(testPid);await sleep(1000);try{fs.rmSync(root,{recursive:true,force:true})}catch(e){console.warn('Test directory retained:',root)}});
