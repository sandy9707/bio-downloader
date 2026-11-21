'use strict';
// Narrow, bounded OOXML metadata reader; never executes workbook content.
const { inflateRawSync } = require('zlib');
function crc32(b) { let c = -1; for (const v of b) { c ^= v; for (let k=0;k<8;k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); } return (c ^ -1) >>> 0; }
function workbookRows(input, load) {
  const b = Buffer.from(input); if (b.length > 4*1024*1024 || b.length < 22) throw new Error('CNCB metadata ZIP size invalid');
  let end=-1; for(let p=b.length-22;p>=Math.max(0,b.length-65557);p--) if(b.readUInt32LE(p)===0x06054b50){end=p;break;}
  if(end<0 || b.readUInt16LE(end+4) || b.readUInt16LE(end+6)) throw new Error('CNCB metadata ZIP directory invalid');
  const count=b.readUInt16LE(end+10), directory=b.readUInt32LE(end+16); if(count>128 || directory>=end) throw new Error('CNCB metadata ZIP limits');
  const entries=new Map(); let p=directory,total=0;
  for(let i=0;i<count;i++) {
    if(p+46>end || b.readUInt32LE(p)!==0x02014b50) throw new Error('CNCB metadata ZIP entry invalid');
    const flags=b.readUInt16LE(p+8), method=b.readUInt16LE(p+10), crc=b.readUInt32LE(p+16), compressed=b.readUInt32LE(p+20), size=b.readUInt32LE(p+24), n=b.readUInt16LE(p+28), x=b.readUInt16LE(p+30), comment=b.readUInt16LE(p+32), off=b.readUInt32LE(p+42);
    const name=b.subarray(p+46,p+46+n).toString('utf8'); p+=46+n+x+comment;
    total+=size; if(total>16*1024*1024 || size>8*1024*1024 || (flags&1) || ![0,8].includes(method) || entries.has(name) || /(?:^|\/)\.\.(?:\/|$)|^\//.test(name)) throw new Error('CNCB metadata ZIP unsafe entry');
    if(off+30>b.length || b.readUInt32LE(off)!==0x04034b50) throw new Error('CNCB metadata ZIP local header invalid');
    const start=off+30+b.readUInt16LE(off+26)+b.readUInt16LE(off+28); if(start+compressed>directory) throw new Error('CNCB metadata ZIP truncated');
    const data=method===8 ? inflateRawSync(b.subarray(start,start+compressed),{maxOutputLength:8*1024*1024}) : b.subarray(start,start+compressed);
    if(data.length!==size || crc32(data)!==crc) throw new Error('CNCB metadata ZIP checksum invalid'); entries.set(name,data.toString('utf8'));
  }
  const xml=s=>{if(/<!DOCTYPE|<!ENTITY/i.test(s))throw new Error('CNCB metadata XML entities rejected');return load(s,{xmlMode:true});};
  const $s=xml(entries.get('xl/sharedStrings.xml')||'<sst/>'), strings=[]; $s('si').each((_i,n)=>strings.push($s(n).text()));
  const sheets=[];
  for(const [name,text] of entries) if(/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) {
    const $=xml(text),rows=[]; $('sheetData row').each((_i,r)=>{const row=[]; $(r).children('c').each((_j,c)=>{const cell=$(c),ref=cell.attr('r')||'',letters=/^[A-Z]+/.exec(ref)?.[0];if(!letters)throw new Error('CNCB metadata cell reference missing');let col=0;for(const ch of letters)col=col*26+ch.charCodeAt(0)-64;if(col>256)throw new Error('CNCB metadata columns exceeded');const raw=cell.find('v').text();row[col-1]=cell.attr('t')==='s'?strings[Number(raw)]:cell.attr('t')==='inlineStr'?cell.find('is').text():raw;});rows.push(row);}); sheets.push(rows);
  }
  return sheets;
}
// Attach published attributes only to objects independently listed by the host.
function enrichFiles(input, files) {
  const {load} = require('cheerio');
  const objects = new Map(files.map(file => [new URL(file.url).pathname, file]));
  const conflicts = new Set();
  for (const [head = [], ...rows] of workbookRows(input, load)) {
    const columns = head.map(name => String(name).trim().replace(/\s+/g,' '));
    if (!columns.includes('Run data file type')) continue;
    for (const row of rows) {
      const run = row[columns.indexOf('Accession')];
      for (let col = 0; col < columns.length; col++) {
        // Some official sheets repeat the download column's heading and its R1
        // URL in the R2 block. Associate attributes by adjacent NAMED cells.
        if (!/^Read filename \d+$/i.test(columns[col]) || !/^Read file\d+ MD5$/i.test(columns[col+1]) || !/^DownLoad Read file\d+$/i.test(columns[col+2])) continue;
        const name = row[col], digest = row[col+1], raw = row[col+2];
        if (typeof raw !== 'string' || /[\\\x00-\x1f]|\/(?:\.|%2e){1,2}(?:\/|$)|%2f|%5c/i.test(raw)) continue;
        let url;
        try { url = new URL(raw); } catch { continue; }
        if (!['ftp:','https:'].includes(url.protocol) || !['download.big.ac.cn','download.cncb.ac.cn'].includes(url.hostname) || url.username || url.password || url.port || url.hash || url.search) continue;
        const linked = objects.get(url.pathname);
        const file = objects.get(url.pathname.slice(0,url.pathname.lastIndexOf('/')+1) + name);
        if (!file || file.run !== run || file.name !== name || linked?.run !== run) continue;
        if (linked === file && url.href !== file.url && !file.alternatives.includes(url.href)) file.alternatives.push(url.href);
        if (!/^[0-9a-f]{32}$/i.test(digest) || conflicts.has(file)) continue;
        if (file.md5 && file.md5 !== digest.toLowerCase()) { file.md5 = ''; conflicts.add(file); }
        else file.md5 = digest.toLowerCase();
      }
    }
  }
  return conflicts.size;
}
module.exports = {enrichFiles, workbookRows};
