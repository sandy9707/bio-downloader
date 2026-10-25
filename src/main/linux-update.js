// Replace only shipped program entries. Keep the runtime, user directories and
// a recoverable copy of the previous program; undo every completed rename on error.
const fs = require('fs'), path = require('path'), cp = require('child_process');
const FILES = ['main.js','renderer.js','preload.js','index.html','package.json','package-lock.json','THIRD_PARTY_NOTICES.md','speedtest.html','biodl'];
const DIRS = ['packages','shared','img','icons','bin','src','node_modules'];
function assertNoOtherServer(root) {
  if (process.platform !== 'linux') return;
  for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n) && Number(n) !== process.pid)) {
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (!args.includes('start') || !args[1]) continue;
      const cli = path.resolve(fs.readlinkSync(`/proc/${pid}/cwd`), args[1]);
      if (cli === path.join(root,'packages/cli/bin.js')) throw Object.assign(new Error('请先停止此目录正在运行的 Linux 服务，再执行命令行更新'), { serverFound: true });
    } catch (e) { if (e.serverFound) throw e; }
  }
}
function validateSource(source, version, node) {
  if (!version || JSON.parse(fs.readFileSync(path.join(source,'package.json'))).version !== version) throw new Error('Linux 更新包版本与官方清单不一致');
  for (const item of ['main.js','biodl','packages/cli/bin.js','packages/web/index.html','node_modules/axios/package.json']) {
    if (!fs.statSync(path.join(source,item)).isFile()) throw new Error('Linux 更新包缺少文件：' + item);
  }
  const result = cp.spawnSync(node, ['--check', path.join(source,'main.js')], { encoding: 'utf8', timeout: 15000 });
  if (result.status !== 0) throw new Error('Linux 更新包启动检查失败：' + (result.error?.message || result.stderr));
}
function install({ source, root, version, userData, node = process.execPath }) {
  assertNoOtherServer(root);
  validateSource(source, version, node);
  const entries = [...FILES, ...DIRS].filter(n => fs.existsSync(path.join(source,n)));
  if (userData && entries.some(n => { const rel=path.relative(path.join(root,n),path.resolve(userData));return rel === '' || (!rel.startsWith('..'+path.sep) && rel !== '..' && !path.isAbsolute(rel)); })) throw new Error('用户数据目录与程序文件重叠，请先迁移数据后更新');
  // New main/package are installed last, after all dependencies and resources.
  entries.sort((a,b) => Number(['main.js','package.json'].includes(a))-Number(['main.js','package.json'].includes(b)));
  const transaction = fs.mkdtempSync(path.join(root,'.biodl-update-'));
  const next = path.join(transaction,'next'), backup = path.join(transaction,'previous');
  fs.mkdirSync(next);fs.mkdirSync(backup);
  const changed = [];
  const journal = path.join(transaction,'result.json');
  const save = (status, extra = {}) => {
    const temp = journal+'.tmp';fs.writeFileSync(temp,JSON.stringify({status,version,changed,...extra},null,2));fs.renameSync(temp,journal);
  };
  try {
    for (const name of entries) fs.cpSync(path.join(source,name),path.join(next,name),{recursive:true});
    fs.chmodSync(path.join(next,'biodl'),0o755);
    save('prepared');
    for (const name of entries) {
      const entry={name,existed:fs.existsSync(path.join(root,name)),moved:false,installed:false};changed.push(entry);
      save('installing');
      if(entry.existed){fs.renameSync(path.join(root,name),path.join(backup,name));entry.moved=true;}
      fs.renameSync(path.join(next,name),path.join(root,name));entry.installed=true;
      save('installing');
    }
    validateSource(root,version,node);
    save('installed');
    return { version, backup, journal };
  } catch (e) {
    const rollbackErrors=[];
    for(const entry of [...changed].reverse()) {
      try {
        if(entry.installed)fs.renameSync(path.join(root,entry.name),path.join(next,entry.name));
        if(entry.moved)fs.renameSync(path.join(backup,entry.name),path.join(root,entry.name));
      } catch(r){rollbackErrors.push(entry.name+': '+r.message);}
    }
    save(rollbackErrors.length?'recovery-required':'rolled-back',{error:e.message,rollbackErrors});
    throw new Error(rollbackErrors.length ? `更新失败，请从 ${backup} 恢复程序：${e.message}` : `更新失败，原程序已保留：${e.message}`);
  }
}
module.exports={install,validateSource,assertNoOtherServer};
