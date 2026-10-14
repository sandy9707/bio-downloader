const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { controlProcess } = require('../src/main/process-control');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-pause-test-'));
const heartbeat = path.join(temp, 'heartbeat');
const child = spawn(process.execPath, ['-e', "setInterval(()=>require('fs').appendFileSync(process.argv[1],'.'),30)", heartbeat], { windowsHide:true, stdio:'ignore' });
(async () => {
  for(let i=0;i<100 && !fs.existsSync(heartbeat);i++) await delay(50);
  assert.ok(fs.existsSync(heartbeat), 'child must start');
  await Promise.all([controlProcess(child,true),controlProcess(child,true)]);
  await delay(100);
  const stopped = fs.statSync(heartbeat).size;
  await delay(350);
  assert.equal(fs.statSync(heartbeat).size, stopped, 'paused process must stop doing work');
  assert.equal(await controlProcess(child,false), true);
  await delay(350);
  assert.ok(fs.statSync(heartbeat).size > stopped, 'one resume must undo repeated pause requests');
  await controlProcess(child,true);
  await controlProcess(child,false);
  console.log('操作系统进程控制通过 ('+process.platform+'): 真实进程暂停、重复暂停、恢复');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{
  try { await controlProcess(child,false); } catch(_) {}
  const closed = new Promise(resolve=>child.once('close',resolve));
  child.kill('SIGKILL'); await closed;
  fs.rmSync(temp,{recursive:true,force:true});
});
