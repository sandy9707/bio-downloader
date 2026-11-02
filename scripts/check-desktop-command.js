const assert=require('assert/strict'),fs=require('fs/promises'),os=require('os'),path=require('path'),http=require('http');
const {startDesktopCommand,callDesktop}=require('../src/main/desktop-command');
(async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'biodl-bridge-'));let bridge;
try{
 const received=[];bridge=await startDesktopCommand({directory:dir,submit:async p=>{received.push(p);return {accepted:true,id:'test'};},status:async()=>({active:1})});
 assert.deepEqual(await callDesktop(dir,'status'),{active:1});
 assert.deepEqual(await callDesktop(dir,'submit',{type:'ebi',accession:'ERR164407',output:path.join(dir,'files')}),{accepted:true,id:'test'});
 assert.equal(received.length,1);
 await assert.rejects(callDesktop(dir,'submit',{type:'unknown',accession:'bad',output:dir}),/无效/);
 await assert.rejects(callDesktop(dir,'submit',{type:'ebi',accession:'ERR164407',output:'relative'}),/绝对/);
 const descriptor=JSON.parse(await fs.readFile(path.join(dir,'desktop-command.json')));
 const denied=await new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port:descriptor.port,path:'/status'},r=>{r.resume();resolve(r.statusCode)}).on('error',reject)});
 assert.equal(denied,403);assert.equal(bridge.server.address().address,'127.0.0.1');
 console.log('DESKTOP_COMMAND_OK: loopback, credential, submit validation, shared status');
}finally{bridge?.close();await fs.rm(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
