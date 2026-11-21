'use strict';
const axios = require('axios');
const {load} = require('cheerio');
const {setTimeout: delay} = require('node:timers/promises');

const ENTREZ = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/';
const PAGE = 200, SUMMARY = 50;
let lane = Promise.resolve(), nextRequest = 0;
function paced(fn, signal) {
  const job = lane.then(async () => {
    if (Date.now() < nextRequest) await delay(nextRequest - Date.now(), undefined, {signal});
    signal?.throwIfAborted();
    nextRequest = Date.now() + 350;
    return fn();
  });
  lane = job.catch(() => {});
  return job;
}
function countValue(value, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw Error(`${label}计数无效，请重试`);
  return Number(value);
}
function readSummary(record, uid, accession, runs) {
  if (!record || record.error || String(record.uid) !== uid || typeof record.expxml !== 'string') throw Error(`NCBI 摘要 ${uid} 缺失或记录号不符`);
  const $ = load(`<root>${record.expxml}</root>`, {xmlMode:true});
  const samples = $('root').children().filter((_, node) => node.name.toLowerCase() === 'biosample').map((_, el) => $(el).text().trim()).get();
  if (samples.length !== 1 || samples[0] !== accession) throw Error(`NCBI 摘要 ${uid} 的 BioSample 归属不符`);
  const xml = String(record.runs || '').trim().replace(/^<Runs>\s*([\s\S]*)\s*<\/Runs>$/, '$1').trim();
  if (!xml) throw Error(`NCBI 摘要 ${uid} 缺少 Run`);
  const tags = /<Run\s+([^<>]*?)\s*(?:\/>|>\s*<\/Run>)\s*/gy;
  while (tags.lastIndex < xml.length) {
    const row = tags.exec(xml);
    if (!row) throw Error(`NCBI 摘要 ${uid} 的 Run 标签截断或格式异常`);
    const ids = [...row[1].matchAll(/(?:^|\s)acc\s*=\s*(["'])([^"']*)\1/g)];
    const run = ids[0]?.[2];
    if (ids.length !== 1 || !/^[SED]RR\d+$/.test(run) || runs.has(run)) throw Error(`NCBI 摘要 ${uid} 声明了无效或重复 Run`);
    if (/(?:^|\s)is_public\s*=\s*["']false["']/i.test(row[1])) throw Error(`NCBI 摘要 ${uid} 的 Run 未公开`);
    runs.add(run);
  }
}

async function lookupBioSample(value, {get = axios.get, signal, pace = true} = {}) {
  const biosample = String(value || '').trim().toUpperCase();
  if (!/^(?:SAMN|SAMEA|SAMD)\d+$/.test(biosample)) throw Error('请输入有效的 BioSample 编号，例如 SAMN03174610');
  async function json(base, params, ncbi) {
    const fetch = async () => {
      const response = await get(base + '?' + new URLSearchParams(params), {timeout:20000, maxContentLength:ncbi ? 8*1024*1024 : 4096, signal});
      if (response.status != null && response.status !== 200) throw Error(`HTTP ${response.status}`);
      if (!response.data || typeof response.data !== 'object' || response.data.error || response.data.ERROR) throw Error('官方返回了无效元数据');
      return response.data;
    };
    return ncbi && pace ? paced(fetch, signal) : fetch();
  }
  const counted = await json('https://www.ebi.ac.uk/ena/portal/api/count', {result:'read_run',query:`sample_accession="${biosample}"`,format:'json'}, false);
  const expectedCount = countValue(counted.count, 'ENA 独立 Run ');
  const ids = new Set();
  let recordCount;
  do {
    const offset = ids.size;
    const page = (await json(ENTREZ + 'esearch.fcgi', {db:'sra',term:`${biosample}[BioSample]`,retmode:'json',retstart:String(offset),retmax:String(PAGE)}, true)).esearchresult;
    const count = countValue(page?.count, 'NCBI 搜索记录');
    recordCount ??= count;
    if (recordCount !== count || page.errorlist || !Array.isArray(page.idlist) || String(page.retstart) !== String(offset)) throw Error(`NCBI 分页偏移或总数变化，已核实 ${offset}/${recordCount} 条记录，请重试`);
    if (page.idlist.length !== Math.min(PAGE, count-offset)) throw Error(`NCBI 搜索漏页，仅取得 ${offset+page.idlist.length}/${count} 条记录，请重试`);
    for (const id of page.idlist.map(String)) {
      if (!/^\d+$/.test(id) || ids.has(id)) throw Error(`NCBI 分页包含重复或无效 UID，已核实 ${ids.size}/${count} 条记录`);
      ids.add(id);
    }
  } while (ids.size < recordCount);
  const ordered = [...ids], runs = new Set();
  for (let offset = 0; offset < ordered.length; offset += SUMMARY) {
    const batch = ordered.slice(offset, offset + SUMMARY);
    const {result} = await json(ENTREZ + 'esummary.fcgi', {db:'sra',id:batch.join(','),retmode:'json'}, true);
    const returned = Array.isArray(result?.uids) ? result.uids.map(String) : [];
    if (returned.length !== batch.length || !batch.every(id => returned.includes(id))) throw Error(`NCBI 摘要缺失或归属不符，当前批次返回 ${returned.length}/${batch.length} 条记录`);
    for (const id of batch) readSummary(result[id], id, biosample, runs);
  }
  if (runs.size !== expectedCount) throw Error(`BioSample ${biosample} 的 Run 清单与 ENA 独立计数不符（${runs.size}/${expectedCount}），请重试`);
  if (!runs.size) throw Error(`未找到 BioSample ${biosample} 关联的公开 Run`);
  return {biosample, runs:[...runs], count:runs.size, expectedCount, recordCount, complete:true};
}
module.exports = {lookupBioSample};
