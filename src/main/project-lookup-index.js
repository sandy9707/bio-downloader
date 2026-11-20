'use strict';
const {load} = require('cheerio');

// The public download site's Apache-style index includes a script after </html>.
// Only consult its static, path-labelled <pre> listing, never script-generated URLs.
function entries(html, path) {
  if (typeof html !== 'string' || !html.includes('</pre>')) return null;
  const $ = load(html);
  if ($('h1').text().trim() !== `Index of ${path}` || $('title').text().trim() !== `Index of ${path}`) return null;
  return $('pre > a[href]').toArray().map(a => {
    const href = $(a).attr('href');
    const number = a.next?.type === 'text' && /^\s*[\dA-Za-z:-]+\s+[\d:]+\s+(\d+)\s*(?:\n|$)/.exec(a.next.data)?.[1];
    return {href, size:number && Number.isSafeInteger(Number(number)) ? Number(number) : 0};
  });
}
async function publicIndex(pending, hra, selected, request, signal) {
  const path = `/gsa-human/${hra}/`;
  const site = 'https://download.cncb.ac.cn';
  const read = async path => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return entries(await request(site + path, {maxRedirects:0, timeout:10000, responseType:'text'}), path); }
      catch (error) {
        if (signal?.aborted) throw error;
        const status = error.response?.status;
        if (status && ![408,500,502,503,504].includes(status)) return null;
      }
    }
    return null;
  };
  const listing = await read(path);
  if (!listing) return pending;
  const runs = [...new Set(listing.filter(e => /^HRR\d+\/$/.test(e.href)).map(e => e.href.slice(0,-1)))].filter(id => !selected || id === selected);
  if (!runs.length) return pending;
  const results = new Array(runs.length);
  let next = 0;
  await Promise.all(Array.from({length:Math.min(3, runs.length)}, async () => {
    while (next < runs.length) {
      const i = next++, run = runs[i], prefix = `${path}${run}/`;
      signal?.throwIfAborted();
      const folder = await read(prefix);
      results[i] = (folder || []).filter(e => /^[\w.-]+\.(?:fastq|fq)\.gz$/i.test(e.href)).map(e => ({run, name:e.href, url:site + prefix + e.href, size:e.size, md5:'', format:'fastq', alternatives:[]}));
    }
  }));
  const files = results.flat();
  if (listing.some(e => e.href === 'md5sum.txt')) {
    let text;
    try { text = await request(site + path + 'md5sum.txt', {maxRedirects:0, timeout:12000, responseType:'text'}); }
    catch (error) { if (signal?.aborted) throw error; }
    const objects = new Map(files.map(file => [file.url, file]));
    const listed = new Set(runs);
    for (const line of String(text || '').split(/\r?\n/)) {
      const m = /^([a-f0-9]{32})\s+\*?\/(HRA\d+)\/(HRR\d+)\/([\w.-]+\.(?:fastq|fq)\.gz)\s*$/i.exec(line);
      if (!m || m[2] !== hra || !listed.has(m[3])) continue;
      const url = site + path + m[3] + '/' + m[4];
      let file = objects.get(url);
      if (!file) {
        file = {run:m[3], name:m[4], url, size:0, format:'fastq', alternatives:[]};
        objects.set(url, file); files.push(file);
      }
      if (file.md5 && file.md5 !== m[1].toLowerCase()) throw new Error('官方清单的文件 MD5 不一致');
      file.md5 = m[1].toLowerCase();
    }
  }
  const covered = new Set(files.map(f => f.run));
  const missing = runs.filter(run => !covered.has(run)).length;
  return {...pending, projects:[hra], runs, files, access:files.length ? 'public' : 'unknown', message:`官方公开下载目录列出 ${runs.length} 个 Run，已查到 ${files.length} 个公开文件。${missing ? `${missing} 个 Run 尚未取得文件清单。` : ''}`};
}
module.exports = { publicIndex };
