'use strict';
const {load} = require('cheerio');
const {ARCHIVE, FASTQ} = require('./project-lookup-human-files');

function entries(html, path) {
  if (typeof html !== 'string' || !/<\/pre>[\s\S]*?<\/html>/i.test(html)) return null;
  const $ = load(html);
  if ($('h1').length !== 1 || $('h1').text().trim() !== `Index of ${path}` || $('title').text().trim() !== `Index of ${path}`) return null;
  return $('pre > a[href]').toArray().map(a => {
    const number = a.next?.type === 'text' && /^\s*[\dA-Za-z:-]+\s+[\d:]+\s+(\d+)\s*(?:\n|$)/.exec(a.next.data)?.[1];
    return {href:$(a).attr('href'), size:number && Number.isSafeInteger(Number(number)) ? Number(number) : 0};
  });
}

// This function is reachable only with an independent, project-bound access
// declaration. The directory and md5sum describe objects on this HTTPS host.
async function publicIndex(record, selected, read, warn, signal) {
  if (record.access !== 'open' || !/^HRA\d+$/.test(record.accession)) throw Error('读取目录前需要核实项目开放状态');
  const hra = record.accession, root = ARCHIVE + hra + '/';
  const files = [], runs = new Set();
  async function optional(url, options) {
    try { return await read(url, options); }
    catch (error) {
      if (signal?.aborted || error.code === 'HRA_STOP') throw error;
      return null;
    }
  }
  const html = await optional(root, {responseType:'text'});
  const rootEntries = entries(html, new URL(root).pathname);
  if (!rootEntries) {
    warn('公开目录本次未能读取');
    return {runs, files, archiveBlocked:html != null};
  }
  const directories = new Set(rootEntries.map(entry=>entry.href).filter(href=>/^HRR\d+\/$/.test(href)));
  for (const href of directories) if (!selected || href === selected+'/') runs.add(href.slice(0,-1));
  if (rootEntries.some(e => e.href === 'md5sum.txt')) {
    const manifest = await optional(root+'md5sum.txt', {responseType:'text'});
    for (const line of String(manifest || '').split(/\r?\n/)) {
      const m = /^([a-f\d]{32})\s+\*?\/(HRA\d+)\/(HRR\d+)\/([\w.-]+)\s*$/i.exec(line);
      if (!m || m[2] !== hra || !FASTQ.test(m[4]) || (selected && selected !== m[3])) continue;
      runs.add(m[3]);
      files.push({run:m[3], name:m[4], url:root+m[3]+'/'+m[4], size:0, md5:m[1].toLowerCase()});
    }
  }
  // Follow published directory links only. Size cannot be inferred from rounded
  // GB values on the study page. Do not keep asking a challenged archive route.
  for (const run of runs) {
    if (!directories.has(run+'/')) continue;
    const directory = root+run+'/';
    const listing = entries(await optional(directory,{responseType:'text'}), new URL(directory).pathname);
    if (!listing) continue;
    for (const {href, size} of listing) {
      if (FASTQ.test(href)) files.push({run, name:href, url:directory+href, size, md5:''});
    }
  }
  return {runs, files, archiveBlocked:false};
}
module.exports = {publicIndex};
