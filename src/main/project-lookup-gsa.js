'use strict';

const axios = require('axios');
const {load} = require('cheerio');
const {workbookRows} = require('./project-lookup-workbook');
const origin = 'https://ngdc.cncb.ac.cn';
const limits = {maxRedirects:0, maxContentLength:4 * 1024 * 1024, timeout:20000};
const verification = /SecurityCheck|Verifying your browser|<title>[^<]*(?:captcha|安全验证)/i;
const fail = message => { throw new Error(message); };

function anchors($, scope, url) {
  const base = new URL($('base[href]').first().attr('href') || url, url);
  return scope.find('a[href]').toArray().flatMap(node => {
    try { return [{node, url:new URL($(node).attr('href'), base)}]; } catch { return []; }
  });
}
function officialPath(url) {
  return url.origin === origin && !url.username && !url.password && !url.search && !url.hash ? url.pathname : '';
}
function fileName(url, cra, run) {
  if (!['https:', 'ftp:'].includes(url.protocol) || !['download.cncb.ac.cn','download.big.ac.cn'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return;
  return new RegExp(`^/gsa\\d*/${cra}/${run}/([\\w.-]+\\.(?:fq|fastq)\\.gz)$`, 'i').exec(url.pathname)?.[1];
}
function hasBothMates(files) {
  const names = files.map(f => f.name);
  return names.every(n => !/_r[12]\.(fastq|fq)\.gz$/i.test(n) || names.includes(n.replace(/_r([12])(?=\.)/i, (_, m) => m === '1' ? '_r2' : '_r1')));
}
function manifest(data, cra, project) {
  const runs = new Set(), projects = new Set(), files = [];
  for (const [columns = [], ...rows] of workbookRows(data, load)) {
    const headers = columns.map(s => String(s).trim().replace(/\s+/g,' '));
    if (!headers.includes('Run data file type')) continue;
    for (const row of rows) {
      const get = name => row[headers.indexOf(name)] || '';
      const run = get('Accession'), parent = get('BioProject accession');
      if (!/^CRR\d+$/.test(run) || runs.has(run) || !/^PRJCA\d+$/.test(parent) || (project && project !== parent)) fail('官方清单的项目或 Run 归属不一致');
      runs.add(run);
      projects.add(parent);
      if (get('Run data file type').toLowerCase() !== 'fastq') continue;
      const group = [];
      for (const mate of [1, 2, 3]) {
        const raw = get(`Read filename ${mate}`);
        if (!raw) continue;
        const match = /^([\w.-]+\.(?:fq|fastq)\.gz)(?:\s+\((\d+) bytes\))?$/i.exec(raw);
        let url;
        try { url = new URL(get(`DownLoad Read file${mate}`)); } catch { group.length = 0; break; }
        if (!match || fileName(url, cra, run) !== match[1]) { group.length = 0; break; }
        const size = Number(match[2]), md5 = get(`Read file${mate} MD5`);
        group.push({run, name:match[1], url:url.href, alternatives:[], format:'fastq', size:Number.isSafeInteger(size) ? size : 0, md5:/^[\da-f]{32}$/i.test(md5) ? md5.toLowerCase() : ''});
      }
      if (hasBothMates(group) && new Set(group.map(f => f.name)).size === group.length) files.push(...group);
    }
  }
  if (!runs.size) fail('官方导出清单未列出 Run');
  return {runs, projects, files};
}

async function lookupGsa(base, request, signal, post = axios.post) {
  const id = base.accession;
  if (!/^(PRJCA|CRA|CRR)\d+$/.test(id)) throw new Error('普通 GSA 编号无效');
  const isRun = id.startsWith('CRR'), isProject = id.startsWith('PRJCA');
  const entry = `${origin}/${isProject ? 'bioproject/browse/' : isRun ? 'gsa/search?searchTerm=' : 'gsa/browse/'}${id}`;
  const projects = new Set(), runs = new Set(), files = [];
  let officialUrl = entry;
  const result = message => ({...base, projects:[...projects], runs:[...runs], files, officialUrl, access:files.length ? 'public' : 'unknown', message});
  async function page(url) {
    officialUrl = url;
    const body = await request(url, {...limits, signal, responseType:'text'});
    if (typeof body !== 'string') fail('GSA 页面格式无法识别');
    if (verification.test(body)) fail('GSA 要求浏览器验证，请打开官方入口');
    return load(body);
  }
  try {
    let archives = [id];
    if (isRun) {
      const $ = await page(entry);
      const matches = anchors($, $.root(), entry).filter(a => new RegExp(`^/gsa/browse/CRA\\d+/${id}$`).test(officialPath(a.url)));
      if (new Set(matches.map(a => a.url.href)).size !== 1) return result('官方搜索未确认唯一的 Run 详情页');
      const {url, node} = matches[0], cra = url.pathname.split('/')[3];
      runs.add(id);
      projects.add(cra);
      const scope = $(node).closest('table.table-left');
      const parents = anchors($, scope, entry).map(a => /^\/bioproject\/browse\/(PRJCA\d+)$/.exec(officialPath(a.url))?.[1]).filter(Boolean);
      if (new Set(parents).size === 1) projects.add(parents[0]);
      const detail = await page(url.href), byPath = new Map();
      for (const a of anchors(detail, detail.root(), url.href)) {
        const name = fileName(a.url, cra, id);
        if (!name) continue;
        const file = byPath.get(a.url.pathname) || {name, urls:new Set()};
        file.urls.add(a.url.href);
        byPath.set(a.url.pathname, file);
      }
      const group = [...byPath.values()];
      if (!group.length || !hasBothMates(group) || (/\bPAIRED\b/i.test(detail.text()) && group.length !== 2) || new Set(group.map(f => f.name)).size !== group.length) return result('已确认 Run 归属，官方详情未列出完整 FASTQ 文件');
      for (const f of group) {
        const [url, ...alternatives] = [...f.urls].sort((a,b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')));
        files.push({run:id, name:f.name, url, alternatives, format:'fastq', size:0, md5:''});
      }
    } else {
      if (isProject) {
        const $ = await page(entry);
        archives = [...new Set(anchors($, $.root(), entry).map(a => /^\/gsa\/browse\/(CRA\d+)$/.exec(officialPath(a.url))?.[1]).filter(Boolean))];
        const count = /\bGSA\s*\(\s*(\d+)\s*\)/.exec($.text());
        if (!count || Number(count[1]) !== archives.length || !archives.length) return result('BioProject 页面未确认完整的普通 GSA 项目列表');
        projects.add(id);
        archives.forEach(cra => projects.add(cra));
      }
      for (const cra of archives) {
        const url = `${origin}/gsa/browse/${cra}`, $ = await page(url);
        const form = $('form[name="download"]');
        if (form.find('[name="dlAcession"]').val() !== cra || form.find('[name="type"]').val() !== '3' || !$.html().includes('/gsa/file/exportExcelFile')) fail('官方项目页未确认清单导出入口');
        projects.add(cra);
        const response = await post(`${origin}/gsa/file/exportExcelFile`, new URLSearchParams({type:'3', dlAcession:cra}).toString(), {...limits, signal, responseType:'arraybuffer', headers:{Referer:url,'Content-Type':'application/x-www-form-urlencoded'}});
        if (verification.test(Buffer.from(response.data).subarray(0,8192).toString())) fail('GSA 要求浏览器验证，请打开官方入口');
        const batch = manifest(response.data, cra, isProject ? id : null);
        if ([...batch.runs].some(run => runs.has(run))) fail('不同 CRA 导出清单包含重复 Run');
        batch.runs.forEach(run => runs.add(run));
        batch.projects.forEach(p => projects.add(p));
        files.push(...batch.files);
      }
      officialUrl = entry;
    }
    return result(`官方记录确认 ${runs.size} 个 Run，列出 ${files.length} 个公开 FASTQ 文件。`);
  } catch (error) {
    if (signal?.aborted || axios.isCancel(error)) throw error;
    const status = error.response?.status;
    const reason = status === 404 ? '官方未找到该记录' : status === 403 ? '官方限制访问，请打开官方入口' : error.message;
    return result(`GSA 查询未完成：${reason}。`);
  }
}
module.exports = {lookupGsa};
