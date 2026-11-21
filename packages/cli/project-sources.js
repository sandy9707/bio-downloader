'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { gunzipSync, constants } = require('node:zlib');
const axios = require('axios');
const { load } = require('cheerio');
const { isDomestic, projectParentChoices } = require('../../shared/project-source-policy');
const { columnFor } = require('../../shared/project-view-model');
const { sraContainers } = require('../../src/main/project-lookup-sra');

const PAGE_SIZE = 10;
const SAMPLE_BYTES = 65536;
const CNCB = 'https://ngdc.cncb.ac.cn';
const plainUrl = u => !u.username && !u.password && !u.port && !u.hash && !u.search;

function matchesFile(file, url) {
  const name = url.pathname.split('/').pop();
  if (!plainUrl(url) || !['https:', 'ftp:'].includes(url.protocol)) return false;
  if (file.format === 'fastq') return name === file.name && /\.(?:fastq|fq)\.gz$/i.test(name);
  // The object in NCBI SDL may be extensionless. Its accession and type are explicit.
  return file.format === 'sra' && file.name === `${file.run}.sra` && (name === file.name || name === file.run);
}

async function ftpSample(url) {
  const args = ['-q', '--globoff', '--proto', '=ftp', '--noproxy', '*', '--silent', '--show-error', '--fail', '--max-time', '6'];
  const options = { timeout: 7000, windowsHide: true, maxBuffer: SAMPLE_BYTES + 4096 };
  const head = await execFile('curl', [...args, '--head', '--', url], options);
  const size = Number(/^Content-Length:\s*(\d+)/im.exec(head.stdout)?.[1]);
  if (!Number.isSafeInteger(size) || size <= 0) throw Error('FTP 未能确认文件总长度');
  const end = Math.min(size, SAMPLE_BYTES) - 1;
  const { stdout } = await execFile('curl', [...args, '--range', `0-${end}`, '--', url], { ...options, encoding: 'buffer' });
  return { size, bytes: stdout };
}

async function httpSample(url, get, knownSize) {
  const end = Math.min(knownSize || SAMPLE_BYTES, SAMPLE_BYTES) - 1;
  const res = await get(url, { timeout: 6000, proxy: false, maxRedirects: 0, decompress: false,
    responseType: 'arraybuffer', maxContentLength: SAMPLE_BYTES, validateStatus: () => true,
    headers: { Range: `bytes=0-${end}`, 'Accept-Encoding': 'identity' } });
  const h = res.headers || {};
  if (res.status !== 206 && res.status !== 200) throw Error(`HTTP ${res.status}`);
  if (/text\/html|(?:application|text)\/(?:[^;]+\+)?(?:xml|json)/i.test(h['content-type'] || '') ||
      (h['content-encoding'] && h['content-encoding'].toLowerCase() !== 'identity')) throw Error('响应为网页、错误文档或经过内容转码');
  const bytes = Buffer.from(res.data);
  if (res.status === 200) {
    if (h['content-range'] || Number(h['content-length']) !== bytes.length || bytes.length > SAMPLE_BYTES) throw Error('未确认完整的小文件响应或有效分段');
    return { size: bytes.length, bytes };
  }
  const range = /^bytes 0-(\d+)\/(\d+)$/.exec(h['content-range']);
  const size = Number(range?.[2]);
  if (!range || Number(range[1]) !== Math.min(end, size - 1) || bytes.length !== Number(range[1]) + 1 ||
      (h['content-length'] != null && Number(h['content-length']) !== bytes.length)) throw Error('分段或文件总长度不符');
  return { size, bytes };
}

function validateSample(file, { size, bytes }) {
  if (!Number.isSafeInteger(size) || size <= 0 || (file.size > 0 && size !== Number(file.size)) ||
      !Buffer.isBuffer(bytes) || bytes.length !== Math.min(SAMPLE_BYTES, size)) throw Error('文件长度未确认或与清单不符');
  if (file.format === 'sra') {
    if (bytes.toString('ascii', 0, 8) !== 'NCBI.sra') throw Error('未读到 SRA 容器文件头');
  } else if (file.format === 'fastq') {
    let prefix;
    try {
      prefix = gunzipSync(bytes, { maxOutputLength: 8 * 1024 * 1024,
        ...(bytes.length < size ? { finishFlush: constants.Z_SYNC_FLUSH } : {}) }).toString('latin1');
    } catch { throw Error('未读到有效的 gzip 文件头'); }
    const [id, sequence, plus, quality] = prefix.split(/\r?\n/, 4);
    if (!/^@\S/.test(id) || !sequence || !plus?.startsWith('+') || quality?.length !== sequence.length) throw Error('文件头未确认完整 FASTQ 记录');
  } else throw Error('未支持该文件格式');
  if (bytes.length === size && file.md5 && createHash('md5').update(bytes).digest('hex') !== file.md5.toLowerCase()) throw Error('文件 MD5 与官方清单不符');
}

async function measure(file, url, get, ftp) {
  const source = { url, name: file.name, run: file.run, format: file.format, available: false, latencyMs: null };
  try {
    const address = new URL(url);
    if (!matchesFile(file, address)) throw Error('地址与官方文件名或格式不符');
    const start = performance.now();
    const sample = address.protocol === 'ftp:' ? await ftp(url) : await httpSample(url, get, file.size);
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    validateSample(file, sample);
    return { source: { ...source, available: true, size: sample.size, latencyMs }, bytes: sample.bytes };
  } catch (error) {
    return { source: { ...source, reason: error.message } };
  }
}

// As in Lite's native CNCB discovery, follow only links published by the
// official search and its unique INSDC Run detail. Never construct file URLs.
function cncbDiscovery(get) {
  let lane = Promise.resolve(), retryAt = 0;
  async function links(url, referer) {
    const res = await get(url, { proxy: false, maxRedirects: 0, timeout: 3500, maxContentLength: 2 * 1024 * 1024,
      responseType: 'text', headers: { Accept: 'text/html', ...(referer ? { Referer: referer } : {}) } });
    if (res.status !== 200 || typeof res.data !== 'string') throw Error('未取得官方记录');
    if (/SecurityCheck|Verifying your browser|<title>[^<]*(?:captcha|安全验证)/i.test(res.data)) throw Error('官方页面要求浏览器验证');
    const $ = load(res.data), base = new URL($('base[href]').first().attr('href') || url, url);
    const urls = new Set();
    $('a[href]').each((_, a) => {
      try { const link = new URL($(a).attr('href'), base); if (plainUrl(link)) urls.add(link.href); } catch { /* unrelated link */ }
    });
    return [...urls].map(href => new URL(href));
  }
  async function discover(run) {
    if (Date.now() < retryAt) return { note: '国内镜像查询暂缓，请稍后重测' };
    const search = `${CNCB}/gsa/search?searchTerm=${run}`;
    try {
      const path = new RegExp(`^/gsa/browse/insdc/[SED]RA\\d+/${run}/?$`);
      const refs = (await links(search)).filter(u => u.origin === CNCB && path.test(u.pathname));
      if (refs.length !== 1) return { note: '国内官方搜索未确认唯一对应的 Run 详情' };
      const urls = (await links(refs[0].href, search)).filter(u => u.protocol === 'https:' &&
        ['download.cncb.ac.cn', 'download2.cncb.ac.cn'].includes(u.host) && u.pathname.split('/').includes(run));
      return { urls, detail: refs[0].href };
    } catch (error) {
      // Keep the public metadata lane bounded and respect upstream backoff.
      const status = error.response?.status;
      if ([429, 503].includes(status)) {
        const after = error.response?.headers?.['retry-after'];
        const until = /^\d+$/.test(after) ? Date.now() + Number(after) * 1000 : Date.parse(after);
        retryAt = Number.isFinite(until) ? Math.max(Date.now() + 1000, until) : Date.now() + 60000;
      } else if (!status) retryAt = Date.now() + 15000;
      return { note: `国内镜像记录暂未核实（${status ? 'HTTP ' + status : error.message}）` };
    }
  }
  return run => {
    const pending = lane.then(() => discover(run));
    lane = pending.catch(() => {});
    return pending;
  };
}

async function inspectFile(file, get, ftp, discovery, serial = false) {
  const urls = [...new Set([file.url, ...(file.alternatives || [])].filter(Boolean))];
  const original = [];
  if (serial) { for (const url of urls) original.push(await measure(file, url, get, ftp)); }
  else original.push(...await Promise.all(urls.map(url => measure(file, url, get, ftp))));
  const record = await discovery;
  const sources = original.map(result => result.source);
  const reference = original.find(result => result.source.available);
  if (reference && original.some(result => result.source.available &&
      (reference.source.size !== result.source.size || !reference.bytes.equals(result.bytes)))) {
    for (const { source } of original) {
      if (source.available) Object.assign(source, { available: false, reason: '官方来源之间的文件长度或已读内容不一致' });
    }
  }
  let note = record?.note || '';
  if (record?.urls) {
    const mirrors = record.urls.filter(u => {
      if (!matchesFile(file, u) || urls.includes(u.href)) return false;
      const segments = u.pathname.split('/');
      if (file.format === 'fastq') return !segments.some(p => /^sra$/i.test(p));
      return u.host === 'download2.cncb.ac.cn' && new RegExp(`^/INSDC\\d*/SRA/[^/]+/[^/]+/${file.run}//?${file.run}(?:\\.sra)?$`).test(u.pathname);
    });
    if (!file.size) note = '官方清单缺少精确长度，不能确认跨库同文件镜像';
    else if (mirrors.length !== 1) note = mirrors.length ? '国内详情有多个同名位置，未确认唯一同文件镜像' : '国内详情未列出此格式的同文件链接';
    else {
      const measured = await measure(file, mirrors[0].href, get, ftp);
      const s = measured.source;
      if (s.available) {
        // A published mirror link, matching known length, format and either an
        // entire small file's official MD5 or the exact original binary prefix.
        const matched = (measured.bytes.length === file.size && !!file.md5) ||
          original.some(result => result.source.available && result.bytes.equals(measured.bytes));
        if (!matched) Object.assign(s, { available: false, reason: '未与原文件核实相同的文件头或官方摘要' });
        else s.officialUrl = record.detail;
      }
      sources.push(s);
    }
  }
  return { sources, note };
}

function createProjectService(lookup, { get = (url, options) => axios.get(url, options), ftp = ftpSample } = {}) {
  const projects = new Map();
  async function query(project) {
    const result = await lookup(project);
    const files = result.access === 'public' ? (result.files || []).map(file => ({ ...file })) : [];
    // A container is a distinct format, never an alternative URL for a FASTQ.
    // Defer SDL discovery until after the UI has displayed the Run manifest.
    if (result.access === 'public' && !projectParentChoices(result).length) {
      for (const run of result.runs.filter(id => /^[SED]RR\d+$/.test(id))) {
        if (!files.some(f => f.run === run && f.format === 'sra')) files.push({ run, name: `${run}.sra`, format: 'sra', size: 0, url: '', pendingMetadata: true });
      }
    }
    // Published addresses are candidates, not verified download sources. Do not
    // perform HEAD, Range or FTP here: render first, probe only selected indices.
    for (const file of files) {
      file.candidateSources = [...new Set([file.url, ...(file.alternatives || [])])].filter(url => {
        try { return matchesFile(file, new URL(url)); } catch { return false; }
      }).map(url => ({ url, name: file.name, run: file.run, format: file.format,
        size: file.size || 0, md5: file.md5 || '', available: false, pending: true, latencyMs: null }));
    }
    const queryId = randomUUID();
    if (files.length && !projectParentChoices(result).length) {
      projects.set(queryId, { files: result.files || [], matrixFiles: files, human: /^HRA|^HRR/.test(result.accession || '') || files.some(file => /^HRR/.test(file.run || '')), terminal: null, controller: new AbortController() });
      if (projects.size > 16) {
        const oldest = projects.keys().next().value;
        projects.get(oldest).controller.abort();
        projects.delete(oldest);
      }
    }
    return { ...result, files: result.access === 'public' ? result.files || [] : [], matrixFiles: files, count: result.runs.length, project: result.accession, queryId, pageSize: PAGE_SIZE };
  }
  async function probe({ queryId, page = 0 }) {
    const entry = projects.get(queryId);
    if (!entry) throw Error('请先选择明确的查询范围或重新查询项目');
    const options = typeof page === 'object' && page ? page : null;
    if (options?.cancel) { entry.controller.abort(); return []; }
    if (!entry.terminal && entry.controller.signal.aborted) entry.controller = new AbortController();
    const signal = entry.controller.signal;
    const stop = reason => {
      if (!entry.terminal) entry.terminal = { code: 'HRA_SOURCE_DENIED', reason };
      entry.controller.abort();
      throw Error(entry.terminal.reason);
    };
    const inspectResponse = response => {
      if (!entry.human || !response) return;
      if ([401, 403, 429].includes(Number(response.status))) stop(`来源返回 HTTP ${response.status}`);
      const body = Buffer.isBuffer(response.data) ? response.data.subarray(0, 65536).toString('utf8') : typeof response.data === 'string' ? response.data.slice(0, 65536) : '';
      if (response.headers?.['cf-mitigated'] === 'challenge' || /SecurityCheck|Verifying your browser|<title>[^<]*(?:captcha|安全验证)/i.test(body)) stop('来源要求验证码或浏览器验证');
    };
    const scopedGet = async (url, config) => {
      signal.throwIfAborted();
      try { const response = await get(url, { ...config, signal }); inspectResponse(response); return response; }
      catch (error) { inspectResponse(error.response); throw error; }
    };
    const scopedFtp = async url => {
      signal.throwIfAborted();
      try { return await ftp(url); }
      catch (error) {
        if (entry.human && (Number(error.ftpCode) === 530 || Number(error.code) === 67 || /(?:FTP[^\n]*|response[^\n]*|reply[^\n]*)\b530\b|\b530\s+(?:Login|Not logged)/i.test(error.message + ' ' + (error.stderr || '')))) stop('FTP 来源拒绝登录（530）');
        throw error;
      }
    };
    const scopedDiscover = cncbDiscovery(scopedGet);
    const files = options ? entry.matrixFiles : entry.files;
    if (!options && (!Number.isSafeInteger(page) || page < 0 || page * PAGE_SIZE >= files.length)) throw Error('无效页码');
    const indices = options ? options.indices : files.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((_, i) => page * PAGE_SIZE + i);
    if (!Array.isArray(indices) || !indices.length || indices.length > 100 || new Set(indices).size !== indices.length || indices.some(i => !Number.isSafeInteger(i) || !files[i])) throw Error('无效文件范围');
    const column = options?.column || '';
    if (!['', 'cncb', 'aws', 'ena', 'https', 'ftp'].includes(column)) throw Error('无效来源列');
    const terminalRows = () => indices.map(index => ({ index, file: files[index], sources: [], note: entry.terminal.reason, terminal: entry.terminal, column }));
    if (entry.terminal) return terminalRows();
    const rows = new Array(indices.length), discoveries = new Map();
    let next = 0;
    try { await Promise.all(Array.from({ length: entry.human ? 1 : Math.min(3, rows.length) }, async () => {
      while (next < rows.length) {
        signal.throwIfAborted();
        const i = next++, index = indices[i]; let file = files[index];
        let metadataNote = '';
        if (file.pendingMetadata && ['', 'aws', 'cncb'].includes(column)) {
          const found = await sraContainers([file.run], async url => (await scopedGet(url, { timeout: 6000, proxy: false, maxContentLength: 2 * 1024 * 1024 })).data, signal);
          if (found.files.length === 1) files[index] = file = found.files[0];
          else metadataNote = found.unavailable ? 'SRA 官方元数据查询失败，可重试' : '官方记录未列出公开 SRA 容器';
        }
        if ((!column || column === 'cncb') && /^[SED]RR\d+$/.test(file.run) && !isDomestic(file.url) && !discoveries.has(file.run)) discoveries.set(file.run, scopedDiscover(file.run));
        const belongs = url => !column || (['https','ftp'].includes(column) ? url.startsWith(column + ':') : columnFor(url) === column);
        // CNCB mirrors still need their official original as an identity witness.
        const target = column && column !== 'cncb' ? { ...file, url: belongs(file.url || '') ? file.url : '', alternatives: (file.alternatives || []).filter(belongs) } : file;
        const inspected = await inspectFile(target, scopedGet, scopedFtp, discoveries.get(file.run), entry.human);
        signal.throwIfAborted();
        rows[i] = { index, file, sources: inspected.sources.filter(s => belongs(s.url)), note: metadataNote || inspected.note, column };
      }
    })); } catch (error) { if (!entry.terminal) throw error; }
    return entry.terminal ? terminalRows() : rows;
  }
  return { query, probe };
}
module.exports = { createProjectService };
