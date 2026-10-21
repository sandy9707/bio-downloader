'use strict';
// Independent candidate engine. Not wired into the production download selector.
const fs = require('fs/promises');
const path = require('path');
const http = require('http');
const https = require('https');
const axios = require('axios');
const lockfile = require('proper-lockfile');
const { Journal, TransferError, digest, writeAll, fingerprint, syncDirectory } = require('./journal');
const { setTimeout: delay } = require('timers/promises');
const transientCodes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE', 'ERR_STREAM_PREMATURE_CLOSE']);
const exists = async name => { try { await fs.lstat(name); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TransferError('INVALID_OPTION', `${name} 无效`);
  return value;
}

class NativeTransfer {
  constructor(options) {
    const u = new URL(options.url);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash) throw new TransferError('UNSUPPORTED_URL', '候选内核只支持无内嵌凭据的 HTTP/HTTPS 直链');
    // No implicit environment proxy and no direct fallback. The caller must
    // explicitly choose false or pass its existing Mihomo HTTP proxy object.
    if (options.proxy !== false && (!options.proxy || options.proxy.protocol !== 'http' || !options.proxy.host || !Number.isInteger(options.proxy.port))) throw new TransferError('PROXY_REQUIRED', '必须明确指定代理，或显式选择直连');
    this.options = { connections: 4, blockSize: 4 * 1024 * 1024, timeoutMs: 60000, retryBudgetMs: 15 * 60000,
      retryBaseMs: 1000, retryMaxMs: 30000, progressIntervalMs: 250, lockStaleMs: 15000, onEvent: () => {}, ...options };
    integer(this.options.connections, 1, 16, '连接数'); integer(this.options.blockSize, 65536, 16 * 1024 * 1024, '分块大小');
    for (const key of ['timeoutMs', 'retryBudgetMs', 'retryBaseMs', 'retryMaxMs', 'progressIntervalMs']) integer(this.options[key], 1, 86400000, key);
    integer(this.options.lockStaleMs, 2000, 60000, '锁超时');
    this.url = u.href; this.destination = path.resolve(options.filename);
    this.sourceKey = digest(this.url); this.completed = new Map(); this.active = new Map(); this.controllers = new Set();
    this.stop = new AbortController(); this.running = false; this.limit = this.options.connections;
    this.confirmedBytes = 0; this.networkBytes = 0; this.lastNetworkBytes = 0; this.lastTick = Date.now(); this.goodBlocks = 0;
    this.httpAgent = new http.Agent({ keepAlive: true, maxSockets: this.options.connections });
    this.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: this.options.connections });
  }
  event(type, details = {}) { try { this.options.onEvent({ type, time: new Date().toISOString(), ...details }); } catch (_) { /* UI observers cannot corrupt the transfer. */ } }
  pause() { this.stoppedByUser = true; this.stop.abort(); for (const c of this.controllers) c.abort(); }
  check() {
    if (this.fatal) throw this.fatal;
    if (this.stop.signal.aborted) throw new TransferError('PAUSED', '已暂停，断点保留');
  }
  progress(phase = 'downloading') {
    const now = Date.now(), elapsed = Math.max(1, now - this.lastTick);
    const speedBps = (this.networkBytes - this.lastNetworkBytes) * 1000 / elapsed;
    this.lastTick = now; this.lastNetworkBytes = this.networkBytes;
    const receivedBytes = this.confirmedBytes + [...this.active.values()].reduce((n, x) => n + x, 0);
    this.event('progress', { phase, receivedBytes, committedBytes: this.confirmedBytes, totalBytes: this.meta?.size || 0,
      percentage: this.meta ? Math.min(99.9, Math.floor(receivedBytes * 1000 / this.meta.size) / 10) : 0,
      speedBps, connections: this.limit, networkBytes: this.networkBytes });
  }
  async retry(operation, block = null) {
    const started = Date.now();
    for (let attempt = 0;; attempt++) {
      this.check();
      try { return await operation(); }
      catch (error) {
        this.check();
        if (!error.retryable && !transientCodes.has(error.code)) throw error;
        this.limit = Math.max(1, Math.floor(this.limit / 2)); this.goodBlocks = 0;
        const backoff = Math.min(this.options.retryMaxMs, this.options.retryBaseMs * 2 ** Math.min(attempt, 10));
        const waitMs = Math.max(Math.round(backoff * (0.8 + Math.random() * 0.4)), error.retryAfterMs || 0);
        if (Date.now() - started + waitMs > this.options.retryBudgetMs) throw new TransferError('NETWORK_WAIT', '连接持续不可用，已保留断点；网络恢复后可继续', { resumable: true });
        this.event('retry', { block, attempt: attempt + 1, code: error.code || 'HTTP_RETRY', waitMs, elapsedMs: Date.now() - started, connections: this.limit });
        try { await delay(waitMs, undefined, { signal: this.stop.signal }); } catch (_) { this.check(); }
      }
    }
  }
  async range(start, end, meta, onChunk = () => {}) {
    this.check();
    const controller = new AbortController(); this.controllers.add(controller);
    let response;
    try {
      response = await axios({ url: this.url, method: 'GET', responseType: 'stream', proxy: this.options.proxy,
        signal: controller.signal, timeout: this.options.timeoutMs, maxRedirects: 5, decompress: false,
        httpAgent: this.httpAgent, httpsAgent: this.httpsAgent, validateStatus: () => true,
        headers: { Range: `bytes=${start}-${end}`, 'Accept-Encoding': 'identity', ...(meta ? { 'If-Match': meta.etag } : {}) },
        beforeRedirect: opt => { if (this.url.startsWith('https:') && opt.protocol !== 'https:') throw new TransferError('TLS_DOWNGRADE', '拒绝 HTTPS 降级'); }
      });
      const h = response.headers;
      if (response.status === 429 || response.status >= 500) {
        const after = /^\d+$/.test(h['retry-after'] || '') ? Number(h['retry-after']) * 1000 : Date.parse(h['retry-after']) - Date.now();
        throw new TransferError('HTTP_' + response.status, '服务器暂时不可用', { retryable: true, retryAfterMs: Math.max(0, Number.isFinite(after) ? after : 0) });
      }
      if (response.status === 412) throw new TransferError('SOURCE_CHANGED', '源文件版本已变化，已停止拼接并保留原文件');
      if (response.status >= 400) throw new TransferError('HTTP_' + response.status, `源站拒绝下载（HTTP ${response.status}），原文件保留`);
      const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(h['content-range'] || ''));
      if (response.status !== 206 || !m || +m[1] !== start || +m[2] !== end || !Number.isSafeInteger(+m[3]) || +m[3] < end + 1 || (meta && +m[3] !== meta.size)) {
        throw new TransferError('RANGE_INVALID', '源站未返回请求的分段，已停止写入');
      }
      if (h['content-encoding'] && h['content-encoding'] !== 'identity') throw new TransferError('ENCODING_CHANGED', '服务器改变了内容编码，不能安全拼接');
      if (h['content-length'] !== undefined && Number(h['content-length']) !== end - start + 1) throw new TransferError('LENGTH_INVALID', '分段响应长度不一致');
      if (!/^"[^"\r\n]*"$/.test(h.etag || '')) throw new TransferError('VALIDATOR_REQUIRED', '源站缺少强 ETag，候选内核暂不对它进行多连接拼接');
      if (meta && h.etag !== meta.etag) throw new TransferError('SOURCE_CHANGED', '源文件 ETag 已变化，已保留原文件');
      const bytes = Buffer.allocUnsafe(end - start + 1); let offset = 0;
      for await (const chunk of response.data) {
        this.check();
        if (offset + chunk.length > bytes.length) throw new TransferError('BODY_OVERRUN', '分段响应超出请求范围');
        chunk.copy(bytes, offset); offset += chunk.length; this.networkBytes += chunk.length; onChunk(offset);
      }
      if (offset !== bytes.length) throw new TransferError('SHORT_BODY', '分段响应提前结束', { retryable: true });
      return { bytes, meta: { size: +m[3], etag: h.etag } };
    } finally { response?.data.destroy(); this.controllers.delete(controller); }
  }
  blockLength(index) { return Math.min(this.meta.blockSize, this.meta.size - index * this.meta.blockSize); }
  async restore() {
    const records = this.journal.records, header = records[0];
    if (!header || header.type !== 'header' || header.version !== 1 || header.sourceKey !== this.sourceKey) throw new TransferError('JOURNAL_SOURCE', '断点格式或原链接不匹配');
    if (header.size !== this.meta.size || header.etag !== this.meta.etag) throw new TransferError('SOURCE_CHANGED', '源文件版本已变化，不能继续原断点');
    integer(header.size, 1, Number.MAX_SAFE_INTEGER, '断点文件大小');
    integer(header.blockSize, 65536, 16 * 1024 * 1024, '断点分块大小'); this.meta.blockSize = header.blockSize;
    this.blockCount = Math.ceil(this.meta.size / this.meta.blockSize);
    if (this.blockCount > 1000000) throw new TransferError('TOO_MANY_BLOCKS', '分块数量超出候选内核限制');
    for (const r of records.slice(1)) {
      if (['piece', 'invalidate'].includes(r.type)) {
        integer(r.index, 0, this.blockCount - 1, '断点索引');
        if (r.type === 'invalidate') this.completed.delete(r.index);
        else {
          if (!/^[a-f0-9]{64}$/.test(r.hash)) throw new TransferError('JOURNAL_CORRUPT', '断点摘要损坏');
          this.completed.set(r.index, r.hash);
        }
      } else if (!['seal', 'complete'].includes(r.type)) throw new TransferError('JOURNAL_CORRUPT', '未知断点记录');
    }
    const stat = await this.data.stat();
    if (stat.size > this.meta.size) throw new TransferError('DATA_SIZE', '临时文件超出源文件大小，已保留现场');
    const last = records[records.length - 1];
    const clean = last?.type === 'seal' && same(last.file, fingerprint(stat));
    let verified = 0;
    if (!clean) {
      this.event('state', { phase: 'checking-local', blocks: this.completed.size });
      for (const [index, hash] of this.completed) {
        this.check();
        const bytes = Buffer.alloc(this.blockLength(index)); let offset = 0;
        while (offset < bytes.length) {
          const { bytesRead } = await this.data.read(bytes, offset, bytes.length - offset, index * this.meta.blockSize + offset);
          if (!bytesRead) break; offset += bytesRead;
        }
        if (offset !== bytes.length || digest(bytes) !== hash) {
          await this.journal.append({ type: 'invalidate', index }); this.completed.delete(index);
          this.event('repair', { block: index, reason: 'local-hash-mismatch' });
        } else verified += offset;
      }
    }
    this.confirmedBytes = [...this.completed.keys()].reduce((n, i) => n + this.blockLength(i), 0);
    this.event('resume', { committedBytes: this.confirmedBytes, fast: clean, verifiedBytes: verified });
  }
  async piece(index) {
    await this.retry(async () => {
      this.active.set(index, 0);
      try {
        const start = index * this.meta.blockSize;
        const { bytes } = await this.range(start, start + this.blockLength(index) - 1, this.meta, n => this.active.set(index, n));
        const hash = digest(bytes);
        // Ordering is essential: data durable -> journal durable -> progress committed.
        this.check(); await writeAll(this.data, bytes, start); await this.data.sync();
        await this.journal.append({ type: 'piece', index, hash });
        this.completed.set(index, hash); this.confirmedBytes += bytes.length;
        if (++this.goodBlocks >= 8 && this.limit < this.options.connections) { this.limit++; this.goodBlocks = 0; }
        this.event('piece', { index, committedBytes: this.confirmedBytes });
      } finally { this.active.delete(index); }
    }, index);
  }
  async seal() {
    if (this.safeToSeal && this.data && this.journal) { await this.data.sync(); await this.journal.append({ type: 'seal', file: fingerprint(await this.data.stat()) }); }
  }
  async run() {
    if (this.running) throw new TransferError('ALREADY_RUNNING', '同一任务不能重复启动');
    this.running = true;
    let release, timer, published = false;
    try {
      const parent = await fs.realpath(path.dirname(this.destination)); this.destination = path.join(parent, path.basename(this.destination));
      this.part = this.destination + '.biodl-part'; this.journalPath = this.destination + '.biodl-journal';
      release = await lockfile.lock(this.destination, { realpath: false, stale: this.options.lockStaleMs,
        update: Math.max(1000, Math.floor(this.options.lockStaleMs / 3)), retries: 0,
        onCompromised: () => { this.fatal = new TransferError('LOCK_LOST', '文件写入锁失效，已停止任务'); this.stop.abort(); for (const c of this.controllers) c.abort(); } });
      for (const name of [this.destination, this.part, this.journalPath]) {
        if (await exists(name)) { const s = await fs.lstat(name); if (!s.isFile() || s.isSymbolicLink()) throw new TransferError('UNSAFE_PATH', '目标必须是普通文件'); }
      }
      for (const suffix of ['.st', '.aria2', '.biodl.json']) if (await exists(this.destination + suffix)) throw new TransferError('OTHER_ENGINE', '已有其他引擎断点，不能混用');
      if (await exists(this.destination)) {
        // A crash after publishing must never cause an overwrite or new transfer.
        // Verify every journaled piece before acknowledging an existing output.
        if (!(await exists(this.journalPath))) throw new TransferError('OUTPUT_EXISTS', '目标文件已存在，已保留原件');
        this.journal = await Journal.open(this.journalPath); this.data = await fs.open(this.destination, 'r');
        const h = this.journal.records[0]; this.meta = { size: h?.size, etag: h?.etag, blockSize: h?.blockSize };
        const complete = this.journal.records.some(r => r.type === 'complete');
        if (!complete || this.journal.records[0]?.sourceKey !== this.sourceKey) throw new TransferError('OUTPUT_EXISTS', '现有文件不属于已完成的当前任务');
        // Remove seal shortcut for publication recovery: output may have been edited.
        this.journal.records.push({ type: 'complete' }); await this.restore();
        if (this.completed.size !== this.blockCount) throw new TransferError('OUTPUT_CHANGED', '已完成文件被修改，保留原件等待处理');
        this.event('complete', { size: this.meta.size, recovered: true }); return { status: 'completed', size: this.meta.size, recovered: true };
      }
      this.event('state', { phase: 'probing' });
      const probe = await this.retry(() => this.range(0, 0));
      this.meta = { ...probe.meta, blockSize: this.options.blockSize };
      if (this.options.expectedSize !== undefined && this.options.expectedSize !== this.meta.size) throw new TransferError('EXPECTED_SIZE', '源文件大小与任务参考值不一致');
      this.blockCount = Math.ceil(this.meta.size / this.meta.blockSize);
      if (this.blockCount > 1000000) throw new TransferError('TOO_MANY_BLOCKS', '分块数量超出候选内核限制');
      const hasPart = await exists(this.part), hasJournal = await exists(this.journalPath);
      if (hasPart !== hasJournal) throw new TransferError('INCOMPLETE_STATE', '数据与断点记录不配对，已保留现场');
      this.data = await fs.open(this.part, hasPart ? 'r+' : 'wx+');
      this.journal = await Journal.open(this.journalPath, !hasJournal);
      if (hasPart) await this.restore();
      else {
        await this.data.sync();
        await this.journal.append({ type: 'header', version: 1, sourceKey: this.sourceKey, ...this.meta });
        await syncDirectory(parent);
      }
      this.safeToSeal = true;
      timer = setInterval(() => this.progress(), this.options.progressIntervalMs);
      const pending = Array.from({ length: this.blockCount }, (_, i) => i).filter(i => !this.completed.has(i));
      // Bounded waves avoid a worker retaining an old, excessive concurrency
      // setting after a node fails. Other healthy blocks can still finish.
      for (let offset = 0; offset < pending.length;) {
        this.check(); const wave = pending.slice(offset, offset + this.limit); offset += wave.length;
        const results = await Promise.allSettled(wave.map(async index => {
          try { await this.piece(index); }
          catch (e) {
            if (!this.stoppedByUser && !this.fatal) this.fatal = e;
            this.stop.abort(); for (const c of this.controllers) c.abort(); throw e;
          }
        }));
        this.check(); const rejected = results.find(r => r.status === 'rejected'); if (rejected) throw rejected.reason;
      }
      this.check();
      if (this.completed.size !== this.blockCount || (await this.data.stat()).size !== this.meta.size) throw new TransferError('NOT_COMPLETE', '仍有未提交分块');
      // A final conditional probe catches changed generations; no whole-file MD5 pass.
      await this.retry(() => this.range(0, 0, this.meta));
      await this.data.sync(); await this.journal.append({ type: 'complete' });
      await this.data.close(); this.data = null;
      // Atomic no-clobber publication. On filesystems without hardlinks, fail
      // with the fully downloaded part retained instead of overwriting output.
      await fs.link(this.part, this.destination); published = true;
      await syncDirectory(parent); await fs.unlink(this.part); await syncDirectory(parent);
      this.event('complete', { size: this.meta.size, blocks: this.blockCount, percentage: 100, remoteChecksumVerified: false });
      return { status: 'completed', size: this.meta.size, blocks: this.blockCount, remoteChecksumVerified: false };
    } catch (error) {
      if (this.stoppedByUser && !this.fatal) {
        await this.seal(); this.event('state', { phase: 'paused', committedBytes: this.confirmedBytes });
        return { status: 'paused', committedBytes: this.confirmedBytes };
      }
      // Error paths deliberately do not create a clean seal. On restart all
      // committed blocks are checked, including after disk/lock failures.
      const e = this.fatal || error;
      this.event('failure', { code: e.code || 'UNKNOWN', phase: published ? 'published-cleanup' : 'transfer', preserved: true }); throw e;
    } finally {
      clearInterval(timer); for (const c of this.controllers) c.abort();
      const cleanup = await Promise.allSettled([this.data?.close(), this.journal?.close()]);
      try { if (release) await release(); } finally {
      this.httpAgent.destroy(); this.httpsAgent.destroy();
      }
      const failed = cleanup.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    }
  }
}
module.exports = { NativeTransfer, TransferError };
