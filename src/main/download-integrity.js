const fs = require('fs');
const crypto = require('crypto');

function validMd5(value) {
  const text = String(value || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(text) ? text : null;
}

function knownSize(value) {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : null;
}

// Match the public ENA FASTQ host and full path, never just a basename.
function enaIdentity(value) {
  try {
    const url = new URL(String(value).includes('://') ? value : `https://${value}`);
    if (!['https:', 'http:', 'ftp:'].includes(url.protocol) || url.hostname !== 'ftp.sra.ebi.ac.uk' || url.port || url.username || url.password) return null;
    const match = /^\/vol1\/fastq\/.+\/((?:SRR|ERR|DRR)\d+)\/\1(?:_\d+)?\.fastq\.gz$/.exec(url.pathname);
    return match ? { run: match[1], key: url.hostname + url.pathname } : null;
  } catch (_) { return null; }
}

function parseEnaReport(rows) {
  if (!Array.isArray(rows)) throw new Error('EBI 返回的校验信息格式无效');
  const files = [];
  for (const row of rows) {
    const urls = String(row.fastq_ftp || '').split(';');
    const hashes = String(row.fastq_md5 || '').split(';');
    const sizes = String(row.fastq_bytes || '').split(';');
    urls.forEach((value, index) => {
      const url = value.trim();
      const identity = enaIdentity(url);
      if (!identity || (row.run_accession && row.run_accession !== identity.run)) return;
      files.push({
        name: url.slice(url.lastIndexOf('/') + 1),
        url: `http://${identity.key}`, folder: identity.run,
        // Do not shift positions when a field is empty or a list is malformed.
        md5: hashes.length === urls.length ? validMd5(hashes[index]) : null,
        size: sizes.length === urls.length ? (knownSize(sizes[index]) || 0) : 0
      });
    });
  }
  return files;
}

function createEnaResolver(fetchRows) {
  const cache = new Map();
  function list(run) {
    const cached = cache.get(run);
    if (cached && cached.expires > Date.now()) return cached.promise;
    const entry = { expires: Infinity };
    entry.promise = Promise.resolve().then(() => fetchRows(run)).then(rows => {
      const files = parseEnaReport(rows);
      entry.expires = Date.now() + 5 * 60 * 1000;
      return files;
    }).catch(error => {
      entry.expires = Date.now() + 10000;
      throw error;
    });
    cache.delete(run);
    cache.set(run, entry);
    if (cache.size > 256) cache.delete(cache.keys().next().value);
    return entry.promise;
  }
  async function reference(file, { deep = false } = {}) {
    const identity = enaIdentity(file.url);
    const result = { expectedSize: knownSize(file.size), expectedMd5: validMd5(file.md5), required: deep && Boolean(identity || validMd5(file.md5)), gzip: /\.gz(?:[?#]|$)/i.test(file.name || file.url || '') };
    // Fast checks need no extra checksum request when the size is already known.
    if (!identity || (result.expectedSize && (!deep || result.expectedMd5))) return result;
    try {
      const files = await list(identity.run);
      const match = files.find(item => enaIdentity(item.url).key === identity.key);
      if (match) {
        result.expectedSize = knownSize(match.size) || result.expectedSize;
        result.expectedMd5 = match.md5 || result.expectedMd5;
      }
      if (!result.expectedMd5) result.reason = 'EBI 暂未提供该文件的 MD5';
    } catch (_) {
      result.reason = 'EBI 校验信息暂时不可用';
    }
    return result;
  }
  return { list, reference };
}

async function verifyFile(filename, reference, { deep = false, checkControl = () => {}, onProgress = () => {} } = {}) {
  await checkControl();
  const before = await fs.promises.stat(filename);
  await checkControl();
  const result = {
    status: 'unchecked', expectedSize: reference.expectedSize, actualSize: before.size,
    expectedMd5: reference.expectedMd5, actualMd5: null, reason: reference.reason || null,
    method: deep ? 'md5' : 'quick', sampledBytes: 0
  };
  function fail(message) {
    result.status = 'failed';
    const error = new Error(`${message}；原文件已保留，请核对后选择其他目录重下或手动处理`);
    error.verification = result;
    throw error;
  }
  if (!before.isFile()) fail('目标不是普通文件');
  if (fs.existsSync(filename + '.st')) fail('下载断点状态仍存在，暂不能确认文件已完成');
  if (reference.expectedSize && before.size !== reference.expectedSize) {
    fail(`文件大小不符：应为 ${reference.expectedSize} 字节，实际 ${before.size} 字节`);
  }
  if (reference.gzip) {
    if (before.size < 18) fail('gzip 文件过短，缺少必要的头部或尾部');
    const handle = await fs.promises.open(filename, 'r');
    try {
      const header = Buffer.alloc(10), trailer = Buffer.alloc(8);
      const headRead = await handle.read(header, 0, 10, 0);
      const tailRead = await handle.read(trailer, 0, 8, before.size - 8);
      result.sampledBytes = headRead.bytesRead + tailRead.bytesRead;
      if (headRead.bytesRead !== 10 || tailRead.bytesRead !== 8) fail('读取 gzip 头尾不完整');
      if (header[0] !== 0x1f || header[1] !== 0x8b || header[2] !== 8 || (header[3] & 0xe0)) fail('文件头不是有效的 gzip 格式，可能下载到了错误页面或其他内容');
      result.gzipHeader = true;
      // These fields describe only the last gzip member. Merely reading them does
      // NOT validate CRC, decompression, or the middle of a multi-member file.
      result.gzipTrailer = { crc32: trailer.readUInt32LE(0).toString(16).padStart(8, '0'), isizeModulo32: trailer.readUInt32LE(4) };
    } finally { await handle.close(); }
    await checkControl();
    const after = await fs.promises.stat(filename);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('检查期间文件被修改，请重新检查');
  }
  if (deep && reference.expectedMd5) {
    const hash = crypto.createHash('md5');
    let bytes = 0;
    onProgress(0, before.size);
    await checkControl();
    const stream = fs.createReadStream(filename, { highWaterMark: 1024 * 1024 });
    try {
      for await (const chunk of stream) {
        await checkControl();
        hash.update(chunk);
        bytes += chunk.length;
        onProgress(bytes, before.size);
      }
    } finally { stream.destroy(); }
    await checkControl();
    const after = await fs.promises.stat(filename);
    await checkControl();
    result.actualMd5 = hash.digest('hex');
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) fail('校验期间文件被修改，请重新校验');
    result.status = result.actualMd5 === reference.expectedMd5 ? 'verified' : 'mismatch';
    if (result.status === 'mismatch') result.reason = 'MD5 与参考值不一致；文件和参考信息都可能有问题，请人工核对。原文件已保留';
  } else {
    result.status = deep && reference.required ? 'unavailable' : (reference.expectedSize ? 'quick-checked' : 'unchecked');
  }
  return result;
}

module.exports = { validMd5, knownSize, enaIdentity, parseEnaReport, createEnaResolver, verifyFile };
