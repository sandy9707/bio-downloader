'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
async function hash(filename) {
  const h = crypto.createHash('sha256');
  const input = require('fs').createReadStream(filename);
  for await (const chunk of input) h.update(chunk);
  return h.digest('hex');
}
async function available(dir) { const s = await fs.statfs(dir); return Number(s.bavail) * Number(s.bsize); }
async function deliver(source, destination, check = async () => {}) {
  const before = await fs.stat(source);
  if (!before.isFile()) throw new Error('中转源不是普通文件');
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (await available(path.dirname(destination)) < before.size) throw new Error('最终目录空间不足，中转文件已保留');
  // Exclusive creation never overwrites an unrelated file. Interrupted copies
  // are removed only by this invocation; the verified staging original remains.
  const input = await fs.open(source, 'r');
  const temporary = destination + '.biodl-delivery-' + crypto.randomUUID();
  let release;
  let output, created = false;
  try {
    release = await require('proper-lockfile').lock(destination, { realpath: false, retries: 0 });
    try { await fs.lstat(destination); throw new Error('最终文件已存在，已保留中转文件，请核对后重试'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    output = await fs.open(temporary, 'wx');created = true;
    const buf = Buffer.alloc(1024 * 1024);let offset = 0;
    while (offset < before.size) {
      await check();
      const { bytesRead } = await input.read(buf, 0, Math.min(buf.length, before.size - offset), offset);
      if (!bytesRead) throw new Error('中转源提前结束');
      for (let written = 0; written < bytesRead;) {
        const result = await output.write(buf, written, bytesRead - written, offset + written);
        if (!result.bytesWritten) throw new Error('目标磁盘写入未前进');
        written += result.bytesWritten;
      }
      offset += bytesRead;
    }
    await output.sync();await output.close();output = null;
    await check();
    if ((await fs.stat(temporary)).size !== before.size || await hash(source) !== await hash(temporary)) throw new Error('跨盘复制校验失败，中转文件保留');
    await check();
    try { await fs.lstat(destination); throw new Error('最终文件已出现，已保留中转文件'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.rename(temporary, destination);
    created = false; // Destination is verified; later cleanup failures never remove it.
    await fs.unlink(source);
    for (const suffix of ['.biodl-journal','.biodl.json','.aria2','.st']) await fs.unlink(source + suffix).catch(() => {});
    return destination;
  } catch (error) {
    if (output) await output.close().catch(() => {});
    if (created) await fs.unlink(temporary).catch(() => {});
    throw error;
  } finally { await input.close();if (release) await release(); }
}
module.exports = { deliver, available };
