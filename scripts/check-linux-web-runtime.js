const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-web-'));process.env.BIODL_DATA_DIR=profile;
const {BiodlServer}=require('../packages/cli/server');
(async()=>{
 const server=new BiodlServer({host:'127.0.0.1',port:43281});server.port=0;await server.start();
 try {
  const base=`http://127.0.0.1:${server.server.address().port}`;
  const home=await (await fetch(base)).text();assert(home.includes('btnVerifyCompleted')&&home.includes('settingsDeepIntegrityToggle')&&home.includes('transferBatchError'));
  const page=await(await fetch(base+'/speedtest.html')).text();assert(page.includes('web-bridge.js')&&page.includes('startDownloaderTest'));
  const sessionId=server.createSession(null,'local-test-only');
  const events={};let opened, progress=0;
  const window={open:url=>{opened=url}}, storage=new Map([['biodl_session',sessionId]]);
  const context={window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},EventSource:class{constructor(url){this.url=url;}close(){}addEventListener(name,fn){events[name]=fn;}},fetch:(url,opts)=>fetch(base+url,opts),console};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../packages/web/web-bridge.js'),'utf8'),context);
  await window.api.openSpeedtestPage();assert.equal(opened,'/speedtest.html');
  window.api.onSpeedtestProgress(()=>{progress+=100;});window.api.onSpeedtestProgress(()=>progress++);events['speedtest-progress']({data:'{"bytesReceived":128}'});assert.equal(progress,1,'retesting must replace listener');
  assert.equal(await window.api.getAppVersion(),require('../package.json').version);
  const result=await window.api.speedtestNetwork({url:base+'/renderer.js',timeoutMs:1500});assert(result.success&&result.bytesReceived>1000,JSON.stringify(result));
  console.log('LINUX_WEB_RUNTIME_OK',JSON.stringify({version:require('../package.json').version,bytes:result.bytesReceived}));
 }finally{for(const client of server.sseClients)client.end();await server.stop();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
