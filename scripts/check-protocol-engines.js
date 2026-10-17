// Local FTP/SFTP servers exercise native download binaries without external accounts.
const assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),net=require('net'),crypto=require('crypto');
const {Server,utils}=require('ssh2'),{STATUS_CODE}=utils.sftp;
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-protocols-'));process.env.BIODL_DATA_DIR=path.join(temp,'profile');
const main=require('../main'),axios=require('axios'),bytes=crypto.randomBytes(256*1024+39),events=[],charges=[];
axios.post=async(_u,d)=>{charges.push(d.bytes);return {data:{success:true}}};main.eventBus.on('download-status',d=>events.push(d));
const sockets=new Set(),dataServers=new Set();
function track(socket){sockets.add(socket);socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));return socket;}
const ftp=net.createServer(socket=>{
 track(socket);socket.write('220 fixture\r\n');let fragment='',restart=0,passive,connection;
 const reply=(code,text='OK')=>socket.write(`${code} ${text}\r\n`);
 socket.on('data',chunk=>{fragment+=chunk;const lines=fragment.split('\r\n');fragment=lines.pop();for(const line of lines){const space=line.indexOf(' '),command=(space<0?line:line.slice(0,space)).toUpperCase(),arg=space<0?'':line.slice(space+1);
  if(command==='USER')reply(331);else if(command==='PASS')reply(230);
  else if(command==='TYPE'||command==='OPTS')reply(200);
  else if(command==='CWD')reply(250);
  else if(command==='PWD')reply(257,'"/"');else if(command==='SYST')reply(215,'UNIX Type: L8');
  else if(command==='SIZE')reply(213,String(bytes.length));else if(command==='MDTM')reply(213,'20261017000000');
  else if(command==='REST'){restart=Number(arg);reply(350);}
  else if(command==='FEAT')socket.write('211-Features\r\n SIZE\r\n REST STREAM\r\n211 End\r\n');
  else if(command==='EPSV'||command==='PASV'){
   passive=net.createServer();dataServers.add(passive);connection=new Promise(r=>passive.once('connection',s=>r(track(s))));
   passive.listen(0,'127.0.0.1',()=>{const port=passive.address().port;reply(command==='EPSV'?229:227,command==='EPSV'?`Entering Extended Passive Mode (|||${port}|)`:`Entering Passive Mode (127,0,0,1,${port>>8},${port&255})`);});
  }else if(command==='RETR'){reply(150,'Opening data');connection.then(data=>{data.end(bytes.subarray(restart),()=>reply(226));passive.close();dataServers.delete(passive);});}
  else if(command==='QUIT'){reply(221);socket.end();}else reply(502,'Unsupported '+command);
 }});
});
const hostKey=crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
const sftp=new Server({hostKeys:[hostKey]},client=>{
 client.on('error',()=>{}).on('authentication',ctx=>ctx.method==='password'&&ctx.username==='fixture'&&ctx.password==='fixture'?ctx.accept():ctx.reject()).on('ready',()=>client.on('session',accept=>accept().on('sftp',accept=>{
  const stream=accept(),attrs={mode:0o100644,size:bytes.length,uid:0,gid:0,atime:1,mtime:1};
  stream.on('OPEN',(id)=>stream.handle(id,Buffer.from('file'))).on('CLOSE',id=>stream.status(id,STATUS_CODE.OK));
  for(const command of ['STAT','LSTAT','FSTAT'])stream.on(command,id=>stream.attrs(id,attrs));
  stream.on('REALPATH',(id)=>stream.name(id,[{filename:'/fixture.bin',longname:'fixture.bin',attrs}]));
  stream.on('READ',(id,handle,offset,length)=>offset>=bytes.length?stream.status(id,STATUS_CODE.EOF):stream.data(id,bytes.subarray(offset,Math.min(bytes.length,offset+length))));
 })));
});
const timeout=setTimeout(()=>{console.error('Protocol test timeout');process.exit(2)},90000);
(async()=>{
 main.ensureBinaries();await new Promise(r=>ftp.listen(0,'127.0.0.1',r));await new Promise(r=>sftp.listen(0,'127.0.0.1',r));
 let index=0;
 for(const [protocol,engine] of [['ftp','aria2'],['sftp','aria2'],['ftp','curl']]){
  await main.callIpcHandler('save-settings',{downloadEngines:{[protocol]:engine},deepIntegrityCheck:true});
  const file={name:`${protocol}-${engine}.bin`,url:`${protocol}://fixture:fixture@127.0.0.1:${(protocol==='ftp'?ftp:sftp).address().port}/fixture.bin`,size:bytes.length,md5:crypto.createHash('md5').update(bytes).digest('hex'),originalIndex:++index};
  await main.callIpcHandler('start-download',{files:[file],targetDir:temp,token:'fixture',maxConcurrent:1});
  const final=events.filter(d=>d.index===index&&['completed','failed'].includes(d.status)).at(-1);
  assert.equal(final?.status,'completed',JSON.stringify(final));assert.equal(final.engine,engine);assert.equal(final.verification.status,'verified');assert.deepEqual(fs.readFileSync(final.savePath),bytes);
 }
 assert.deepEqual(charges,[bytes.length,bytes.length,bytes.length]);
 console.log('PROTOCOL_ENGINES_OK',process.platform,'native aria2 FTP/SFTP and curl FTP with independent bytes and MD5');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{clearTimeout(timeout);await main.callIpcHandler('cancel-download');for(const s of sockets)s.destroy();for(const s of dataServers)s.close();ftp.close();sftp.close();fs.rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
