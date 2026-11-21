'use strict';
const {load} = require('cheerio');
const HOME = 'https://ngdc.cncb.ac.cn/gsa-human/';
const ARCHIVE = 'https://download.cncb.ac.cn/gsa-human/';
const FASTQ = /^[\w.-]+\.(?:fastq|fq)\.gz$/i;
function challenge(text) {
  return /<(?:title|h[12])\b[^>]*>\s*[^<]{0,100}(?:Security\s*Check|captcha|browser verification|access denied|forbidden|just a moment|安全验证|访问验证|拒绝访问)|\b(?:verifying your browser|verify (?:you are human|your browser)|captcha challenge|verification_required)\b|请(?:先)?完成(?:浏览器|安全|人机)验证|<form\b[^>]*\bid\s*=\s*["']challenge-form["']/i.test(text);
}
const clean = s => String(s || '').trim().replace(/\s+/g, ' ');
const identityError = message => Object.assign(Error(message), {code:'HRA_IDENTITY'});

function anchors($, scope, page) {
  const base = new URL($('base[href]').first().attr('href') || page, page);
  return scope.find('a[href]').toArray().flatMap(el => {
    const raw = $(el).attr('href');
    if (/[\\\x00-\x1f]|\/(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c/i.test(raw)) return [];
    try { return [{url:new URL(raw, base), text:clean($(el).text())}]; } catch { return []; }
  });
}
function officialId(url, regex) {
  if (url.origin !== new URL(HOME).origin || url.username || url.password || url.search || url.hash) return null;
  return regex.exec(url.pathname)?.[1];
}
const projectId = url => officialId(url, /^\/gsa-human\/browse\/(HRA\d+)\/?$/);
const detailId = url => officialId(url, /^\/gsa-human\/browse\/runDetail\/(HRR\d+)\/?$/);
function fileAt(url, hra, run, name) {
  if (!['https:', 'ftp:'].includes(url.protocol) || !['download.cncb.ac.cn','download.big.ac.cn'].includes(url.hostname) || url.port || url.username || url.password || url.search || url.hash) return null;
  const path = /^\/gsa-human\/(HRA\d+)\/(HRR\d+)\/([^/]+)$/.exec(url.pathname);
  if (!path || path[1] !== hra || (run && path[2] !== run) || !FASTQ.test(path[3]) || (name && path[3] !== name)) return null;
  return {run:path[2], name:path[3], url:url.href, size:0, md5:'', alternatives:[], format:'fastq'};
}
function runParents($, run) {
  const page = HOME+'browse/runDetail/'+run;
  const crumb = $('ol.breadcrumb');
  if (crumb.length && (crumb.length !== 1 || clean(crumb.children('.active').text()) !== run)) throw identityError('Run 页编号与查询不符');
  const links = anchors($, crumb.length ? crumb : $.root(), page);
  const parents = [...new Set(links.filter(a => projectId(a.url) === a.text).map(a => a.text))].sort();
  if (!crumb.length) {
    const labelledRun = $('th,dt').toArray().some(el => /^(?:Accession|Run accession|编号)[:：]?$/i.test(clean($(el).text())) && clean($(el).next().text()) === run);
    const runObject = links.some(({url}) => parents.some(hra => fileAt(url,hra,run)));
    if (!labelledRun && !runObject) return [];
  }
  return parents;
}
function detailFiles($, hra, run) {
  const parents = runParents($, run);
  if (parents.length !== 1 || parents[0] !== hra) throw identityError('官方 Run 详情与所属 HRA 项目不符');
  for (const th of $('th').toArray()) {
    const label = clean($(th).text());
    const expected = /^(?:编号|Accession)$/i.test(label) ? run : /^(?:数据集编号|Study accession)$/i.test(label) ? hra : null;
    if (expected && clean($(th).next('td').text()) !== expected) throw identityError('Run 详情编号与所查项目不符');
  }
  const page = HOME+'browse/runDetail/'+run, files = [];
  const header = $('th').filter((_, el) => /^(?:文件名(?:称)?|(?:Archived )?File ?name)$/i.test(clean($(el).text())));
  if (!header.length && !$('ol.breadcrumb').length) return anchors($, $.root(), page).map(a=>fileAt(a.url,hra,run)).filter(Boolean);
  if (header.length !== 1) throw identityError('官方 Run 页未确认唯一文件表');
  const cols = header.parent().children('th'), nameIndex = cols.index(header);
  const linksIndex = cols.toArray().findIndex(el=>/^(?:下载|Downloads?)$/i.test(clean($(el).text())));
  if (linksIndex < 0) throw identityError('官方 Run 页未提供文件下载栏');
  for (const tr of header.closest('table').find('tr').toArray()) {
    const cells = $(tr).children('td');
    if (!cells.length) continue;
    const name = clean(cells.eq(nameIndex).text());
    if (!FASTQ.test(name)) continue;
    for (const a of anchors($, cells.eq(linksIndex), page)) {
      const file = fileAt(a.url, hra, run, name);
      if (file) files.push(file);
    }
  }
  return files;
}

// The site's Run table counts file rows, not Runs. Check page identity and the
// exact advertised number before allowing it to constrain the file collection.
async function runTable(hra, read) {
  const files = new Map(), runs = new Set(), seen = new Set();
  const pageSize = 20;
  let total, studyId, offset = 0;
  for (let pageNo = 1; ; pageNo++) {
    const query = new URLSearchParams({accession:hra, pageSize:String(pageSize), pageNo:String(pageNo)});
    const body = await read(HOME+'ajaxb/runinstudy?'+query, {headers:{Referer:HOME+'browse/'+hra}});
    const page = typeof body === 'string' ? JSON.parse(body) : body;
    if (page?.accession !== hra || page.pageNo !== pageNo || page.pageSize !== pageSize || !Number.isSafeInteger(page.totalCount) || page.totalCount < 0 || (total != null && total !== page.totalCount)) throw identityError('官方 Run 分页编号、项目或总数不符');
    total = page.totalCount;
    if (total > 20000) throw identityError(`当前项目有 ${total} 条文件记录，超过单次查询上限`);
    if (!Array.isArray(page.runViews) || page.runViews.length !== Math.min(pageSize,total-offset)) throw identityError(`官方 Run 清单漏页（${offset+(page.runViews?.length || 0)}/${total}）`);
    for (const row of page.runViews) {
      const run = row?.runAcc, name = row?.runFileName;
      if (!/^HRR\d+$/.test(run) || typeof name !== 'string' || !name || /[\/\\\x00-\x1f]/.test(name) || (row.studyAcc != null && row.studyAcc !== hra) || (studyId != null && row.studyId != null && studyId !== row.studyId)) throw identityError('文件行的 Run 或项目归属不符');
      studyId ??= row.studyId;
      const key = run+'/'+name;
      if (seen.has(key)) throw identityError(`官方清单含重复文件，已核实 ${seen.size}/${total} 条`);
      seen.add(key); runs.add(run);
      if (FASTQ.test(name)) files.set(key,{run, name});
    }
    offset += page.runViews.length;
    if (offset === total) return {runs, files};
  }
}
function doc(html) {
  if (typeof html !== 'string' || !/<\/html>/i.test(html)) return null;
  return load(html);
}
module.exports = {HOME, ARCHIVE, FASTQ, challenge, clean, anchors, projectId, detailId, fileAt, runParents, detailFiles, runTable, doc};
