// Runs outside app.asar. The helper waits for the old process to exit before
// replacing its archive; the running Electron process never rewrites itself.
const fs = process.versions.electron ? require('original-fs') : require('fs');
const path = require('path'), crypto = require('crypto'), { spawn } = require('child_process');
const PUBLIC_KEY = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAdmJCuvTeFDhaU9DPSEP3yfSmf8OCCxnrt206d4L6VWY=\n-----END PUBLIC KEY-----';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function verify(file, manifest) {
  const digest = hash(file);
  if (digest !== String(manifest.sha256).toLowerCase() || !crypto.verify(null, Buffer.from(digest), PUBLIC_KEY, Buffer.from(manifest.signature || '', 'base64'))) throw new Error('更新补丁签名或 SHA256 校验失败');
}
function archiveVersion(file) {
  const b = fs.readFileSync(file);
  if (b.length < 16) throw new Error('更新包 ASAR 头无效');
  const length = b.readUInt32LE(12);
  if (length > 16 * 1024 * 1024 || 16 + length > b.length) throw new Error('更新包 ASAR 头无效');
  const header = JSON.parse(b.toString('utf8', 16, 16 + length)), entry = header.files?.['package.json'];
  if (!entry || !header.files?.['main.js'] || !header.files?.['index.html']) throw new Error('更新包缺少启动文件');
  const offset = 8 + b.readUInt32LE(4) + Number(entry.offset);
  if (!Number.isSafeInteger(offset) || offset < 16 + length || !Number.isSafeInteger(entry.size) || entry.size < 1 || offset + entry.size > b.length) throw new Error('更新包版本文件无效');
  return JSON.parse(b.toString('utf8', offset, offset + entry.size)).version;
}
function atomicJSON(file, data) {
  const temp = file + '.tmp'; fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 }); fs.renameSync(temp, file);
}
function prepare({ patch, manifest, resources, userData, executable, pid = process.pid, args = [] }) {
  const target = path.join(resources, 'app.asar');
  verify(patch, manifest);
  const version = archiveVersion(patch);
  if (!manifest.version || version !== manifest.version) throw new Error('更新包版本与官方清单不一致');
  if (!fs.statSync(target).isFile()) throw new Error('当前安装目录不支持补丁更新，请使用完整安装包');
  let dir;
  try {
    // Stage beside the destination: rename remains atomic across volumes.
    dir = fs.mkdtempSync(path.join(resources, '.biodl-update-'));
    fs.copyFileSync(patch, path.join(dir, 'next.asar'));
    const fd = fs.openSync(path.join(dir, 'next.asar'), 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    verify(path.join(dir, 'next.asar'), manifest);
    fs.mkdirSync(path.join(userData, 'updates'), { recursive: true, mode: 0o700 });
    const result = path.join(userData, 'updates', path.basename(dir) + '.json');
    const job = { target, patch: path.join(dir, 'next.asar'), backup: path.join(dir, 'previous.asar'), oldHash: hash(target), manifest, version, executable, args, pid, result };
    fs.writeFileSync(path.join(dir, 'helper.cjs'), require('fs').readFileSync(__filename), { mode: 0o600 });
    atomicJSON(path.join(dir, 'job.json'), job);
    return { dir, job };
  } catch (e) {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    throw new Error('无法准备更新，当前版本未更改。请使用完整安装包：' + e.message);
  }
}
function launchHelper(prepared) {
  return new Promise((resolve, reject) => {
    const child = spawn(prepared.job.executable, [path.join(prepared.dir, 'helper.cjs'), '--apply', path.join(prepared.dir, 'job.json')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: prepared.dir,
      detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    let ready = false;
    const timer = setTimeout(() => { child.kill(); reject(new Error('独立更新器未就绪，程序保持运行，请使用完整安装包')); }, 10000);
    child.once('error', e => { clearTimeout(timer); reject(e); });
    child.once('exit', code => { if (!ready) { clearTimeout(timer); reject(new Error('独立更新器启动失败：' + code)); } });
    child.on('message', message => {
      if (message?.ready) { ready = true; clearTimeout(timer); child.unref(); resolve({ result: prepared.job.result }); }
      else if (message?.error) { clearTimeout(timer); reject(new Error(message.error)); }
    });
  });
}
const delay = ms => new Promise(r => setTimeout(r, ms));
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } }
async function retryRename(from, to) {
  for (let i = 0; ; i++) {
    try { fs.renameSync(from, to); return; }
    catch (e) { if (i >= 29 || !['EPERM', 'EACCES', 'EBUSY'].includes(e.code)) throw e; await delay(300); }
  }
}
async function apply(job, { relaunch = true, waitMs = 60000 } = {}) {
  const save = (status, extra = {}) => atomicJSON(job.result, { status, version: job.version, target: job.target, backup: job.backup, updatedAt: new Date().toISOString(), ...extra });
  let moved = false, installed = false;
  try {
    verify(job.patch, job.manifest);
    if (archiveVersion(job.patch) !== job.version || hash(job.target) !== job.oldHash) throw new Error('安装目录或补丁已变化，已取消更新');
    save('waiting-for-exit');
    if (process.send) { await new Promise(r => process.send({ ready: true }, r)); process.disconnect(); }
    const deadline = Date.now() + waitMs;
    while (alive(job.pid)) { if (Date.now() >= deadline) throw new Error('原程序尚未退出，已取消更新'); await delay(200); }
    // Recheck after the wait, before touching the installed archive.
    verify(job.patch, job.manifest);
    if (hash(job.target) !== job.oldHash) throw new Error('安装文件已被其他更新修改');
    await retryRename(job.target, job.backup); moved = true;
    await retryRename(job.patch, job.target); installed = true;
    verify(job.target, job.manifest);
    save('applied');
    if (relaunch) {
      const env = { ...process.env, BIODL_UPDATE_RECEIPT: job.result }; delete env.ELECTRON_RUN_AS_NODE;
      const child = spawn(job.executable, job.args || [], { env, cwd: path.dirname(job.executable), detached: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
      // The new process can acknowledge before the spawn callback returns.
      if (JSON.parse(fs.readFileSync(job.result, 'utf8')).status !== 'running') save('launched');
    }
    return { success: true, version: job.version };
  } catch (e) {
    let rollbackError;
    if (moved) {
      try {
        if (installed && fs.existsSync(job.target)) fs.renameSync(job.target, job.patch);
        await retryRename(job.backup, job.target);
      } catch (r) { rollbackError = r.message; }
    }
    save(rollbackError ? 'recovery-required' : 'failed', { error: e.message, rollbackError });
    if (process.connected) { await new Promise(r => process.send({ error: e.message }, r)); process.disconnect(); }
    // If the old application has already exited, make the recovered version
    // usable again. Never launch a second copy while the parent is still alive.
    if (relaunch && !rollbackError && !alive(job.pid) && fs.existsSync(job.executable)) {
      try {
        const env = { ...process.env, BIODL_UPDATE_FAILURE: e.message }; delete env.ELECTRON_RUN_AS_NODE; delete env.BIODL_UPDATE_RECEIPT;
        const child = spawn(job.executable, job.args || [], { env, cwd: path.dirname(job.executable), detached: true, stdio: 'ignore' });
        await new Promise((resolve,reject) => { child.once('spawn',resolve);child.once('error',reject); });child.unref();
      } catch (restartError) { save('failed', { error: e.message, restartError: restartError.message }); }
    }
    throw e;
  }
}
function acknowledge(receipt, version, target) {
  if (!receipt) return;
  try {
    const data = JSON.parse(fs.readFileSync(receipt, 'utf8'));
    if (data.version !== version || path.resolve(data.target) !== path.resolve(target)) return;
    // This runs from the newly started application, not from the updater.
    atomicJSON(receipt, { ...data, status: 'running', runningVersion: version, runningPid: process.pid, confirmedAt: new Date().toISOString() });
  } catch (e) { console.warn('[HotPatch] 无法记录更新启动结果:', e.message); }
}
module.exports = { prepare, launchHelper, apply, verify, archiveVersion, acknowledge };
if (require.main === module && process.argv[2] === '--apply') {
  apply(JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))).catch(() => { process.exitCode = 1; });
}
