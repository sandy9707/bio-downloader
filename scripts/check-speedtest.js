const assert = require('assert'), http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-speed-test-'));process.env.BIODL_DATA_DIR = temp;
const main = require('../main'); main.ensureBinaries();
let payloadBytes = 0;
const size = 64 * 1024 * 1024;
const server = http.createServer((req,res)=>{
 if(req.url==='/redirect'){res.writeHead(302,{Location:'/file'});res.end();return;}
 if(req.url==='/error'){res.writeHead(503);res.end('unavailable');return;}
 if(req.url==='/html'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<html>error</html>');return;}
 const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range||'');
 let start=range?+range[1]:0,end=range&&range[2]?+range[2]:size-1;
 res.writeHead(range?206:200,{'Content-Length':end-start+1,'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${size}`,'Content-Type':'application/octet-stream'});
 function send(){if(res.destroyed)return;const n=Math.min(8192,end-start+1);if(n<=0){res.end();return;}if(req.url==='/axel'&&end-start>0)payloadBytes+=n;res.write(Buffer.alloc(n,42));start+=n;timer=setTimeout(send,10);}
 let timer;res.on('close',()=>clearTimeout(timer));send();
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 let progress=0;main.eventBus.on('speedtest-progress',()=>progress++);
 const network=await main.callIpcHandler('speedtest-network',{url:base+'/redirect',timeoutMs:400});
 assert(network.success,JSON.stringify(network));assert(network.bytesReceived>0&&network.bytesReceived<size);assert(network.elapsedSeconds<2);assert(progress>0,'headless sender must emit progress');
 for(const route of ['/error','/html'])assert.equal((await main.callIpcHandler('speedtest-network',{url:base+route,timeoutMs:1000})).success,false);
 progress=0;const downloaded=await main.callIpcHandler('speedtest-downloader',{url:base+'/axel',timeoutMs:1100});
 assert(downloaded.success,JSON.stringify(downloaded));assert(downloaded.bytesReceived>0);assert(downloaded.bytesReceived<size,'must not count sparse file logical length');assert(downloaded.bytesReceived<=payloadBytes,'cannot invent received bytes');assert(progress>0);
 const failing=await main.callIpcHandler('speedtest-downloader',{url:base+'/html',timeoutMs:400});assert.equal(failing.success,false);
 console.log('SPEEDTEST_OK',JSON.stringify({network,downloaded,progress}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{server.closeAllConnections();server.close();fs.rmSync(temp,{recursive:true,force:true});});
