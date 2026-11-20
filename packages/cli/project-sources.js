'use strict';
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');

const execFile = require('util').promisify(require('child_process').execFile);
const PAGE_SIZE = 10;

async function ftpSize(url) {
  const { stdout } = await execFile('curl', ['-q', '--globoff', '--proto', '=ftp', '--noproxy', '*',
    '--silent', '--fail', '--head', '--max-time', '6', '--', url],
    { timeout: 7000, windowsHide: true, maxBuffer: 16384 });
  return Number(/^Content-Length:\s*(\d+)/im.exec(stdout)?.[1]);
}

async function measure(file, url, head, ftp) {
  const candidate = { url, available: false, latencyMs: null };
  try {
    const address = new URL(url);
    if (!['https:', 'ftp:'].includes(address.protocol) || address.username || address.password) throw Error('不支持此地址');
    const start = performance.now();
    let size;
    if (address.protocol === 'ftp:') {
      try { size = await ftp(url); } catch { throw Error('FTP 未能确认文件大小'); }
    } else {
      const response = await head(url, { timeout: 6000, maxRedirects: 0, headers: { 'Accept-Encoding': 'identity' }, validateStatus: () => true });
      if (response.status !== 200) throw Error(`HTTP ${response.status}`);
      const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (!['application/octet-stream', 'binary/octet-stream', 'application/gzip', 'application/x-gzip', 'application/x-compressed', 'application/x-zip-compressed', 'application/zip', 'application/x-tar'].includes(type)) throw Error('未返回二进制文件');
      size = Number(response.headers['content-length']);
    }
    if (!Number.isSafeInteger(size) || !(size > 0) || (file.size > 0 && size !== Number(file.size))) throw Error('文件长度未确认或不符');
    const latencyMs = Math.max(1, Math.round(performance.now() - start));
    return { url, available: true, latencyMs, size };
  } catch (error) {
    return { ...candidate, reason: error.message };
  }
}

function createProjectService(lookup, head, ftp = ftpSize) {
  const projects = new Map();
  async function query(project) {
    const result = await lookup(project);
    const files = result.access === 'public' ? result.files || [] : [];
    const queryId = randomUUID();
    if (files.length) {
      projects.set(queryId, files);
      if (projects.size > 16) projects.delete(projects.keys().next().value);
    }
    return { ...result, files, count: result.runs.length, project: result.accession, queryId, pageSize: PAGE_SIZE };
  }
  async function probe({ queryId, page = 0 }) {
    const files = projects.get(queryId);
    if (!files) throw Error('查询结果已过期，请重新查询');
    if (!Number.isSafeInteger(page) || page < 0 || page * PAGE_SIZE >= files.length) throw Error('无效页码');
    const rows = files.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map((file, i) => ({ index: page * PAGE_SIZE + i, sources: [] }));
    const tasks = rows.flatMap(row => {
      const file = files[row.index];
      return [...new Set([file.url, ...(file.alternatives || [])].filter(Boolean))].map((url, i) => async () => { row.sources[i] = await measure(file, url, head, ftp); });
    });
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }));
    for (const row of rows) row.sources.sort((a, b) => Number(b.available) - Number(a.available) || a.latencyMs - b.latencyMs);
    return rows;
  }
  return { query, probe };
}
module.exports = { createProjectService };
