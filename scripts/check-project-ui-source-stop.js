'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {gzipSync}=require('node:zlib');
const {createProjectService}=require('../packages/cli/project-sources');

async function fixture(t,{status=403,denyAt=11,ftpDenied=false,challenge=false}={}) {
  const bytes=gzipSync('@r\nACGT\n+\nIIII\n');
  const calls=[];let ftpCalls=0;
  const files=Array.from({length:24},(_,index)=>({run:`HRR${100+index}`,name:`f${index}.fastq.gz`,format:'fastq',size:bytes.length,url:`https://download.cncb.ac.cn/f${index}.fastq.gz`,alternatives:[`ftp://download.cncb.ac.cn/f${index}.fastq.gz`]}));
  const server=http.createServer((req,res)=>{
    calls.push(req.url);const index=Number(/f(\d+)/.exec(req.url)[1]);
    if(index===denyAt){res.writeHead(status,challenge?{'cf-mitigated':'challenge','content-type':'text/html'}:{});res.end(challenge?'<title>Verifying your browser</title>':'denied');return;}
    res.writeHead(206,{'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`,'content-length':bytes.length});res.end(bytes);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const get=async(url,options)=>{
    const reply=await fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,{signal:options.signal});
    return {status:reply.status,headers:Object.fromEntries(reply.headers),data:Buffer.from(await reply.arrayBuffer())};
  };
  const service=createProjectService(async()=>({accession:'HRA1',access:'public',files,runs:files.map(f=>f.run)}),{get,ftp:async()=>{ftpCalls++;if(ftpDenied)throw Object.assign(Error('FTP response: 530 Login incorrect'),{ftpCode:530});return {size:bytes.length,bytes};}});
  return {service,calls,files,ftpCalls:()=>ftpCalls};
}

test('HRA HTTP refusal is permanent for query, stops later files and protocols',async t=>{
 const f=await fixture(t);const q=await f.service.query('HRA1');
 const first=await f.service.probe({queryId:q.queryId,page:{indices:Array.from({length:10},(_,i)=>i),column:'https'}});
 assert.ok(first.every(row=>row.sources[0].available));
 const denied=await f.service.probe({queryId:q.queryId,page:{indices:Array.from({length:10},(_,i)=>10+i),column:''}});
 assert.ok(denied.every(row=>row.terminal&&row.sources.length===0));
 assert.equal(f.calls.length,12);assert.equal(f.ftpCalls(),1);
 await f.service.probe({queryId:q.queryId,page:{cancel:true}});
 const again=await f.service.probe({queryId:q.queryId,page:{indices:[20],column:'ftp'}});
 assert.ok(again[0].terminal);assert.equal(f.calls.length,12);assert.equal(f.ftpCalls(),1);
 const fresh=await f.service.query('HRA1');
 assert.ok((await f.service.probe({queryId:fresh.queryId,page:{indices:[0],column:'https'}}))[0].sources[0].available);
});
for(const status of [401,429])test(`HRA HTTP ${status} stops before FTP`,async t=>{
 const f=await fixture(t,{status,denyAt:0});const q=await f.service.query('HRA1');
 const rows=await f.service.probe({queryId:q.queryId,page:{indices:[0,1],column:''}});
 assert.ok(rows.every(row=>row.terminal));assert.equal(f.calls.length,1);assert.equal(f.ftpCalls(),0);
});
test('HRA challenge and FTP530 are terminal, not ordinary missing files',async t=>{
 const f=await fixture(t,{status:200,denyAt:0,challenge:true});const q=await f.service.query('HRA1');
 assert.ok((await f.service.probe({queryId:q.queryId,page:{indices:[0,1],column:''}}))[0].terminal);assert.equal(f.ftpCalls(),0);
 const ftp=await fixture(t,{denyAt:99,ftpDenied:true});const fq=await ftp.service.query('HRA1');
 const rows=await ftp.service.probe({queryId:fq.queryId,page:{indices:[0,1],column:''}});
 assert.ok(rows.every(row=>row.terminal&&row.sources.length===0));assert.equal(ftp.calls.length,1);assert.equal(ftp.ftpCalls(),1);
});
test('network timeouts are per-file failures, not access revocation',async()=>{
 const files=[0,1].map(i=>({run:`HRR${100+i}`,name:`f${i}.fastq.gz`,format:'fastq',size:100,url:`https://download.cncb.ac.cn/f${i}.fastq.gz`}));let calls=0;
 const service=createProjectService(async()=>({accession:'HRA1',access:'public',files,runs:files.map(f=>f.run)}),{get:async()=>{calls++;throw Object.assign(Error('timeout'),{code:'ETIMEDOUT'});}});
 const q=await service.query('HRA1');const rows=await service.probe({queryId:q.queryId,page:{indices:[0,1],column:'https'}});
 assert.equal(calls,2);assert.ok(rows.every(row=>!row.terminal&&!row.sources[0].available));
});

test('HRA404 stays a per-file failure and continues',async t=>{
 const f=await fixture(t,{status:404,denyAt:0});const q=await f.service.query('HRA1');
 const rows=await f.service.probe({queryId:q.queryId,page:{indices:[0,1],column:'https'}});
 assert.ok(!rows[0].terminal);assert.equal(rows[0].sources[0].available,false);assert.equal(rows[1].sources[0].available,true);assert.equal(f.calls.length,2);
});
