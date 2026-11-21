'use strict';
const {projectRecord, catalogueRecord, tableRecord} = require('./project-lookup-access');
const {HOME, challenge, anchors, detailId, fileAt, runParents, detailFiles, runTable, doc} = require('./project-lookup-human-files');
const {publicIndex} = require('./project-lookup-index');
const {enrichFiles} = require('./project-lookup-workbook');
const {missingMates} = require('./project-lookup-pairs');

// A remembered parent is a navigation hint. Every query obtains fresh access
// evidence and confirms that the selected Run still belongs to the project.
const recentRuns = new Map();
function remember(hra, runs) {
  for (const run of runs) {
    recentRuns.delete(run); recentRuns.set(run, hra);
    if (recentRuns.size > 4096) recentRuns.delete(recentRuns.keys().next().value);
  }
}
function blockedBody(body) {
  if (Buffer.isBuffer(body) || ArrayBuffer.isView(body) || body instanceof ArrayBuffer) {
    const bytes = Buffer.from(body);
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) return false;
    body = bytes.toString('utf8');
  }
  if (typeof body === 'string') {
    if (challenge(body) || /^\s*(?:HTTP\s+)?(?:401 Unauthorized|403 Forbidden|429 Too Many Requests|Access Denied|Forbidden)(?:[\s.!:：]|$)/i.test(body)) return true;
    if (body.trimStart().startsWith('{')) {
      try { return blockedBody(JSON.parse(body)); } catch { /* non-JSON metadata */ }
    }
    return false;
  }
  if (!body || typeof body !== 'object') return false;
  const status = Number(body.statusCode || body.status || body.code);
  const marker = [body.code,body.message,body.error].filter(v=>typeof v==='string').join(' ');
  return [401,403,407,429,451,503].includes(status) || challenge(marker) || /captcha|verification.required|access.denied|forbidden|安全验证|人机验证|拒绝访问/i.test(marker);
}
function isTransportFailure(error) {
  return !error.response && ['ECONNRESET','ECONNABORTED','ETIMEDOUT','EAI_AGAIN','ERR_NETWORK'].includes(error.code);
}
function requestReader(request, signal) {
  let stopped;
  function stop(reason) {
    stopped = Object.assign(Error(reason), {code:'HRA_STOP'});
    throw stopped;
  }
  return async (url, options = {}) => {
    signal?.throwIfAborted();
    if (stopped) throw stopped;
    let body;
    try { body = await request(url, {timeout:10000, maxRedirects:0, maxContentLength:4*1024*1024, ...options}); }
    catch (error) {
      if (signal?.aborted) throw error;
      const status = error.response?.status;
      if ([401,403,407,429,451,503].includes(status) || (status >= 300 && status < 400)) stop(`官方返回 HTTP ${status}，已停止本次查询`);
      if (error.code === 'HRA_STOP' || blockedBody(error.response?.data) || challenge(error.message)) stop('官网要求验证或限制访问，已停止本次查询');
      throw error;
    }
    if (blockedBody(body) || (options.method === 'HEAD' && /html/i.test(body?.['content-type'] || ''))) stop('官网要求验证或返回访问限制页面，已停止本次查询');
    return body;
  };
}
async function accessRecord(hra, read, signal) {
  const url = HOME+'browse/'+hra;
  let html;
  try { html = await read(url, {headers:{Referer:HOME+'browse/', Accept:'text/html'}}); }
  catch (error) {
    if (signal?.aborted || !isTransportFailure(error)) throw error;
    // A transport failure with no response is distinct from a provider refusal.
    // The official Available export must itself affirm this exact accession.
    const filters = {accession:hra, status:'3', tab:'1', publishTime:'', open:'', platform:'', sample:'', dataType:''};
    const bytes = await read(HOME+'file/downLoadFilterFiles', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded', Referer:HOME+'browse/'}, data:new URLSearchParams(filters).toString(), responseType:'arraybuffer'});
    const record = catalogueRecord(bytes, hra, url);
    return {...record, accession:hra, modern:true};
  }
  const $ = doc(html);
  if (!$) throw Error('官方项目页面不完整，访问方式未确认');
  const modern = $('input#idacc').length > 0;
  return {...(modern ? projectRecord(html,hra,url) : tableRecord($,hra,url)), accession:hra, modern, $};
}

// Directory sizes may be absent when the official index is temporarily down.
// A normal HEAD on an already published object can confirm its full byte length.
async function fillMissingSizes(files, read, signal) {
  const deadline = Date.now() + 12000;
  for (const file of files) {
    if (file.size || !file.url.startsWith('https:')) continue;
    const timeout = Math.min(2500, deadline - Date.now());
    if (timeout <= 0) break;
    try {
      const h = await read(file.url, {method:'HEAD', timeout, decompress:false, headers:{'Accept-Encoding':'identity'}});
      if (!h || typeof h !== 'object') continue;
      const type = h['content-type'] || '';
      if (/html|xml|json|^text\//i.test(type)) break;
      if (h['content-range'] || (h['content-encoding'] && h['content-encoding'] !== 'identity')) continue;
      const length = h['content-length'];
      if (/^\d+$/.test(length) && Number.isSafeInteger(Number(length))) file.size = Number(length);
    } catch (error) {
      if (signal?.aborted || error.code === 'HRA_STOP') throw error;
    }
  }
}

async function openFiles(record, selected, runDoc, read, signal, workbook) {
  const hra = record.accession, page = HOME+'browse/'+hra, warnings = new Set();
  const warn = msg => warnings.add(msg);
  const runs = new Set(), objects = new Map(), publishedDetails = new Set(), excluded = new Set();
  let table = null, archiveBlocked = false;
  const inScope = run => !selected || run === selected;
  const add = file => {
    if (!file || !inScope(file.run) || excluded.has(file.run)) return;
    const key = file.run+'/'+file.name;
    if (table && !table.files.has(key)) return;
    runs.add(file.run);
    const f = objects.get(key) || {run:file.run,name:file.name,urls:new Set(),size:0,md5:''};
    if (file.size && f.size && file.size !== f.size) throw Error('官方清单的文件大小不一致，请重试');
    if (file.md5 && f.md5 && file.md5 !== f.md5) throw Error('官方清单的文件 MD5 不一致，请重试');
    f.size ||= file.size; f.md5 ||= file.md5; f.urls.add(file.url); objects.set(key,f);
  };
  if (record.modern && !selected) {
    try { table = await runTable(hra, read); }
    catch (error) {
      if (signal?.aborted || ['HRA_IDENTITY','HRA_STOP'].includes(error.code)) throw error;
      warn('官方 Run 分页暂不可用，文件总数待复核');
    }
    if (table) for (const run of table.runs) { runs.add(run); publishedDetails.add(run); }
  }
  if (record.$) for (const {url} of anchors(record.$, record.$.root(),page)) {
    const run = detailId(url);
    if (run && inScope(run) && (!table || table.runs.has(run))) { runs.add(run); publishedDetails.add(run); }
    if (!record.modern) add(fileAt(url,hra,selected));
  }
  if (selected && runDoc) { runs.add(selected); publishedDetails.add(selected); }
  // A validated Run table/crumb publishes the detail route. Do not guess links
  // to other runs on a single-Run lookup or keep querying a challenged route.
  let detailUnavailable = 0;
  for (const run of publishedDetails) {
    try {
      const $ = runDoc || doc(await read(HOME+'browse/runDetail/'+run, {responseType:'text',headers:{Referer:page,Accept:'text/html'}}));
      if (!$) throw Error('Run 详情不完整');
      for (const file of detailFiles($,hra,run)) add(file);
    } catch (error) {
      if (signal?.aborted || error.code === 'HRA_STOP') throw error;
      if (error.code === 'HRA_IDENTITY') {
        excluded.add(run); warn(`${run} 的官方详情归属或下载栏不符，已排除`);
      } else { detailUnavailable++; break; }
    }
  }
  if (detailUnavailable) warn('部分 Run 详情暂不可用，仅保留其他官方清单已确认的地址');
  if (record.modern || !objects.size || !publishedDetails.size) {
    const archive = await publicIndex(record, selected, read, warn, signal);
    archiveBlocked = archive.archiveBlocked;
    for (const run of archive.runs) if (!table || table.runs.has(run)) runs.add(run);
    for (const file of archive.files) add(file);
  }
  const files = [];
  for (const f of objects.values()) {
    if (excluded.has(f.run)) continue;
    const [url, ...alternatives] = [...f.urls].sort((a,b) => Number(b.startsWith('https:')) - Number(a.startsWith('https:')));
    files.push({run:f.run, name:f.name, url, alternatives, size:f.size || 0, md5:f.md5 || '', format:'fastq'});
  }
  if (files.length && (workbook || record.workbookUrl)) {
    try {
      const bytes = workbook || await read(record.workbookUrl, {responseType:'arraybuffer',headers:{Referer:page}});
      if (enrichFiles(bytes,files)) warn('官方清单存在相互冲突的 MD5，已清除相关参考值');
    } catch (error) { if (signal?.aborted || error.code === 'HRA_STOP') throw error; warn('项目工作簿未能核实'); }
  }
  if (!archiveBlocked && record.modern) await fillMissingSizes(files,read,signal);
  const missingSizes = files.filter(f=>!f.size).length, missingHashes = files.filter(f=>!f.md5).length;
  if (missingSizes || missingHashes) warn(`已核实精确大小 ${files.length-missingSizes}/${files.length} 个，官方 MD5 ${files.length-missingHashes}/${files.length} 个`);
  const byRun = new Map();
  for (const file of files) { if (!byRun.has(file.run)) byRun.set(file.run, []); byRun.get(file.run).push(file); }
  const missingRuns = [...runs].filter(run=>!byRun.has(run)).length;
  const missingEnds = [...byRun.values()].filter(group=>missingMates(group)).length;
  if (missingRuns) warn(`${missingRuns} 个 Run 尚未取得文件清单`);
  if (missingEnds) warn(`${missingEnds} 个 Run 的配对文件缺端`);
  if (table && files.length !== table.files.size) warn(`已取得 ${files.length}/${table.files.size} 个 FASTQ，清单不完整`);
  if (selected && !runs.has(selected)) warn('当前项目清单未确认所查 Run');
  const message = `官方声明开放访问。已查到 ${runs.size} 个 Run、${files.length} 个 FASTQ。` + [...warnings].map(s=>s+'。').join('');
  return {runs:[...runs], files, partial:Boolean(warnings.size), message};
}

async function lookupHuman(base, request, signal, workbook) {
  const id = base.accession, selected = /^HRR/.test(id) ? id : null;
  if (/^HIR/.test(id)) return {...base, officialUrl:HOME, message:'请在 GSA-Human 核实 HIR 编号及其所属库，可使用官方 HRA 或 HRR 编号查询。'};
  let hra = id, runDoc, officialUrl = HOME+'browse/'+(selected ? 'runDetail/'+selected : hra);
  const read = requestReader(request, signal);
  try {
    if (selected) {
      try {
        runDoc = doc(await read(officialUrl, {headers:{Referer:HOME+'browse/',Accept:'text/html'}}));
        if (!runDoc) throw Error('官方 Run 页面不完整');
      } catch (error) {
        if (signal?.aborted || !isTransportFailure(error) || !recentRuns.has(selected)) throw error;
      }
      const projects = runDoc ? runParents(runDoc,selected) : recentRuns.has(selected) ? [recentRuns.get(selected)] : [];
      if (projects.length !== 1) return {...base, projects, officialUrl, message:projects.length ? '官方记录列出多个父项目，请选择项目查看。' : '官方 Run 页未确认所属项目，请核对 HRA 或重试。'};
      [hra] = projects;
      officialUrl = HOME+'browse/'+hra;
    }
    const record = await accessRecord(hra, read, signal);
    if (record.access === 'controlled') return {...base, projects:[hra], officialUrl, access:'controlled', applicationUrl:record.applicationUrl || officialUrl, message:record.status};
    if (record.access !== 'open') throw Error('官方尚未声明该项目为开放访问');
    const result = await openFiles(record,selected,runDoc,read,signal,workbook);
    remember(hra,result.runs);
    return {...base, ...result, projects:[hra], officialUrl, access:'public'};
  } catch (error) {
    if (signal?.aborted) throw error;
    const reason = error.response?.status === 404 ? '官方未找到该记录' : error.message;
    return {...base, officialUrl, partial:true, providerBlocked:error.code === 'HRA_STOP', message:`本次未能核实官方项目记录：${reason}。请打开官方记录或稍后重试。`};
  }
}
module.exports = {lookupHuman};
