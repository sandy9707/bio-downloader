const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),vm=require('vm');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-web-'));process.env.BIODL_DATA_DIR=profile;
const {BiodlServer}=require('../packages/cli/server');
(async()=>{
 const server=new BiodlServer({host:'127.0.0.1',port:43281});server.port=0;await server.start();
 try {
  const base=`http://127.0.0.1:${server.server.address().port}`;
  const home=await (await fetch(base)).text();assert(home.includes('btnVerifyCompleted')&&home.includes('settingsDeepIntegrityToggle')&&home.includes('transferBatchError'));
  const page=await(await fetch(base+'/speedtest.html')).text();assert(page.includes('web-bridge.js')&&page.includes('startDownloaderTest'));
  const consent = await (await fetch(base+'/api/ipc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({channel:'set-usage-choice',payload:'accepted'})})).json();
  assert(consent.success,'declaration must be saveable before login');
  assert.equal((await (await fetch(base+'/renderer.js')).headers.get('cache-control')),'no-store');
  const sessionId=server.createSession(null,'local-test-only');
   const events={};let opened, progress=0, eventSources=0;
  const window={open:url=>{opened=url}}, storage=new Map([['biodl_session',sessionId]]);
   const context={window,localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},EventSource:class{constructor(url){this.url=url;this.readyState=1;eventSources++;}close(){this.readyState=2;}addEventListener(name,fn){events[name]=fn;}},fetch:(url,opts)=>fetch(base+url,opts),console};
   vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../packages/web/web-bridge.js'),'utf8'),context);
   context.setTimeout=setTimeout;
  await window.api.openSpeedtestPage();assert.equal(opened,'/speedtest.html');
  window.api.onSpeedtestProgress(()=>{progress+=100;});window.api.onSpeedtestProgress(()=>progress++);events['speedtest-progress']({data:'{"bytesReceived":128}'});assert.equal(progress,1,'retesting must replace listener');
   assert.equal(await window.api.getAppVersion(),require('../package.json').version);
   await window.api.getSettings();await window.api.getSettings();
   assert.equal(eventSources,1,'account/settings refresh must not rebuild a healthy SSE stream');
   let validations=0;window.api.onClashValidationProgress(()=>validations++);
   events['clash-validation-progress']({data:'{"completed":1,"total":2}'});assert.equal(validations,1);
   const controller=new AbortController();
   const stream=await fetch(base+'/api/events?sid='+sessionId,{signal:controller.signal});
   assert.equal(stream.headers.get('x-accel-buffering'),'no');
   const reader=stream.body.getReader();await reader.read();
   require('../main').eventBus.emit('clash-validation-progress',{completed:2,total:2,done:true});
   const packet=await Promise.race([reader.read(),new Promise((_,reject)=>setTimeout(()=>reject(Error('SSE progress not forwarded')),2000))]);
   assert(Buffer.from(packet.value).toString().includes('clash-validation-progress'));controller.abort();
   const main=require('../main'),oldCall=main.callIpcHandler;
   let runs=0;main.callIpcHandler=async(channel,payload)=>{if(channel==='clash-optimize'){runs++;await new Promise(r=>setTimeout(r,50));return {success:true,nodeCount:7};}return oldCall(channel,payload);};
   try {
     assert.equal((await window.api.optimizeClash('fixture')).nodeCount,7);
     assert.equal(runs,1,'long optimization must use one background job');
   }finally{main.callIpcHandler=oldCall;}
  const result=await window.api.speedtestNetwork({url:base+'/renderer.js',timeoutMs:1500});assert(result.success&&result.bytesReceived>1000,JSON.stringify(result));
  console.log('LINUX_WEB_RUNTIME_OK',JSON.stringify({version:require('../package.json').version,bytes:result.bytesReceived}));
 }finally{for(const client of server.sseClients)client.end();await server.stop();fs.rmSync(profile,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
