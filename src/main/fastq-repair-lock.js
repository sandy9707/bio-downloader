'use strict';
const path=require('node:path');
const leases=new WeakMap();
async function acquireRepairLock(filename){
 const target=path.resolve(filename);let compromised,active=true;
 const release=await require('proper-lockfile').lock(target,{realpath:false,retries:0,onCompromised:error=>{compromised=error;}});
 const lease={};leases.set(lease,{target,check(){if(!active)throw Error('修复锁已释放');if(compromised)throw compromised;}});
 return {lease,async release(){try{await release();}finally{active=false;}}};
}
function checkRepairLock(lease,filename){
 const state=leases.get(lease);if(!state||state.target!==path.resolve(filename))throw Error('无效修复会话锁');state.check();
}
module.exports={acquireRepairLock,checkRepairLock};
