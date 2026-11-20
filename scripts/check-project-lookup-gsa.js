'use strict';
const assert = require('node:assert/strict');
const {lookupGsa} = require('../src/main/project-lookup-gsa');
const cra = 'CRA029136', project = 'PRJCA045020', run = 'CRR2061509';
const root = 'https://ngdc.cncb.ac.cn';
const archive = `${root}/gsa/browse/${cra}`, detail = `${archive}/${run}`;
const ftp = `ftp://download.big.ac.cn/gsa5/${cra}/${run}/${run}_r1.fastq.gz`;
const https = ftp.replace('ftp://download.big', 'https://download.cncb');
const table = `<base href="${root}/gsa/"><table class="table-left"><tr><td><a href="/bioproject/browse/${project}">Project</a><a href="browse/${cra}/${run}">Run</a></td></tr></table>`;
const form = `<form name="download"><input name="type" value="3"><input name="dlAcession" value="${cra}"></form><script>f.action='/gsa/file/exportExcelFile'</script>`;
const base = accession => ({accession, projects:[], runs:[], files:[], access:'unknown', officialUrl:'', applicationUrl:'', message:''});
const pair = url => [url, url.replace('_r1.', '_r2.')];
const links = urls => urls.map(url => `<a href="${url}">File</a>`).join('');

// Build one stored ZIP member with independently generated sheet XML.
function workbook(parent = project) {
  const names = pair(ftp).map(link => link.split('/').pop());
  const headers = ['Accession','BioProject accession','Run data file type','Read filename 1','Read file1 MD5','DownLoad Read file1','Read filename 2','Read file2 MD5','DownLoad  Read file2'];
  const values = [run,parent,'fastq',names[0]+' (32745585265 bytes)','3d36f96070a7a4b4209713e80cde1b7c',ftp,names[1]+' (33620495575 bytes)','e532b236a37f3e942892c907b213e6f4',pair(ftp)[1]];
  const rows = [headers,values].map((r,i) => '<row>'+r.map((v,j) => `<c r="${String.fromCharCode(65+j)}${i+1}" t="inlineStr"><is><t>${v}</t></is></c>`).join('')+'</row>');
  const data = Buffer.from('<worksheet><sheetData>'+rows.join('')+'</sheetData></worksheet>');
  const name = Buffer.from('xl/worksheets/sheet3.xml');
  let crc = -1;
  for (const v of data) { crc ^= v; for (let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  const local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); central.writeUInt32LE(0x02014b50); end.writeUInt32LE(0x06054b50);
  for (const [h,off] of [[local,14],[central,16]]) {
    h.writeUInt32LE((~crc)>>>0,off); h.writeUInt32LE(data.length,off+4); h.writeUInt32LE(data.length,off+8); h.writeUInt16LE(name.length,off+12);
  }
  end.writeUInt16LE(1,8); end.writeUInt16LE(1,10); end.writeUInt32LE(central.length+name.length,12); end.writeUInt32LE(local.length+name.length+data.length,16);
  return Buffer.concat([local,name,data,central,name,end]);
}
async function main() {
  const post = async (url,body,config) => {
    assert.equal(url,`${root}/gsa/file/exportExcelFile`); assert.equal(body,`type=3&dlAcession=${cra}`); assert.equal(config.headers.Referer,archive);
    return {status:200, data:workbook()};
  };
  let detailHtml = 'PAIRED'+links([...pair(ftp), ...pair(https), https.replace(cra,'CRA123'), https.replace('cncb.ac.cn','evil.invalid')]);
  const pages = async (url,config) => {
    assert.equal(config.maxRedirects,0);
    if (url.endsWith(project)) return `GSA (1)<a href="/gsa/browse/${cra}">archive</a>`;
    if (url.includes('searchTerm')) return table;
    if (url === detail) return detailHtml;
    assert.equal(url,archive); return form;
  };
  for (const id of [cra,project]) {
    const res = await lookupGsa(base(id),pages,undefined,post);
    assert.equal(res.access,'public',res.message); assert.deepEqual(res.runs,[run]); assert.deepEqual(new Set(res.projects),new Set([cra,project]));
    assert.deepEqual(res.files.map(f=>f.url),pair(ftp)); assert.equal(res.files[0].size,32745585265); assert.equal(res.files[1].md5,'e532b236a37f3e942892c907b213e6f4');
  }
  const reverse = await lookupGsa(base(run),pages);
  assert.deepEqual(reverse.files.map(f=>f.url),pair(https)); assert.deepEqual(reverse.files[0].alternatives,[ftp]); assert.deepEqual(reverse.projects,[cra,project]);
  detailHtml = 'PAIRED'+links([https]); assert.deepEqual((await lookupGsa(base(run),pages)).files,[]);
  detailHtml = '<title>SecurityCheck</title>';
  const guarded = await lookupGsa(base(run),pages);
  assert.equal(guarded.access,'unknown'); assert.equal(guarded.officialUrl,detail); assert.match(guarded.message,/验证/); assert.deepEqual(guarded.runs,[run]);
  const bad = await lookupGsa(base(project),pages,undefined,async()=>({data:workbook('PRJCA1')})); assert.deepEqual(bad.files,[]); assert.match(bad.message,/归属/);
  const calls = []; const stopped = await lookupGsa(base(cra),async u=>{calls.push(u); return '<title>SecurityCheck</title>';},undefined,()=>{calls.push('unexpected export');}); assert.equal(stopped.officialUrl,archive); assert.deepEqual(calls,[archive]);
  console.log('PASS PRJCA/CRA workbook, CRR reverse mapping, paired FASTQ, official protocols, membership and verification stop');
  if (process.argv.includes('--live')) {
    const {lookupProject} = require('../src/main/project-lookup');
    for (const id of [project,cra,run]) {
      const r = await lookupProject(id); console.log(JSON.stringify({id,projects:r.projects,runs:r.runs.length,files:r.files.length,access:r.access,officialUrl:r.officialUrl,message:r.message}));
      assert.equal(new URL(r.officialUrl).origin,root);
    }
  }
}
main().catch(error=>{console.error(error); process.exitCode=1;});
