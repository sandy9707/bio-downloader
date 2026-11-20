'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {lookupProject} = require('../src/main/project-lookup');

const mock = fn => async (url, config) => ({data:await fn(new URL(url), config)});
const lists = (rows, count=rows.length) => mock(url => url.pathname.endsWith('/count') ? {count:String(count)} : rows);
const study = {secondary_study_accession:'SRP123',study_accession:'PRJNA9',run_accession:'SRR1'};
const ena = 'ftp.sra.ebi.ac.uk/vol1/fastq/SRR1';
const human = 'https://ngdc.cncb.ac.cn/gsa-human/browse/';
const projectPage = (mode, html='') => `<html><h1>HRA123</h1><table><tr><th>Access type</th><td>${mode}</td></tr></table>${html}</html>`;
const index = (path, rows) => `<html><title>Index of ${path}</title><h1>Index of ${path}</h1><pre>${rows.map(([name, size]) => `<a href="${name}">${name}</a> 08-Jul-2025 10:07 ${size}\n`).join('')}</pre></html>`;

test('exact Study and submission queries, aligned bytes and checksums', async () => {
  for (const [id,field] of [['SRP123','secondary_study_accession'],['ERP123','secondary_study_accession'],['DRP123','secondary_study_accession'],['DRA123','submission_accession']]) {
    const get = mock(url => {
      assert.equal(url.searchParams.get('query'), `${field}="${id}"`);
      return url.pathname.endsWith('/count') ? {count:1} : [{...study,[field]:id,fastq_ftp:`${ena}/1.fq.gz;${ena}/2.fq.gz`,fastq_bytes:'123;456',fastq_md5:'a'.repeat(32)+';'+'b'.repeat(32)}];
    });
    const result = await lookupProject(id.toLowerCase(), {get});
    assert.deepEqual(result.runs,['SRR1']); assert.deepEqual(result.projects,['PRJNA9']);
    assert.deepEqual(result.files.map(f=>f.size),[123,456]); assert.equal(result.files[1].md5,'b'.repeat(32));
    assert.equal(result.files[0].format,'fastq');
  }
});
test('truncation, unrelated Run and unofficial file host rejected', async () => {
  await assert.rejects(lookupProject('SRP123',{get:lists([study],4)}), /计数/);
  await assert.rejects(lookupProject('SRP122',{get:lists([study])}), /归属/);
  await assert.rejects(lookupProject('SRP123',{get:lists([{...study,fastq_ftp:'foreign/vol1/fastq/file.fq.gz'}])}), /地址/);
});
test('SRA-only Run returns official SDL object and keeps its format', async () => {
  const link = 'https://sra-pub-run-odp.s3.amazonaws.com/sra/SRR1/SRR1';
  const get = mock(url => url.hostname.startsWith('locate.') ? {result:[{bundle:'SRR1',status:200,files:[{accession:'SRR1',type:'sra',locations:[{link}],size:12}]}]} : url.pathname.endsWith('/count') ? {count:'1'} : [study]);
  const r = await lookupProject('SRP123',{get});
  assert.deepEqual(r.files.map(f=>[f.name,f.url,f.format]),[['SRR1.sra',link,'sra']]);
});
test('published GSA-Human control identifies the verified project and its official application', async () => {
  const html = `<html><input id="idacc" value="HRA000123"><div class="col-md-2"><b>访问方式：</b></div><div>受控访问 <a href="request/HRA000123">申请</a></div></html>`;
  const get = mock(url => { assert.equal(url.href,human+'HRA000123'); return html; });
  const result = await lookupProject('HRA000123',{get});
  assert.equal(result.access,'controlled'); assert.deepEqual(result.files,[]); assert.match(result.applicationUrl,/request\/HRA000123$/);
});
test('controlled project never visits directories and offers official application', async () => {
  const get = mock(url => { assert.equal(url.href,human+'HRA123'); return projectPage('Controlled Access', '<a href="/gsa-human/apply/HRA123">Apply</a>'); });
  const result = await lookupProject('HRA123',{get});
  assert.equal(result.access,'controlled'); assert.equal(result.applicationUrl, 'https://ngdc.cncb.ac.cn/gsa-human/apply/HRA123'); assert.deepEqual(result.files,[]);
});
test('HRR relates to the published project, restricts files to that Run, and pairs identical object paths', async () => {
  const path = '/gsa-human/HRA123/HRR2/r1.fq.gz';
  const get = mock(url => url.href===human+'HRA123' ? projectPage('Open Access','<a href="runDetail/HRR2">HRR2</a><a href="runDetail/HRR3">HRR3</a>') : `<html><a href="${human}HRA123">HRA123</a><a href="https://download.cncb.ac.cn${path}">A</a><a href="ftp://download.big.ac.cn${path}">B</a><a href="https://download.cncb.ac.cn/gsa-human/HRA124/HRR2/x.fq.gz">wrong project</a></html>`);
  const r = await lookupProject('HRR2',{get});
  assert.deepEqual(r.projects,['HRA123']); assert.deepEqual(r.runs,['HRR2']); assert.equal(r.files.length,1); assert.equal(r.files[0].alternatives.length,1);
});
test('file index returns only entries published beneath the exact project/run path', async () => {
  const base = '/gsa-human/HRA123/';
  const get = mock(url => {
    if (url.hostname.startsWith('ngdc.')) return '<title>SecurityCheck</title>';
    if (url.pathname===base) return index(base,[['HRR2/','-'],['../','-']]);
    return index(base+'HRR2/',[['R1.fq.gz',110],['R2.fastq.gz',120],['else.xml',90],['../other.fastq.gz',10]]);
  });
  const r = await lookupProject('HRA123',{get});
  assert.deepEqual(r.files.map(f=>f.size),[110,120]); assert.equal(r.access,'public'); assert.equal(r.files[0].alternatives.length,0);
});
test('transient index failure retries once, cached HRR membership is revalidated online', async () => {
  const path = '/gsa-human/HRA789/', run = 'HRR789';
  let requests = 0;
  const get = mock(url => {
    if (url.hostname.startsWith('ngdc.')) return '<title>SecurityCheck</title>';
    if (url.pathname === path) return index(path, [[`${run}/`,'-']]);
    if (!requests++) throw new Error('temporary disconnect');
    return index(path+run+'/', [['read.fq.gz',12]]);
  });
  assert.equal((await lookupProject('HRA789',{get})).files.length,1);
  const answer = await lookupProject(run,{get});
  assert.deepEqual(answer.projects,['HRA789']); assert.deepEqual(answer.runs,[run]); assert.equal(requests,3);
  const restricted = await lookupProject(run, {get:mock(url => url.pathname.endsWith(run) ? '<title>SecurityCheck</title>' : projectPage('Controlled Access').replace('HRA123','HRA789'))});
  assert.equal(restricted.access,'controlled'); assert.equal(restricted.files.length,0);
});
test('HIR has its own official guidance, and an ambiguous access record yields no downloads', async () => {
  const r = await lookupProject('HIR222',{get:()=>assert.fail('unexpected request')});
  assert.equal(r.access,'unknown'); assert.equal(r.accession,'HIR222');
  const p = await lookupProject('HRA123',{get:mock(()=>projectPage('Pending'))});
  assert.equal(p.files.length,0); assert.equal(p.access,'unknown');
});
