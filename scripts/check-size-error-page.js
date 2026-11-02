const fs=require('fs'),vm=require('vm'),assert=require('assert/strict');
const source=fs.readFileSync(require('path').join(__dirname,'../main.js'),'utf8');
let mode='error';const axios={head:async()=>{throw Error('no head')},get:async()=>{
 if(mode==='error')throw Object.assign(Error('403'),{response:{headers:{'content-length':'199','content-type':'text/html'}}});
 return {headers:{'content-range':'bytes 0-1/123456','content-length':'2'}};
}};
const c=vm.createContext({axios,clashProcess:null});vm.runInContext(source.slice(source.indexOf('async function headRequestSize('),source.indexOf('// 【IPC 通信总线】')),c);
(async()=>{assert.equal(await c.headRequestSize('https://example.test/file'),0);mode='valid';assert.equal(await c.headRequestSize('https://example.test/file'),123456);console.log('SIZE_ERROR_PAGE_OK: reject error body length, accept source range total');})().catch(e=>{console.error(e);process.exitCode=1});
