'use strict';
const {enaIdentity,validMd5,knownSize}=require('./download-integrity');
function repairSource(file,reference,{deep=false}={}){
 if(!deep||!knownSize(reference?.expectedSize)||!validMd5(reference?.expectedMd5))return null;
 try{const u=new URL(file.url);if(u.search||u.hash||u.port||u.username||u.password)return null;const id=enaIdentity(u.href);if(!id)return null;
 if (file.sourceSelection || file.transport != null) {
    if (!['http:', 'https:'].includes(u.protocol) || (file.transport != null && file.transport !== u.protocol.slice(0,-1))) return null;
    return {url:file.url};
  }
  // Preserve historical archive mappings for older queues.
 return {url:'http://'+id.key};}catch(_){return null;}
}
async function repairMismatch({file,filename,reference,verification,deep,checkControl,signal,proxy,onProgress}){
 const source=repairSource(file,reference,{deep});
 if(verification?.status!=='mismatch'||!source)return verification;
 try{const r=await require('./fastq-repair-auto').repairFastqAutomatically({filename,sourceUrl:source.url,reference,checkControl,signal,proxy,onProgress});return {...r,repair:{status:'verified',fetchedBytes:r.fetchedBytes,patches:r.patches.map(p=>({backupPath:p.backupPath,patchedBytes:p.patchedBytes}))}};}
 catch(error){error.verification={...verification,reason:error.message,repair:{status:signal?.aborted?'interrupted':'stopped',code:error.code||null,...error.repair}};error.preserveMismatch=true;throw error;}
}
module.exports={repairSource,repairMismatch};
