const assert = require('assert'), http = require('http'), axios = require('axios');
const { backendGet } = require('../src/main/backend-request');
(async () => {
  const server = http.createServer((req,res) => { res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({success:true,token:'fixture'})); });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const oldProxy = process.env.http_proxy, oldNoProxy = process.env.no_proxy;
  process.env.http_proxy='http://127.0.0.1:1'; process.env.no_proxy='';
  try {
    const url=`http://127.0.0.1:${server.address().port}`;
    assert((await backendGet(url)).data.success);
    const oldGet=axios.get, calls=[];
    try {
      axios.get=async(u,c)=>{calls.push(c);if(calls.length===1)throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});return {data:{success:true}};};
      assert((await backendGet(url)).data.success); assert.equal(calls.length,2); assert.equal(calls[1].family,4); assert(calls.every(c=>c.proxy===false&&c.timeout===15000));
      calls.length=0;
      axios.get=async(u,c)=>{calls.push(c);if(calls.length<3)throw Object.assign(new Error('timeout'),{code:'ECONNABORTED'});return {data:{success:true}};};
      assert((await backendGet(url,{timeout:8000,retryAttempts:3})).data.success);
      assert.equal(calls.length,3);assert.equal(calls[1].family,4);assert.equal(calls[2].family,undefined);
      assert(calls.every(c=>c.proxy===false&&c.timeout===8000&&!('retryAttempts' in c)));
      calls.length=0;
      axios.get=async(u,c)=>{calls.push(c);throw Object.assign(new Error('forbidden'),{response:{status:403}});};
      await assert.rejects(backendGet(url,{retryAttempts:3}),/forbidden/);assert.equal(calls.length,1);
    } finally {axios.get=oldGet;}
    console.log('BACKEND_REQUEST_OK: direct version request, bounded retry, IPv4 fallback');
  } finally { if(oldProxy===undefined)delete process.env.http_proxy;else process.env.http_proxy=oldProxy;if(oldNoProxy===undefined)delete process.env.no_proxy;else process.env.no_proxy=oldNoProxy;server.closeAllConnections();server.close(); }
})().catch(e=>{console.error(e);process.exitCode=1});
