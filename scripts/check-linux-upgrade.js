// Exercise the shipped 2.0.41 updater, not a simulated copy of its file list.
const fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),cp=require('child_process'),crypto=require('crypto'),assert=require('assert');
const [baseline,archive]=process.argv.slice(2).map(p=>path.resolve(p));
if(process.platform!=='linux')throw new Error('Run the upgrade test on Linux');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-upgrade-')),app=path.join(temp,'app'),profile=path.join(temp,'profile');
fs.cpSync(baseline,app,{recursive:true});fs.mkdirSync(profile);
fs.writeFileSync(path.join(profile,'settings.json'),JSON.stringify({defaultDir:path.join(temp,'downloads'),loggingEnabled:false,token:null}));
fs.writeFileSync(path.join(profile,'keep-history.json'),'persistent marker');fs.mkdirSync(path.join(app,'my-downloads'));fs.writeFileSync(path.join(app,'my-downloads/keep.fastq'),'user data');
const node=path.join(app,'runtime/node'),sha=crypto.createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
const runtimeSha=crypto.createHash('sha256').update(fs.readFileSync(node)).digest('hex');
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Length':fs.statSync(archive).size});fs.createReadStream(archive).pipe(res);});
function run(code){return new Promise((resolve,reject)=>{const child=cp.spawn(node,['-e',code],{cwd:app,env:{...process.env,BIODL_DATA_DIR:profile},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);child.once('error',reject);child.once('close',status=>status===0?resolve(output):reject(new Error(output)));});}
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const update=`require('./main').callIpcHandler('linux-self-update',{url:${JSON.stringify(`http://127.0.0.1:${server.address().port}/update.tar.gz`)},sha256:${JSON.stringify(sha)}}).then(r=>{if(!r.success)process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})`;
 for(const stage of ['legacy-2.0.41','current']){
  await run(update);
  const output=await run(`const main=require('./main');main.ensureBinaries();Promise.all([main.callIpcHandler('get-app-version'),main.callIpcHandler('plugin-get-status')]).then(([version,plugins])=>{console.log(JSON.stringify({version,plugins}));if(version!==${JSON.stringify(require('../package.json').version)})process.exit(1)}).catch(e=>{console.error(e);process.exit(1)})`);
  assert(output.includes(require('../package.json').version));
  assert.equal(fs.readFileSync(path.join(profile,'keep-history.json'),'utf8'),'persistent marker');assert.equal(fs.readFileSync(path.join(app,'my-downloads/keep.fastq'),'utf8'),'user data');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(node)).digest('hex'),runtimeSha);
  assert(fs.readFileSync(path.join(app,'packages/web/speedtest.html'),'utf8').includes('web-bridge.js'));
  assert(fs.existsSync(path.join(app,'packages/core/main/speedtest.js')));
  cp.execFileSync(path.join(app,'bin/linux/axel'),['--version']);
  cp.execFileSync(path.join(app,'bin/linux/aria2/aria2c'),['--version']);
  console.log('LINUX_UPGRADE_OK',stage,require('../package.json').version);
 }
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{server.closeAllConnections();server.close();fs.rmSync(temp,{recursive:true,force:true});});
