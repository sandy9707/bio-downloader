'use strict';

const axios = require('axios');
const {load} = require('cheerio');
const {workbookRows} = require('./project-lookup-workbook');
const {missingMates} = require('./project-lookup-pairs');
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
function manifest(data, cra, project, selected) {
  const runs = new Set(), projects = new Set(), files = [], layouts = new Map();
  const sheets = workbookRows(data, load);
  for (const [head = [], ...rows] of sheets) {
    if (!head.includes('Layout') || !head.includes('Accession')) continue;
    for (const row of rows) layouts.set(row[head.indexOf('Accession')], row[head.indexOf('Layout')]);
  }
  let incomplete = 0;
  for (const [columns = [], ...rows] of sheets) {
    const headers = columns.map(s => String(s).trim().replace(/\s+/g,' '));
    if (!headers.includes('Run data file type')) continue;
    for (const row of rows) {
      const get = name => row[headers.indexOf(name)] || '';
      const run = get('Accession'), parent = get('BioProject accession');
      if (selected && run !== selected) continue;
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
      const layout = layouts.get(get('Experiment accession')) || get('Layout');
      if (group.length && !missingMates(group,layout) && new Set(group.map(f => f.name)).size === group.length) files.push(...group);
      else incomplete++;
    }
  }
  if (!runs.size) fail('官方导出清单未列出 Run');
  return {runs, projects, files, incomplete};
}

async function lookupGsa(base, request, signal, post) {
  const id = base.accession;
  if (!/^(PRJCA|CRA|CRR)\d+$/.test(id)) throw new Error('普通 GSA 编号无效');
  const isRun = id.startsWith('CRR'), isProject = id.startsWith('PRJCA');
  const entry = `${origin}/${isProject ? 'bioproject/browse/' : isRun ? 'gsa/search?searchTerm=' : 'gsa/browse/'}${id}`;
  const projects = new Set(), runs = new Set(), files = [];
  let officialUrl = entry, partial = false;
  const result = message => ({...base, projects:[...projects], runs:[...runs], files, officialUrl, partial, access:files.length ? 'public' : 'unknown', message});
  async function page(url, referer) {
    officialUrl = url;
    const body = await request(url, {...limits, signal, responseType:'text', headers:{Accept:'text/html', ...(referer ? {Referer:referer} : {})}});
    if (typeof body !== 'string') fail('GSA 页面格式无法识别');
    if (verification.test(body)) fail('GSA 要求浏览器验证，请打开官方入口');
    return load(body);
  }
  async function exportRuns(cra, $, project, selected) {
    const url = `${origin}/gsa/browse/${cra}`, form = $('form[name="download"]');
    if (form.find('[name="dlAcession"]').val() !== cra || form.find('[name="type"]').val() !== '3' || !$.html().includes('/gsa/file/exportExcelFile')) fail('官方项目页未确认清单导出入口');
    const body = new URLSearchParams({type:'3', dlAcession:cra}).toString();
    const config = {...limits, signal, responseType:'arraybuffer', headers:{Referer:url,'Content-Type':'application/x-www-form-urlencoded'}};
    const endpoint = `${origin}/gsa/file/exportExcelFile`;
    const bytes = post ? (await post(endpoint,body,config)).data : await request(endpoint,{...config,method:'POST',data:body});
    if (verification.test(Buffer.from(bytes).subarray(0,8192).toString())) fail('GSA 要求浏览器验证，请打开官方入口');
    return manifest(bytes,cra,project,selected);
  }
  try {
    let archives = [id];
    if (isRun) {
      const $ = await page(entry);
      const searchLinks = anchors($, $.root(), entry);
      const exactRun = a => new RegExp(`^/gsa/browse/CRA\\d+/${id}$`).test(officialPath(a.url));
      let matches = searchLinks.filter(exactRun), archivePage, referer = entry;
      if (!matches.length && $('#search[data-db="GSA"]').attr('data-tip') === id) {
        // Exact search may display only the first ten Runs in the experiment.
        // Follow its published CRA, then require the actual Run link there.
        const choices = [...new Set(searchLinks.filter(a => /^\/gsa\/browse\/CRA\d+$/.test(officialPath(a.url))).map(a=>a.url.href))];
        if (choices.length === 1) {
          [referer] = choices;
          archivePage = await page(referer,entry);
          matches = anchors(archivePage, archivePage.root(), referer).filter(a => exactRun(a) && a.url.href === referer+'/'+id);
        } else if (choices.length > 1) {
          choices.forEach(url=>projects.add(new URL(url).pathname.split('/').pop()));
          return result('官方搜索列出多个候选项目，请选择项目核实 Run 归属。');
        }
      }
      if (new Set(matches.map(a=>a.url.href)).size !== 1) {
        matches.forEach(a => projects.add(a.url.pathname.split('/')[3]));
        return result('官方搜索未确认唯一的 Run 详情页，请选择所属项目或重试。');
      }
      const {url, node} = matches[0], cra = url.pathname.split('/')[3];
      runs.add(id); projects.add(cra);
      if (!archivePage) {
        const scope = $(node).closest('table.table-left');
        for (const a of anchors($,scope,entry)) {
          const parent = /^\/bioproject\/browse\/(PRJCA\d+)$/.exec(officialPath(a.url));
          if (parent) projects.add(parent[1]);
        }
      }
      const detail = await page(url.href, referer), byPath = new Map();
      for (const a of anchors(detail, detail.root(), url.href)) {
        const name = fileName(a.url, cra, id);
        if (!name) continue;
        const file = byPath.get(a.url.pathname) || {name, urls:new Set()};
        file.urls.add(a.url.href);
        byPath.set(a.url.pathname, file);
      }
      const group = [...byPath.values()];
      const layout = /\b(PAIRED|SINGLE)\b/i.exec(detail.text())?.[1];
      if (!group.length || missingMates(group, layout) || new Set(group.map(f => f.name)).size !== group.length) {
        partial = true; return result('已确认 Run 归属，官方详情未列出完整 FASTQ 文件');
      }
      const metadata = new Map();
      if (archivePage) {
        const batch = await exportRuns(cra,archivePage,null,id);
        batch.projects.forEach(p=>projects.add(p));
        for (const f of batch.files) metadata.set(new URL(f.url).pathname,f);
        if (batch.incomplete || metadata.size !== group.length || [...byPath.keys()].some(p=>!metadata.has(p))) {
          partial = true; return result('该 Run 的官方详情与项目清单不符，文件待核实。');
        }
      }
      for (const [path, f] of byPath) {
        const info = metadata.get(path);
        if (info) f.urls.add(info.url);
        const [url, ...alternatives] = [...f.urls].sort((a,b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')));
        files.push({run:id, name:f.name, url, alternatives, format:'fastq', size:info?.size || 0, md5:info?.md5 || ''});
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
        projects.add(cra);
        const batch = await exportRuns(cra,$,isProject ? id : null);
        if (batch.incomplete) partial = true;
        if ([...batch.runs].some(run => runs.has(run))) fail('不同 CRA 导出清单包含重复 Run');
        batch.runs.forEach(run => runs.add(run));
        batch.projects.forEach(p => projects.add(p));
        files.push(...batch.files);
      }
      officialUrl = entry;
    }
    return result(`官方记录确认 ${runs.size} 个 Run，列出 ${files.length} 个公开 FASTQ 文件。${partial ? '部分 Run 的文件或配对端不完整，已略过。' : ''}`);
  } catch (error) {
    if (signal?.aborted || axios.isCancel(error)) throw error;
    partial = true;
    const status = error.response?.status;
    const reason = status === 404 ? '官方未找到该记录' : status === 403 ? '官方限制访问，请打开官方入口' : error.message;
    return result(`GSA 查询未完成：${reason}。`);
  }
}
module.exports = {lookupGsa};
