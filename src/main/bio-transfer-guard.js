// The selected engine schedules and writes data using its native checkpoint.
// This gateway validates upstream byte ranges before the engine consumes them.
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const path = require('path');
const axios = require('axios');
const { errorDetails } = require('./download-diagnostics');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const positive = n => Number.isSafeInteger(n) && n > 0;
const SAMPLE_BYTES = 4096, SAMPLE_COUNT = 32;
const activeFiles = new Set();

function bioSource(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:', 'ftp:'].includes(u.protocol) || u.username || u.password || u.port || u.search) return null;
    const host = u.hostname;
    const ebi = host === 'ftp.sra.ebi.ac.uk' && /^\/vol1\/(fastq|srr|err|drr)\//.test(u.pathname);
    const ncbi = ['ftp.ncbi.nlm.nih.gov', 'sra-download.ncbi.nlm.nih.gov', 'sra-pub-run-odp.s3.amazonaws.com'].includes(host);
    if (!ebi && (!ncbi || u.protocol === 'ftp:')) return null;
    // ENA documents this exact public archive over HTTP. Forcing TLS can fail
    // on ftp.sra.ebi.ac.uk before Axel can start. This is a
    // host/path allowlist, not a generic HTTPS-to-HTTP error fallback.
    // https://www.ebi.ac.uk/ena/browser/downloading-data
    u.protocol = ebi ? 'http:' : 'https:';
    return u.href;
  } catch (_) { return null; }
}

function sampleWindows(size) {
  if (size <= SAMPLE_BYTES * SAMPLE_COUNT) return [{ offset: 0, length: size }];
  const length = Math.min(SAMPLE_BYTES, size), offsets = new Set();
  for (let i = 0; i < SAMPLE_COUNT; i++) offsets.add(Math.floor((size - length) * i / (SAMPLE_COUNT - 1)));
  return [...offsets].map(offset => ({ offset, length }));
}

function parseAxelState(bytes, size) {
  if (bytes.length < 26) throw new Error('Axel 断点记录不完整');
  // Current Axel stores uint16_t connections; older builds used an int.
  const shortCount = bytes.readUInt16LE(0);
  const width = bytes.length === 10 + shortCount * 16 ? 2 : 4;
  const count = width === 2 ? shortCount : bytes.readInt32LE(0);
  if (count < 1 || count > 1024 || bytes.length !== width + 8 + count * 16) throw new Error('Axel 断点记录格式无效');
  const read = offset => {
    const n = bytes.readBigInt64LE(offset);
    if (n < 0n || n > BigInt(size)) throw new Error('Axel 断点位置越界');
    return Number(n);
  };
  const done = read(width), missing = [];
  for (let i = 0; i < count; i++) {
    const start = read(width + 8 + i * 16), end = read(width + 16 + i * 16);
    if (start > end) throw new Error('Axel 断点范围倒置');
    if (start < end) missing.push({ start, end });
  }
  missing.sort((a, b) => a.start - b.start);
  if (missing.some((r, i) => i && r.start < missing[i - 1].end) || done + missing.reduce((n, r) => n + r.end - r.start, 0) !== size) throw new Error('Axel 断点计数与范围不一致');
  return { done, missing };
}

// aria2 1.x control file: network-endian header, complete-piece bitfield,
// then in-flight piece bitfields. Only fully complete pieces are trusted here.
function parseAriaState(bytes, size) {
  let offset = 0;
  const take = n => { if (n < 0 || offset + n > bytes.length) throw new Error('aria2 断点记录不完整'); const start = offset; offset += n; return start; };
  const u32 = () => bytes.readUInt32BE(take(4));
  if (bytes.readUInt16BE(take(2)) !== 1 || u32() !== 0 || u32() !== 0) throw new Error('不支持的 aria2 断点记录');
  const piece = u32(), total = bytes.readBigUInt64BE(take(8)); take(8);
  if (!piece || total !== BigInt(size)) throw new Error('aria2 断点文件大小不符');
  const count = Math.ceil(size / piece), length = u32();
  if (length !== Math.ceil(count / 8)) throw new Error('aria2 断点位图无效');
  const bitfield = bytes.subarray(take(length), offset), missing = [];
  let done = 0;
  for (let i = 0; i < count; i++) {
    const start = i * piece, end = Math.min(size, start + piece);
    if (bitfield[i >> 3] & (0x80 >> (i & 7))) done += end - start;
    else if (missing.length && missing[missing.length - 1].end === start) missing[missing.length - 1].end = end;
    else missing.push({ start, end });
  }
  const inflight = u32(), seen = new Set();
  if (inflight > count) throw new Error('aria2 断点分片数量无效');
  for (let i = 0; i < inflight; i++) {
    const index = u32(), n = u32(), bits = u32();
    if (index >= count || seen.has(index) || n !== Math.min(piece, size - index * piece) || bits !== Math.ceil(Math.ceil(n / 16384) / 8)) throw new Error('aria2 断点分片无效');
    seen.add(index); take(bits);
  }
  if (offset !== bytes.length) throw new Error('aria2 断点记录存在未知数据');
  return { done, missing };
}

async function atomicWrite(filename, data) {
  const temporary = `${filename}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  let handle;
  try {
    handle = await fs.promises.open(temporary, 'wx', 0o600);
    await handle.writeFile(data); await handle.sync(); await handle.close(); handle = null;
    await fs.promises.rename(temporary, filename);
  } finally {
    if (handle) await handle.close();
    await fs.promises.unlink(temporary).catch(() => {});
  }
}

function validateResponse(response, start, end, size, identity) {
  const h = response.headers;
  if (response.status >= 500 || response.status === 429) {
    const error = new Error(`源站暂时无法提供分段（HTTP ${response.status}）`); error.retryable = true; throw error;
  }
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(h['content-range'] || ''));
  if (response.status !== 206 || !m || +m[1] !== start || +m[2] !== end || !positive(+m[3]) || (size && +m[3] !== size)) throw new Error(`服务器返回了错误的下载分段（请求 ${start}-${end}/${size || '?'}，HTTP ${response.status}，Content-Range ${String(h['content-range'] || '缺失').slice(0, 100)}）`);
  if (h['content-length'] !== undefined && Number(h['content-length']) !== end - start + 1) throw new Error('服务器分段长度不一致');
  if (h['content-encoding'] && h['content-encoding'] !== 'identity') throw new Error('服务器改变了下载内容编码，不能安全续传');
  if (identity) {
    if (identity.etag && h.etag !== identity.etag) throw new Error('源文件 ETag 已变化，已停止混合不同版本的文件');
    if (identity.modified && h['last-modified'] !== identity.modified) throw new Error('源文件修改时间已变化，不能继续拼接');
  }
  return +m[3];
}

async function createBioTransferGuard({ url, filename, expectedSize, proxy = false, onFatal = () => {}, onDiagnostic = () => {}, isPaused = () => false, checkControl = async () => {}, timeout = 20000, onBytes = () => {}, engine = 'axel' }) {
  let lockKey = path.resolve(filename);
  if (process.platform === 'win32') lockKey = lockKey.toLowerCase();
  if (activeFiles.has(lockKey)) throw new Error('同一目标文件已有下载任务，请等待或暂停原任务');
  activeFiles.add(lockKey);
  const sidecar = filename + '.biodl.json', statePath = filename + (engine === 'aria2' ? '.aria2' : '.st');
  const parseState = engine === 'aria2' ? parseAriaState : parseAxelState;
  const sourceKey = sha(url), controllers = new Set(), sockets = new Set();
  let closed = false, fatal = null, server = null, checkpointTimer = null, checkpointBusy = false;
  let saveChain = Promise.resolve(), sampledBytes = 0, networkSampleBytes = 0;
  let interruptedResponses = 0;
  const segmentFailures = new Map();
  const retryable = error => error.retryable || ['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'EPROTO', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code);
  let state = { version: 1, engine, sourceKey, completed: false, samples: {} };
  let size, identity, windows, checkpointStamp = null;
  const receipts = new Map();
  const fail = message => new Error(`${message}；原文件和断点已保留`);
  const diagnostic = (type, details) => {
    try { onDiagnostic({ time: new Date().toISOString(), source: 'bio-guard', engine, type, ...details }); } catch (_) { /* Logging must never change transfer outcomes. */ }
  };
  const save = () => {
    const snapshot = JSON.stringify(state);
    saveChain = saveChain.then(() => atomicWrite(sidecar, snapshot));
    return saveChain;
  };
  const reportFatal = error => {
    if (closed || fatal) return;
    fatal = fail(error.message);
    fatal.code = error.code || 'BIO_GUARD_STOPPED';
    fatal.cause = error;
    diagnostic('fatal', { error: errorDetails(error), preserved: true, outerRetry: false });
    for (const controller of controllers) controller.abort();
    onFatal(fatal);
  };
  async function requestOnce(start, end, stream = false, signal) {
    if (closed) throw new Error('Cancelled');
    const headers = { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity' };
    if (identity?.etag && !identity.etag.startsWith('W/')) headers['If-Range'] = identity.etag;
    else if (identity?.modified) headers['If-Range'] = identity.modified;
    // Explicit proxy avoids environment-based routing and accidental direct fallback.
    const response = await axios({ url, method: 'GET', headers, proxy, signal, timeout, responseType: stream ? 'stream' : 'arraybuffer', decompress: false, maxRedirects: 5, maxContentLength: stream ? Infinity : end - start + 1, validateStatus: () => true,
      beforeRedirect: options => { if (new URL(url).protocol === 'https:' && options.protocol !== 'https:') throw new Error('拒绝从 HTTPS 降级下载'); }
    });
    try {
      const total = validateResponse(response, start, end, size, identity);
      if (!stream && response.data.length !== end - start + 1) throw new Error('服务器提前结束分段响应');
      return { response, total };
    } catch (error) { error.status = response.status; if (stream) response.data.destroy(); throw error; }
  }
  async function request(start, end, stream = false, signal) {
    for (let attempt = 0; ; attempt++) {
      await checkControl();
      if (closed || signal?.aborted) throw new Error('Cancelled');
      try { return await requestOnce(start, end, stream, signal); }
      catch (error) {
        error.range = { start, end };
        diagnostic('request-error', { stage: stream ? 'response-headers' : 'probe-or-sample', range: { start, end }, attempt: attempt + 1, maxAttempts: 3, retryable: Boolean(retryable(error)), error: errorDetails(error) });
        if (attempt >= 2 || !retryable(error) || closed || signal?.aborted) throw error;
        interruptedResponses++;
        await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 250));
      }
    }
  }
  async function sampleRemote(window) {
    const { response } = await request(window.offset, window.offset + window.length - 1);
    networkSampleBytes += response.data.length;
    return sha(response.data);
  }
  async function checkWindows(selected, fresh) {
    const handle = await fs.promises.open(filename, 'r');
    try {
      // Four independent tiny requests at a time; bounded memory and request count.
      for (let i = 0; i < selected.length; i += 4) {
        await checkControl();
        await Promise.all(selected.slice(i, i + 4).map(async window => {
          const reference = !fresh && receipts.get(window.offset) || await sampleRemote(window);
          const bytes = Buffer.alloc(window.length);
          const read = await handle.read(bytes, 0, bytes.length, window.offset);
          sampledBytes += read.bytesRead;
          if (read.bytesRead !== bytes.length || sha(bytes) !== reference) throw fail(`文件抽样与源文件不一致（偏移 ${window.offset}）`);
          state.samples[window.offset] = { length: window.length, sha256: reference };
        }));
      }
    } finally { await handle.close(); }
  }
  async function checkpoint() {
    if (closed || checkpointBusy || state.completed) return;
    checkpointBusy = true;
    try {
      const stat = await fs.promises.stat(statePath);
      if (stat.mtimeMs === checkpointStamp) return;
      const bytes = await fs.promises.readFile(statePath);
      parseState(bytes, size);
      // Persist the data covered by this snapshot before publishing its backup.
      const data = await fs.promises.open(filename, 'r+');
      try { await data.sync(); } finally { await data.close(); }
      state.resume = { data: bytes.toString('base64'), sha256: sha(bytes) };
      await save(); checkpointStamp = stat.mtimeMs;
    } catch (_) { /* Axel may be halfway through rewriting .st; keep last valid snapshot. */ }
    finally { checkpointBusy = false; }
  }
  async function close() {
    if (closed) return;
    clearInterval(checkpointTimer);
    while (checkpointBusy) await new Promise(resolve => setTimeout(resolve, 10));
    await checkpoint();
    closed = true;
    for (const controller of controllers) controller.abort();
    for (const socket of sockets) socket.destroy();
    if (server) await new Promise(resolve => server.close(resolve));
    try { await saveChain; } finally { activeFiles.delete(lockKey); }
  }
  try {
    await checkControl();
    const exists = fs.existsSync(filename);
    if (exists && fs.existsSync(sidecar)) {
      if ((await fs.promises.stat(sidecar)).size > 1024 * 1024) throw fail('下载记录过大或已损坏');
      state = JSON.parse(await fs.promises.readFile(sidecar, 'utf8'));
      // 2.0.44 forced the same ENA archive path to HTTPS.
      // Still validate size, generation and completed-range samples below.
      const oldEnaKey = url.startsWith('http://ftp.sra.ebi.ac.uk/') && sha(url.replace(/^http:/, 'https:'));
      if (state.version !== 1 || (state.sourceKey !== sourceKey && state.sourceKey !== oldEnaKey)) throw fail('同名文件属于不同的下载链接，不能跳过或混合续传');
      if (!state.completed && (state.engine || 'axel') !== engine) throw fail('原任务属于另一下载器，请使用原下载器继续断点');
      state.engine = engine;
      state.sourceKey = sourceKey;
      state.samples = {};
    }
    const probe = await request(0, 0);
    size = probe.total;
    if (expectedSize > 0 && size !== Number(expectedSize)) throw fail(`源文件大小与任务记录不符（${size}/${expectedSize}）`);
    identity = { etag: probe.response.headers.etag || null, modified: probe.response.headers['last-modified'] || null };
    if (exists && state.size && (state.size !== size || (state.identity?.etag && state.identity.etag !== identity.etag) || (state.identity?.modified && state.identity.modified !== identity.modified))) throw fail('源文件版本已变化，不能使用原文件续传或跳过');
    windows = sampleWindows(size);
    state.size = size; state.identity = identity;
    if (exists && (!state.completed || fs.existsSync(statePath))) {
      let resume;
      try { resume = parseState(await fs.promises.readFile(statePath), size); } catch (_) {
        if (state.resume) {
          const bytes = Buffer.from(state.resume.data, 'base64');
          if (sha(bytes) !== state.resume.sha256) throw fail('断点备份校验失败');
          resume = parseState(bytes, size);
          await atomicWrite(statePath, bytes);
        } else if (fs.existsSync(statePath)) throw fail('断点记录已损坏且无有效备份');
      }
      if (resume) {
        const candidates = [...windows];
        for (const range of resume.missing.slice(0, SAMPLE_COUNT)) if (range.start >= SAMPLE_BYTES) candidates.push({ offset: range.start - SAMPLE_BYTES, length: SAMPLE_BYTES });
        const completedSamples = candidates.filter(w => !resume.missing.some(r => w.offset < r.end && w.offset + w.length > r.start));
        await checkWindows(completedSamples, true);
      }
    }
    await save();
    const route = '/' + crypto.randomBytes(24).toString('hex') + '/data';
    server = http.createServer(async (req, res) => {
      if (req.url !== route || !['GET', 'HEAD'].includes(req.method) || fatal || closed) { res.writeHead(404); res.end(); return; }
      if (req.method === 'HEAD') { res.writeHead(200, { 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' }); res.end(); return; }
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      const start = match ? Number(match[1]) : 0, end = match && match[2] ? Number(match[2]) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end >= size) { res.writeHead(416); res.end(); return; }
      const controller = new AbortController(); controllers.add(controller);
      let clientGone = false;
      res.on('close', () => { clientGone = true; controller.abort(); });
      let offset = start;
      try {
        const { response } = await request(start, end, true, controller.signal);
        res.writeHead(match ? 206 : 200, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' });
        const collectors = windows.filter(w => w.offset >= start && w.offset + w.length <= end + 1).map(w => ({ ...w, bytes: Buffer.alloc(w.length), received: 0 }));
        for await (const bytes of response.data) {
          if (offset + bytes.length > end + 1) throw new Error('服务器返回了超出分段范围的数据');
          for (const sample of collectors) {
            if (sample.hashed) continue;
            const a = Math.max(offset, sample.offset), b = Math.min(offset + bytes.length, sample.offset + sample.length);
            if (b > a) { bytes.copy(sample.bytes, a - sample.offset, a - offset, b - offset); sample.received += b - a; }
            if (sample.received === sample.length) {
              const hash = sha(sample.bytes), previous = receipts.get(sample.offset);
              if (previous && previous !== hash) throw new Error('不同连接返回了不一致的文件内容');
              receipts.set(sample.offset, hash);
              sample.hashed = true;
            }
          }
          offset += bytes.length;
          onBytes(bytes.length);
          if (!res.write(bytes)) await new Promise((resolve, reject) => {
            const cleanup = () => { res.off('drain', drained); res.off('close', gone); };
            const drained = () => { cleanup(); resolve(); };
            const gone = () => { cleanup(); reject(new Error('client closed')); };
            res.once('drain', drained); res.once('close', gone);
          });
        }
        if (offset !== end + 1) { const error = new Error('服务器提前结束分段响应'); error.retryable = true; throw error; }
        segmentFailures.delete(end);
        res.end();
      } catch (error) {
        // Suspending Axel can exhaust socket idle timeouts. Close that connection;
        // Axel reconnects at its exact byte offset when the user resumes.
        if (!clientGone && !closed && !isPaused()) {
          // Let Axel reconnect at the bytes it actually wrote. Never fabricate
          // a completed response. Bound failures per segment: unrelated threads
          // must not spend each other's retry budget on a load-balanced proxy.
          interruptedResponses++;
          const failures = (segmentFailures.get(end) || 0) + 1;
          segmentFailures.set(end, failures);
          error.range = { start, end }; error.receivedBytes = offset - start;
          diagnostic('segment-error', { stage: 'transfer', range: { start, end }, receivedBytes: offset - start, failures, maxFailures: 3, retryable: Boolean(retryable(error)), error: errorDetails(error) });
          if (!retryable(error) || failures >= 3) reportFatal(error);
        }
        res.destroy();
      } finally { controllers.delete(controller); }
    });
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    checkpointTimer = setInterval(checkpoint, 2000); checkpointTimer.unref();
    return {
      url: `http://127.0.0.1:${server.address().port}${route}`,
      get error() { return fatal; }, size, checkpoint, close,
      async verify({ existing = false } = {}) {
        if (fatal) throw fatal;
        await checkControl();
        if (fs.existsSync(statePath)) throw fail('下载器断点状态仍存在');
        const before = await fs.promises.stat(filename);
        if (before.size !== size) throw fail('下载文件大小不符');
        await request(0, 0); // Check the source generation again after the transfer.
        await checkWindows(windows, existing);
        const after = await fs.promises.stat(filename);
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw fail('抽样检查期间文件发生变化');
        return { status: 'sampled', rangesChecked: !existing, recoveredResponses: interruptedResponses, sampleCount: windows.length, sampledBytes, networkSampleBytes, sourceValidator: identity.etag && !identity.etag.startsWith('W/') ? 'strong-etag' : identity.modified ? 'last-modified' : 'samples-only', fullContentVerified: false };
      },
      get previousVerification() { return state.verification; },
      async complete(verification) {
        state.completed = true; state.verification = verification; delete state.resume; await save();
      }
    };
  } catch (error) { diagnostic('prepare-failed', { stage: 'source-or-checkpoint', error: errorDetails(error), preserved: true }); await close().catch(() => {}); throw error; }
}

module.exports = { bioSource, createBioTransferGuard, parseAxelState, parseAriaState, sampleWindows, validateResponse };
