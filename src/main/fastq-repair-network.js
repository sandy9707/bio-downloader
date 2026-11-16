'use strict';
const axios=require('axios');
const {validateRepairHeaders,validateRepairRange}=require('./fastq-repair-range');
// Explicit application route only; never inherit environment proxy or redirect.
async function request(url,{proxy,signal,timeoutMs=60000,...options}){
 const u=new URL(url);
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.hash||u.search)throw Error('无效局部修复源');
 if(proxy!==false&&(!proxy||proxy.protocol!=='http'||!proxy.host||!Number.isInteger(proxy.port)))throw Error('局部修复必须明确指定网络路径');
 return axios({url:u.href,proxy,signal,timeout:timeoutMs,maxRedirects:0,decompress:false,validateStatus:()=>true,...options});
}
async function probeRepairSource(url,size,options){
 const res=await request(url,{...options,method:'HEAD',headers:{'Accept-Encoding':'identity'}});
 if(res.status!==200||String(res.headers['content-length'])!==String(size))throw Error('局部修复源大小或状态不匹配');
 const etag=res.headers.etag;
 validateRepairHeaders({start:0,end:1,size,etag,maxBytes:1},{status:206,headers:{etag,'content-range':`bytes 0-0/${size}`,'content-encoding':res.headers['content-encoding']}});
 return {etag,size};
}
async function fetchRepairRange(url,expected,options){
 validateRepairHeaders(expected,{status:206,headers:{etag:expected.etag,'content-range':`bytes ${expected.start}-${expected.end-1}/${expected.size}`}});
 const res=await request(url,{...options,method:'GET',responseType:'arraybuffer',maxContentLength:expected.end-expected.start,
 headers:{Range:`bytes=${expected.start}-${expected.end-1}`,'If-Match':expected.etag,'Accept-Encoding':'identity'}});
 return validateRepairRange(expected,{status:res.status,headers:res.headers,data:Buffer.from(res.data)});
}
module.exports={probeRepairSource,fetchRepairRange};
