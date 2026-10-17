const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
for(const name of ['ascii','中文目录']){
 const folder=fs.mkdtempSync(path.join(os.tmpdir(),'biodl-runtime-'));
 const dir=path.join(folder,name);fs.mkdirSync(dir);for(const entry of fs.readdirSync('src/bin/win32',{withFileTypes:true}))if(entry.isFile())fs.copyFileSync(path.join('src/bin/win32',entry.name),path.join(dir,entry.name));
 const binary=path.join(dir,'aria2c.exe');
 for(const variant of ['absolute','relative']){
  const result=cp.spawnSync(binary,['--version'],{cwd:variant==='relative'?dir:process.cwd(),env:{...process.env,OPENSSL_MODULES:variant==='relative'?'.':dir},encoding:'utf8',timeout:15000,windowsHide:true});
  console.log(JSON.stringify({name,variant,status:result.status,error:result.error?.message,stdout:result.stdout,stderr:result.stderr}));
 }
 fs.rmSync(folder,{recursive:true,force:true,maxRetries:5,retryDelay:100});
}
