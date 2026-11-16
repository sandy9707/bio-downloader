'use strict';
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { validateRepairRange } = require('./fastq-repair-range');
async function syncDirectory(directory) {
  // Windows does not expose directory fsync through Node. Each evidence file
  // is still synchronously flushed before committing any source bytes.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeExclusive(filename, data) {
  const handle = await fs.open(filename, 'wx', 0o600);
  try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
}
// This creates recovery evidence only. Caller must hold the source lock and obtain
// bytes from the locked descriptor, then recheck identity before any patch writes.
async function createRepairBackup(input) {
  const { filename, start, end, size, etag, sourceUrl, bytes } = input;
  const url = new URL(sourceUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw Error('备份来源必须为无凭据的固定 HTTP(S) URL');
  if (typeof filename !== 'string' || !path.isAbsolute(filename)) throw Error('备份目标必须为绝对路径');
  validateRepairRange({ start, end, size, etag, maxBytes: 16 * 1024 * 1024 }, {
    status: 206, headers: { etag, 'content-range': `bytes ${start}-${end - 1}/${size}` }, data: bytes
  });
  const parent = await fs.realpath(path.dirname(filename));
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== size) throw Error('备份目标身份或大小已改变');
  const directory = path.join(parent, '.biodl-repair-' + crypto.randomUUID());
  await fs.mkdir(directory, { mode: 0o700 });
  // No cleanup on failure: incomplete evidence is retained; source is never touched.
  await writeExclusive(path.join(directory, 'original.bin'), bytes);
  await writeExclusive(path.join(directory, 'record.json'), JSON.stringify({
    version: 1, state: 'backed-up', filename: path.basename(filename), sourceUrl: url.href,
    start, end, size, etag, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    fileIdentity: { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs }, createdAt: new Date().toISOString()
  }, null, 2) + '\n');
  await syncDirectory(directory);
  await syncDirectory(parent);
  return directory;
}
module.exports = { createRepairBackup, writeExclusive, syncDirectory };
