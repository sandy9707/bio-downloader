'use strict';
const fs = require('fs/promises');
const crypto = require('crypto');
const digest = data => crypto.createHash('sha256').update(data).digest('hex');

class TransferError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'TransferError'; this.code = code; Object.assign(this, details); }
}

async function writeAll(handle, bytes, position) {
  for (let offset = 0; offset < bytes.length;) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, position === null ? null : position + offset);
    if (!bytesWritten) throw new TransferError('WRITE_FAILED', '磁盘写入没有前进；已保留断点');
    offset += bytesWritten;
  }
}

// Append-only, hash-chained records. Only a missing final newline is a recoverable
// torn write. A complete but invalid record fails closed, including in the middle.
class Journal {
  static async open(filename, create = false) {
    const handle = await fs.open(filename, create ? 'wx+' : 'r+');
    try {
      const stat = await handle.stat();
      if (stat.size > 128 * 1024 * 1024) throw new TransferError('JOURNAL_LIMIT', '断点日志过大，请保留现场');
      const raw = await handle.readFile(), boundary = raw.lastIndexOf(10) + 1;
      const records = []; let previous = '0'.repeat(64);
      for (const line of raw.subarray(0, boundary).toString('utf8').split('\n').filter(Boolean)) {
        const split = line.lastIndexOf('\t'), body = line.slice(0, split), hash = line.slice(split + 1);
        if (split < 0 || digest(previous + '\n' + body) !== hash) throw new TransferError('JOURNAL_CORRUPT', '断点日志校验失败，不能推测文件已完成');
        try { records.push(JSON.parse(body)); } catch (_) { throw new TransferError('JOURNAL_CORRUPT', '断点日志格式损坏'); }
        previous = hash;
      }
      if (boundary !== raw.length) { await handle.truncate(boundary); await handle.sync(); }
      return new Journal(handle, records, previous, boundary);
    } catch (error) { await handle.close(); throw error; }
  }
  constructor(handle, records, previous, offset) {
    this.handle = handle; this.records = records; this.previous = previous; this.offset = offset; this.pending = Promise.resolve();
  }
  append(record) {
    this.pending = this.pending.then(async () => {
      const body = JSON.stringify(record), hash = digest(this.previous + '\n' + body);
      const bytes = Buffer.from(body + '\t' + hash + '\n');
      await writeAll(this.handle, bytes, this.offset); await this.handle.sync();
      this.offset += bytes.length; this.previous = hash; this.records.push(record);
    });
    return this.pending;
  }
  async close() { try { await this.pending; } finally { await this.handle.close(); } }
}

const fingerprint = stat => Object.fromEntries(['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].map(key => [key, stat[key]]));
async function syncDirectory(directory) {
  // Windows doesn't expose directory fsync through Node. NTFS and the storage
  // device still define the final power-loss guarantees; never claim otherwise.
  if (process.platform === 'win32') return;
  const handle = await fs.open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
module.exports = { Journal, TransferError, digest, writeAll, fingerprint, syncDirectory };
