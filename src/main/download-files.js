const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { bioSource } = require('./bio-transfer-guard');
const active = new Set();
const suffixes = ['', '.st', '.aria2', '.biodl.json', '.biodl-verification.json'];
const sourceKey = url => crypto.createHash('sha256').update(bioSource(url) || String(url || '')).digest('hex');
function claimFile(filename) {
  const key = process.platform === 'win32' ? path.resolve(filename).toLowerCase() : path.resolve(filename);
  if (active.has(key)) throw new Error('同一文件已有下载或校验任务，请等待该任务完成');
  active.add(key);
  return () => active.delete(key);
}
function hasResume(filename) { return fs.existsSync(filename + '.st') || fs.existsSync(filename + '.aria2'); }
async function priorMismatch(filename, url) {
  if (!fs.existsSync(filename) || hasResume(filename)) return false;
  for (const suffix of ['.biodl-verification.json', '.biodl.json']) {
    try {
      const record = filename + suffix;
      if ((await fs.promises.stat(record)).size > 1024 * 1024) continue;
      const data = JSON.parse(await fs.promises.readFile(record, 'utf8'));
      if (data.sourceKey === sourceKey(url) && data.verification?.status === 'mismatch') return true;
    } catch (_) { /* A missing/corrupt record cannot authorize replacement. */ }
  }
  return false;
}
async function persistVerification(filename, url, verification) {
  if (!url || !['verified', 'mismatch'].includes(verification?.status)) return;
  const record = filename + '.biodl-verification.json';
  const temp = record + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
  try {
    await fs.promises.writeFile(temp, JSON.stringify({ version: 1, sourceKey: sourceKey(url), verification }), { flag: 'wx', mode: 0o600 });
    await fs.promises.rename(temp, record);
  } finally { await fs.promises.unlink(temp).catch(() => {}); }
}
async function preserveForRedownload(filename) {
  if (!fs.existsSync(filename)) return null;
  if (!(await fs.promises.lstat(filename)).isFile()) throw new Error('目标不是普通文件，无法重新下载');
  const stat = await fs.promises.stat(filename);
  let free = null;
  try { const volume = await fs.promises.statfs(path.dirname(filename)); free = Number(volume.bavail) * Number(volume.bsize); } catch (_) {}
  if (free !== null && free < stat.size) throw new Error('磁盘空间不足以保留原文件并重新下载，请释放空间后重试');
  const folder = path.join(path.dirname(filename), '.biodl-replaced', Date.now() + '-' + crypto.randomBytes(4).toString('hex'));
  await fs.promises.mkdir(folder, { recursive: true });
  const moved = [];
  try {
    for (const suffix of suffixes) {
      const from = filename + suffix, to = path.join(folder, path.basename(filename) + suffix);
      if (!fs.existsSync(from)) continue;
      await fs.promises.rename(from, to);
      moved.push({ from, to });
    }
    return path.join(folder, path.basename(filename));
  } catch (error) {
    for (const { from, to } of moved.reverse()) await fs.promises.rename(to, from);
    throw error;
  }
}
module.exports = { claimFile, hasResume, priorMismatch, persistVerification, preserveForRedownload };
