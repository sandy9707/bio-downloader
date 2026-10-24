const assert = require('assert'), crypto = require('crypto'), http = require('http'), net = require('net');
const { Server, utils } = require('ssh2');
const { SshTunnel } = require('../src/main/ssh-tunnel');
(async () => {
  const hostKey = crypto.generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs1',format:'pem'});
  const web = http.createServer((q,r)=>r.end('BIO_TUNNEL_REAL_BYTES'));
  await new Promise(r=>web.listen(0,'127.0.0.1',r));
  let auths=0, allowForward=true; const connections=new Set();
  const server = new Server({hostKeys:[hostKey]}, client => {
    connections.add(client);client.on('error',()=>{});client.on('close',()=>connections.delete(client));
    client.on('authentication', ctx=>{ auths++; if(ctx.method==='password'&&ctx.username==='fixture'&&ctx.password==='secret-fixture')ctx.accept();else ctx.reject(); });
    client.on('ready',()=>client.on('tcpip',(accept,reject,info)=>{
      if(!allowForward)return reject();
      assert.equal(info.destIP,'127.0.0.1');assert.equal(info.destPort,web.address().port);
      const socket=net.connect(info.destPort,info.destIP,()=>{const channel=accept();socket.pipe(channel);channel.pipe(socket);channel.on('close',()=>socket.destroy());channel.on('error',()=>socket.destroy());});socket.on('error',()=>reject());
    }));
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const tunnel=new SshTunnel(),options={host:'127.0.0.1',port:server.address().port,username:'fixture',password:'secret-fixture',remotePort:web.address().port};
  try {
    const trust=await tunnel.start(options);assert(trust.requiresTrust);assert.equal(auths,0,'untrusted host must not receive credentials');assert.match(trust.fingerprint,/^SHA256:/);
    await assert.rejects(tunnel.start(options,'SHA256:changed'),/指纹/);assert.equal(auths,0);
    const live=await tunnel.start(options,trust.fingerprint);assert(live.connected);assert.equal(tunnel.listener.address().address,'127.0.0.1');
    assert.equal(await(await fetch(live.url)).text(),'BIO_TUNNEL_REAL_BYTES');
    await assert.rejects(tunnel.start(options,trust.fingerprint),/先断开/);
    tunnel.stop();assert(!tunnel.status().connected);
    await assert.rejects(tunnel.start({...options,password:'wrong'},trust.fingerprint),/认证失败/);
    allowForward=false;await assert.rejects(tunnel.start(options,trust.fingerprint),/Web 端口/);allowForward=true;
    const occupied=net.createServer();await new Promise(r=>occupied.listen(0,'127.0.0.1',r));
    try {await assert.rejects(tunnel.start({...options,localPort:occupied.address().port},trust.fingerprint),/占用/);}finally{occupied.close();}
    const resumed=await tunnel.start(options,trust.fingerprint);assert.equal(await(await fetch(resumed.url)).text(),'BIO_TUNNEL_REAL_BYTES');tunnel.stop();
    console.log('SSH_TUNNEL_OK',JSON.stringify({platform:process.platform,loopbackOnly:true,untrustedNoCredentials:true,changedKeyRejected:true,realHttp:true,deniedForward:true,portConflict:true,reconnect:true}));
  } finally {tunnel.stop();for(const c of connections)c.end();server.close();web.closeAllConnections();web.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
