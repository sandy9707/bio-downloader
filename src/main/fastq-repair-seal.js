'use strict';
const path=require('node:path');
const {writeExclusive,syncDirectory}=require('./fastq-repair-backup');
const {validMd5,knownSize}=require('./download-integrity');
// Called only under the session lease, after final content verification.
async function sealRepairPatches(patches,verification,identity){
 if(verification.status!=='verified'||verification.gzip!=='passed'||!validMd5(verification.expectedMd5)||!knownSize(verification.actualSize))throw Error('不得封存未通过官方最终验收的补丁');
 for(const patch of patches){
  if(!patch.backupPath)continue;
  await writeExclusive(path.join(patch.backupPath,'verified.json'),JSON.stringify({version:1,state:'verified',expectedMd5:verification.expectedMd5,size:verification.actualSize,fileIdentity:{dev:identity.dev,ino:identity.ino},time:new Date().toISOString()})+'\n');
  await syncDirectory(patch.backupPath);
 }
}
module.exports={sealRepairPatches};
