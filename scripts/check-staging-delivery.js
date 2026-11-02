const fs=require('fs/promises'),path=require('path'),os=require('os'),assert=require('assert/strict');
const {deliver}=require('../src/main/staging-delivery');
(async()=>{const dir=await fs.mkdtemp(path.join(os.tmpdir(),'biodl-stage-'));try{
 const source=path.join(dir,'source'),dest=path.join(dir,'disk','out');const data=Buffer.alloc(3*1048576+7,91);
 await fs.writeFile(source,data);await deliver(source,dest);assert.deepEqual(await fs.readFile(dest),data);await assert.rejects(fs.stat(source));
 await fs.writeFile(source,data);await assert.rejects(deliver(source,dest),/最终文件已存在/);assert.deepEqual(await fs.readFile(source),data);
 const interrupted=path.join(dir,'disk','interrupted');let checks=0;
 await assert.rejects(deliver(source,interrupted,async()=>{if(++checks===2)throw Error('Cancelled');}),/Cancelled/);
 await assert.rejects(fs.stat(interrupted));assert.deepEqual(await fs.readFile(source),data);
 console.log('STAGING_DELIVERY_OK: verified copy, exclusive target, interrupted source retention');
}finally{await fs.rm(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
