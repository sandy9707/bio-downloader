'use strict';

const { load } = require('cheerio');
const origin = 'https://ngdc.cncb.ac.cn';
const home = `${origin}/gsa-human/`;
// Cache membership only. Every lookup obtains current access and file evidence.
const recentRuns = new Map();
function remember(result, hra) {
  for (const id of result.runs) {
    recentRuns.delete(id);
    recentRuns.set(id, hra);
    if (recentRuns.size > 4096) recentRuns.delete(recentRuns.keys().next().value);
  }
  return result;
}
const runPath = /^\/gsa-human\/browse\/runDetail\/(HRR\d+)\/?$/;
const projectPath = /^\/gsa-human\/browse\/(HRA\d+)\/?$/;

function links($, page) {
  const result = [];
  $('a[href]').each((_, elem) => {
    try { result.push({url:new URL($(elem).attr('href'), page), text:$(elem).text().trim()}); } catch { /* unrelated malformed link */ }
  });
  return result;
}
function fieldValues($, pattern) {
  const values = [];
  $('th,td,dt,label,strong,b,span,div').each((_, el) => {
    const node = $(el);
    if (node.children().length || !pattern.test(node.text().trim().replace(/[:：]\s*$/, ''))) return;
    const text = node.next().text().trim() || (node[0].next?.type === 'text' && node[0].next.data.trim());
    if (text) values.push(text);
  });
  return [...new Set(values)];
}
function humanFiles(anchors, hra, run, found) {
  for (const {url} of anchors) {
    if (!['https:','ftp:'].includes(url.protocol) || !['download.cncb.ac.cn','download.big.ac.cn'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) continue;
    const match = /^\/gsa-human\/(HRA\d+)\/(HRR\d+)\/([\w.-]+\.(?:fastq|fq)\.gz)$/i.exec(url.pathname);
    if (!match || match[1] !== hra || (run && match[2] !== run)) continue;
    const file = found.get(url.pathname) || {run:match[2],name:match[3],urls:new Set()};
    file.urls.add(url.href);
    found.set(url.pathname, file);
  }
}
function checkedDoc(html) {
  if (typeof html !== 'string' || /<title>\s*SecurityCheck|Verifying your browser|captcha/i.test(html) || !/<\/html>/i.test(html)) return null;
  return load(html);
}
async function lookupHuman(base, request, signal) {
  const {accession} = base;
  if (/^HIR/.test(accession)) return {...base, officialUrl:home, message:'请在 GSA-Human 核实 HIR 编号及其所属项目，可使用官方 HRA 或 HRR 编号查询。'};
  const run = /^HRR/.test(accession) ? accession : null;
  const runUrl = run ? `${home}browse/runDetail/${run}` : null;
  let hra = accession, runLinks;
  if (run) {
    let detail;
    try { detail = checkedDoc(await request(runUrl, {maxRedirects:0})); }
    catch (error) { if (signal?.aborted || !recentRuns.has(run)) throw error; }
    if (detail) runLinks = links(detail, runUrl);
    const projects = new Set(), fileProjects = new Set();
    for (const {url} of runLinks || []) {
      const project = url.origin === origin && projectPath.exec(url.pathname)?.[1];
      const file = ['https://download.cncb.ac.cn','ftp://download.big.ac.cn'].includes(url.origin) && /^\/gsa-human\/(HRA\d+)\/(HRR\d+)\//.exec(url.pathname);
      if (project) projects.add(project);
      if (file && file[2] === run) fileProjects.add(file[1]);
    }
    if (!projects.size) for (const id of fileProjects) projects.add(id);
    if (!projects.size && recentRuns.has(run)) projects.add(recentRuns.get(run));
    if (projects.size !== 1) return {...base, officialUrl:runUrl, message:'官方 Run 页面未确认所属 HRA 项目，可先查询 HRA 项目编号，再查询当前 HRR。'};
    [hra] = projects;
  }
  const officialUrl = `${home}browse/${hra}`;
  const pending = {...base, officialUrl, message:'尚未确认项目的官方访问状态，请在 GSA-Human 项目页核实。'};
  let html;
  try { html = await request(officialUrl, {maxRedirects:0}); }
  catch (error) {
    if (signal?.aborted) throw error;
    if (error.response?.status && error.response.status < 500) return pending;
  }
  const $ = checkedDoc(html);
  if (!$ || $('input#idacc').length) {
    const {projectRecord, catalogueRecord} = require('./project-lookup-access');
    let record;
    if ($) {
      try { record = projectRecord(html, hra, officialUrl); } catch { return pending; }
    } else {
      let bytes;
      try {
        bytes = await request(home+'file/downLoadFilterFiles', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'}, data:new URLSearchParams({accession:hra,pageNo:'1'}).toString(), responseType:'arraybuffer', timeout:10000, maxRedirects:0});
      } catch (error) { if (signal?.aborted) throw error; if ([401,403,429].includes(error.response?.status)) return pending; }
      if (bytes && Buffer.from(bytes).subarray(0,2).toString() === 'PK') {
        try { record = catalogueRecord(bytes, hra, officialUrl); } catch { return pending; }
      }
    }
    if (record?.access === 'controlled') return {...pending, projects:[hra], access:'controlled', applicationUrl:record.applicationUrl, message:record.status};
    const result = await require('./project-lookup-index').publicIndex(pending, hra, run, request, signal);
    if (record?.workbookUrl && result.files.length) {
      try { require('./project-lookup-workbook').enrichFiles(await request(record.workbookUrl, {responseType:'arraybuffer', maxContentLength:4*1024*1024, maxRedirects:0}), result.files); }
      catch (error) { if (signal?.aborted) throw error; }
    }
    return remember(result, hra);
  }
  const anchors = links($, officialUrl);
  const ids = fieldValues($, /^(?:Accession(?: number| ID)?|GSA(?:-Human)? accession|项目编号|数据集编号)$/i);
  const headings = $('h1,h2,h3,h4,title').text();
  const identity = ids.includes(hra) || (!ids.length && new RegExp(`\\b${hra}\\b`).test(headings));
  if (!identity) return pending;
  const values = fieldValues($, /^(?:(?:Data )?Access(?: type| mode| status)?|数据访问类型|访问类型|访问权限)$/i);
  const controlled = values.some(v => /^(?:controlled(?: access)?|restricted(?: access)?|受控(?:访问)?)(?:\s*\([^)]*\))?$/i.test(v));
  if (controlled) {
    const apply = anchors.find(x => x.url.origin === origin && /apply|request access|申请/i.test(x.text) && /^\/(?:gsa-human|dac|gsa)\//.test(x.url.pathname));
    return {...pending, projects:[hra], access:'controlled', applicationUrl:apply?.url.href || officialUrl, message:'官方记录为受控访问，请从项目页申请数据访问。'};
  }
  if (!values.length || values.some(v => !/^(?:open(?: access)?|public(?: access)?|开放(?:访问)?|公开(?:访问)?)$/i.test(v))) return pending;
  const found = new Map();
  humanFiles(anchors, hra, run, found);
  const detailUrls = new Map();
  for (const {url} of anchors) {
    const id = url.origin === origin && runPath.exec(url.pathname)?.[1];
    if (id && (!run || run === id)) detailUrls.set(id, `${home}browse/runDetail/${id}`);
  }
  if (run && !detailUrls.has(run) && ![...found.values()].some(f => f.run === run)) return pending;
  let partial = false;
  for (const [id, url] of detailUrls) {
    signal?.throwIfAborted();
    try {
      const doc = runLinks ? null : checkedDoc(await request(url));
      if (!runLinks && !doc) { partial = true; continue; }
      humanFiles(runLinks || links(doc, url), hra, id, found);
    } catch (error) { if (signal?.aborted) throw error; partial = true; }
  }
  const files = [...found.values()].map(f => {
    const [url, ...alternatives] = [...f.urls].sort((a,b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')));
    return {run:f.run, name:f.name, url, alternatives, size:0, md5:'', format:'fastq'};
  });
  const runs = [...new Set([...detailUrls.keys(), ...files.map(f => f.run)])];
  return remember({...base, projects:[hra], officialUrl, access:'public', runs, files, message:`官方开放访问。已取得 ${runs.length} 个 Run、${files.length} 个公开文件。${partial ? '部分 Run 详情未能读取。' : ''}`}, hra);
}
module.exports = { lookupHuman };
