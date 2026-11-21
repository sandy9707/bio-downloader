'use strict';
// --all runs the offline project/shortcut gates. --live reads public metadata
// and checks the original 101 MB EBI object through the real size-check IPC.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {lookupProject} = require('../src/main/project-lookup');
const {workbookRows} = require('../src/main/project-lookup-workbook');
const {load} = require('cheerio');
const test = require('node:test');
const hra = 'HRA006275', run = 'HRR1476867';
const site = 'https://ngdc.cncb.ac.cn/gsa-human/', project = site+'browse/'+hra;
const prefix = `/gsa-human/${hra}/`, archive = 'https://download.cncb.ac.cn'+prefix;
const names = [`${run}_f1.fq.gz`, `${run}_r2.fq.gz`];
const md5 = ['2a7750a8a521d75f64d940d3cf32e7f1','6e2e818777ea8781679255be75fca57b'];
const fixture = file => fs.readFileSync(path.join(__dirname,'fixtures/project-lookup',file));
const challenge = '<html><title>SecurityCheck</title><body>Verifying your browser</body></html>';
const landing = (access, id=hra) => `<html><input id="idacc" value="${id}"><div class="col-md-2"><b>Data Accessibility:</b></div><div>${access}</div><div class="panel"><div class="panel-heading">Dataset Download</div><a href="https://download.cncb.ac.cn/gsa-human/${id}">HTTPS</a></div></html>`;
const index = (prefix, names) => `<html><title>Index of ${prefix}</title><h1>Index of ${prefix}</h1><pre>${names.map(name=>`<a href="${name}">${name}</a> 21-Nov-2026 10:31 128\n`).join('')}</pre></html>`;
const get = fn => async (url,options)=>({status:200,data:await fn(new URL(url),options)});
const ftp = name => `ftp://download.big.ac.cn${prefix}${run}/${name}`;
function rows(url, files) {
  const pageNo = Number(url.searchParams.get('pageNo')), pageSize = Number(url.searchParams.get('pageSize'));
  return {accession:hra,pageNo,pageSize,totalCount:files.length,runViews:files.slice((pageNo-1)*pageSize,pageNo*pageSize).map(f=>({runAcc:f.run,runFileName:f.name,studyAcc:hra}))};
}
function isolatedMain() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'biodl-lookup-'));
  process.env.BIODL_DATA_DIR = root;
  process.env.BIODL_HEADLESS = '1';
  const main = require('../main');
  return {ipc:main.callIpcHandler, close() {
    if (path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('biodl-lookup-')) fs.rmSync(root,{recursive:true,force:true});
  }};
}
function offline() {
  test('challenge, wrong project, HTTP denial and ambiguous access never enter the archive', async () => {
    const wrong = 'HRA000199';
    const policy = ['pending', 'controlled', 'challenge', 'other project', 'unbound heading', 'HTTP 403', 'HTTP 429', 'HTTP 503'];
    for (const state of policy) {
      const calls = [];
      const response = await lookupProject(wrong,{get:get(url=>{
        calls.push(url.href);
        if (url.pathname.endsWith('downLoadFilterFiles')) return fixture('open-catalogue.xlsx'); // HRA006275 only
        assert.equal(url.href,site+'browse/'+wrong);
        if (state === 'challenge') return challenge;
        if (state === 'other project') return landing('Open access',hra);
        if (state === 'unbound heading') return `<html><h1>${wrong}</h1><table><tr><th>Access type</th><td>Open access</td></tr></table></html>`;
        if (state.startsWith('HTTP')) throw Object.assign(Error(state),{response:{status:Number(state.slice(5))}});
        if (state === 'controlled') return landing(`Controlled access <a href="request/${wrong}">Request</a>`,wrong);
        return landing('Pending',wrong);
      })});
      assert.equal(response.access,state === 'controlled' ? 'controlled' : 'unknown',state);
      assert.deepEqual(response.files,[]); assert.deepEqual(calls,[site+'browse/'+wrong],state);
      if (state === 'controlled') assert.equal(response.applicationUrl,site+'request/'+wrong);
    }
  });
  test('network timeout, exact Open catalogue and published manifest retain 22/44 without a challenge', async () => {
    const list = Array.from({length:22},(_,i)=>`HRR${1476867+i}`);
    const entries = list.flatMap(run=>['f1','r2'].map(mate=>({run,name:`${run}_${mate}.fq.gz`})));
    let accessConfirmed = false, runDetailCalls = 0, heads = 0;
    const result = await lookupProject(hra,{get:get((url,config)=>{
      if (config.method === 'HEAD') heads++;
      if (url.href === project) throw Object.assign(Error('network timeout'),{code:'ETIMEDOUT'});
      if (url.href === site+'file/downLoadFilterFiles') {
        assert.equal(config.method,'POST');
        const filters = new URLSearchParams(config.data);
        assert.deepEqual([filters.get('accession'),filters.get('status'),filters.get('tab')],[hra,'3','1']);
        accessConfirmed=true; return fixture('open-catalogue.xlsx');
      }
      assert.equal(accessConfirmed,true);
      if (url.pathname.endsWith('/runinstudy')) return rows(url,entries);
      if (url.pathname.includes('/runDetail/')) { runDetailCalls++; throw Object.assign(Error('network timeout'),{code:'ETIMEDOUT'}); }
      if (url.href === archive) return index(prefix,[...list.map(id=>id+'/'),'md5sum.txt']);
      if (url.href === archive+'md5sum.txt') return entries.map(({run,name},i)=>`${md5[i%2]}  /${hra}/${run}/${name}`).join('\n');
      const directory = url.href.slice(archive.length).replace(/\/$/,'');
      assert.ok(list.includes(directory)); return index(prefix+directory+'/', entries.filter(f=>f.run===directory).map(f=>f.name));
    })});
    assert.equal(runDetailCalls,1); assert.equal(result.access,'public',result.message);
    assert.equal(result.runs.length,22); assert.equal(result.files.length,44);
    assert.equal(result.files.every(f=>f.md5 && !f.alternatives.length && f.url.endsWith('/'+f.run+'/'+f.name)),true);
    assert.equal(result.partial,true); assert.match(result.message,/详情/); assert.equal(result.files.filter(f=>f.size===128).length,44); assert.equal(heads,0);
  });
  test('44-file manifest returns before any object HEAD or source probe; candidates remain pending', async () => {
    const {createProjectService} = require('../packages/cli/project-sources');
    const list = Array.from({length:22},(_,i)=>`HRR${1476867+i}`);
    const all = list.flatMap(run=>['f1','r2'].map(mate=>({run,name:`${run}_${mate}.fq.gz`})));
    let heads = 0, probes = 0, releaseHead;
    const blocker = new Promise(resolve => { releaseHead = resolve; });
    const service = createProjectService(id => lookupProject(id,{get:async (raw,options)=>{
      if (options.method === 'HEAD') { heads++; return blocker; }
      const url = new URL(raw);
      let data;
      if (raw === project) data = landing('Open access');
      else if (url.pathname.endsWith('/runinstudy')) data = rows(url,all);
      else if (url.pathname.includes('/runDetail/')) throw Object.assign(Error('detail unavailable'),{response:{status:404}});
      else if (raw === archive) data = index(prefix,[...list.map(id=>id+'/'),'md5sum.txt']);
      else if (raw === archive+'md5sum.txt') data = all.map(f=>`${md5[0]}  /${hra}/${f.run}/${f.name}`).join('\n');
      else {
        const id = raw.slice(archive.length,-1);
        assert.ok(list.includes(id));
        data = index(prefix+id+'/',all.filter(f=>f.run===id).map(f=>f.name)).replaceAll(' 128\n',' -\n');
      }
      return {status:200,data};
    }}), {get:async()=>{ probes++; throw Error('not queried'); },ftp:async()=>{ probes++; throw Error('not queried'); }});
    const query = service.query(hra);
    let timer;
    try {
      const result = await Promise.race([query,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('manifest blocked behind object HEAD')),100);})]);
      assert.equal(result.access,'public'); assert.equal(result.runs.length,22); assert.equal(result.matrixFiles.length,44);
      assert.equal(heads,0); assert.equal(probes,0);
      for (const file of result.matrixFiles) {
        assert.equal(file.size,0); assert.equal(file.md5,md5[0]);
        assert.equal(file.candidateSources.length,1);
        assert.equal(file.candidateSources[0].url,file.url);
        assert.equal(file.candidateSources[0].pending,true);
        assert.equal(file.candidateSources[0].available,false);
      }
    } finally {
      clearTimeout(timer);
      releaseHead({status:200,headers:{'content-length':'128'}});
      await query;
    }
  });
  test('explicit challenge or denial is terminal at every GSA-Human endpoint and discards earlier files', async () => {
    const ids = [run,'HRR1476868'];
    const all = ids.flatMap(id=>['f1','r2'].map(m=>({run:id,name:`${id}_${m}.fq.gz`})));
    const endpoints = ['landing','catalogue','table','detail-1','detail-2','archive','manifest','directory-1','directory-2','workbook'];
    const withWorkbook = landing('Open access').replace('</html>', `<a id="csvHumanFile_open" onclick="downHumanExcel('/public/human/${hra}/${hra}.xlsx')">${hra}.xlsx</a><script>var study_id='42'; var requestFlag='0'; var link='/gsa-human/file/exportExcelFile?fileName=';</script></html>`);
    for (const endpoint of endpoints) for (const failure of ['challenge',401,403,429]) {
      const calls = []; let stopIndex;
      const res = await lookupProject(hra,{get:async (raw,options)=>{
        const url = new URL(raw);
        let route, data;
        if (raw===project) { route='landing'; data=withWorkbook; }
        else if (url.pathname.endsWith('downLoadFilterFiles')) { route='catalogue'; data=fixture('open-catalogue.xlsx'); }
        else if (url.pathname.endsWith('runinstudy')) { route='table'; data=rows(url,all); }
        else if (url.pathname.includes('/runDetail/')) {
          const id = url.pathname.split('/').at(-1);
          route='detail-'+(ids.indexOf(id)+1);
          const group = all.filter(f=>f.run===id);
          data=`<html><ol class="breadcrumb"><li><a href="${project}">${hra}</a></li><li class="active">${id}</li></ol><table><tr><th>Archived file name</th><th>Download</th></tr>${group.map(f=>`<tr><td>${f.name}</td><td><a href="${archive}${id}/${f.name}">HTTPS</a></td></tr>`).join('')}</table></html>`;
        } else if (raw===archive) { route='archive'; data=index(prefix,[...ids.map(id=>id+'/'),'md5sum.txt']); }
        else if (raw===archive+'md5sum.txt') { route='manifest'; data=all.map(f=>`${md5[0]}  /${hra}/${f.run}/${f.name}`).join('\n'); }
        else if (raw.endsWith('/') && raw.startsWith(archive)) {
          const id=raw.slice(archive.length,-1); route='directory-'+(ids.indexOf(id)+1);
          data=index(prefix+id+'/',all.filter(f=>f.run===id).map(f=>f.name)).replaceAll(' 128\n',' -\n');
        } else if (url.pathname.endsWith('exportExcelFile')) { route='workbook'; data=fixture('one-run-metadata.xlsx'); }
        else if (options.method==='HEAD') { route='HEAD'; }
        else route='unexpected';
        calls.push(route);
        if (route===endpoint) {
          stopIndex ??= calls.length;
          if (failure==='challenge') {
            if (route==='HEAD') return {status:200,headers:{'content-type':'text/html'}};
            if (route==='table') return {data:{code:'verification_required',message:'verify your browser'}};
            return {data:['catalogue','workbook'].includes(route) ? Buffer.from(challenge) : challenge};
          }
          return {status:failure,data:'access restricted'};
        }
        if (endpoint==='catalogue' && route==='landing') throw Object.assign(Error('transport timeout'),{code:'ETIMEDOUT'});
        return {status:200,data,headers:{'content-length':'128','content-type':'application/octet-stream'}};
      }});
      const label=endpoint+' '+failure;
      assert.ok(stopIndex,label); assert.equal(calls.length,stopIndex,label+' continued: '+calls);
      assert.equal(res.providerBlocked,true,label); assert.equal(res.access,'unknown',label);
      assert.deepEqual(res.files,[],label); assert.deepEqual(res.runs,[],label); assert.equal(res.officialUrl,project,label); assert.match(res.message,/重试/);
    }
  });
  test('a transient directory failure retains published candidates with unknown size without object HEAD', async () => {
    const url = archive+run+'/'+names[0], heads = [];
    const result = await lookupProject(hra,{get:async (raw,options)=>{
      if (options.method === 'HEAD') {
        heads.push(raw); assert.equal(raw,url); assert.equal(options.maxRedirects,0);
        return {status:200, headers:{'content-type':'application/octet-stream','content-length':'16276644395'}};
      }
      if (raw === project) return {data:landing('Open access')};
      if (raw.includes('/runinstudy?')) return {data:rows(new URL(raw),[{run,name:names[0]}])};
      if (raw === archive) throw Error('connection closed');
      assert.equal(raw,site+'browse/runDetail/'+run);
      return {data:`<html><ol class="breadcrumb"><li><a href="${project}">${hra}</a></li><li class="active">${run}</li></ol><table><tr><th>Archived file name</th><th>Download</th></tr><tr><td>${names[0]}</td><td><a href="${url}">HTTPS</a></td></tr></table></html>`};
    }});
    assert.deepEqual(heads,[]); assert.equal(result.files[0].size,0); assert.match(result.message,/MD5 0\/1/);
  });
  test('published workbook R2 digest stays with R2 while the mislabelled R1 FTP cannot be used for R2', async () => {
    const workbook = fixture('one-run-metadata.xlsx');
    const [[header,r]] = workbookRows(workbook,load);
    assert.equal(r[header.indexOf('DownLoad Read file2')],ftp(names[0]));
    const res = await lookupProject(hra,{workbook,get:get(url=>{
      if (url.href === project) return landing('Open access');
      if (url.pathname.endsWith('/runinstudy')) return rows(url,names.map(name=>({run,name})));
      if (url.pathname.endsWith(run)) return `<html><base href="/gsa-human/"><ol class="breadcrumb"><li><a href="browse/${hra}">${hra}</a></li><li class="active">${run}</li></ol><table><tr><th>Archived file name</th><th>Download</th></tr>${names.map(name=>`<tr><td>${name}</td><td><a href="${archive}${run}/${name}">HTTPS</a><a href="${ftp(names[0])}">FTP</a></td></tr>`).join('')}</table></html>`;
      if (url.href === archive) return index(prefix,[run+'/']);
      assert.equal(url.href,archive+run+'/'); return index(prefix+run+'/',names);
    })});
    assert.equal(res.access,'public',res.message); assert.deepEqual(res.files.map(f=>[f.name,f.md5,f.alternatives]),[[names[0],md5[0],[ftp(names[0])]],[names[1],md5[1],[]]]);
  });
  test('HRA Run table missing page stops with acquired/expected, partial mate is never labelled complete', async () => {
    const incomplete = await lookupProject(hra,{get:get(url=>url.href===project ? landing('Open access') : {...rows(url,[{run,name:names[0]}]),totalCount:44})});
    assert.deepEqual(incomplete.files,[]); assert.match(incomplete.message,/1\/44/);
    const partial = await lookupProject(hra,{get:get(url=>{
      if (url.href === project) return landing('Open access');
      if (url.pathname.endsWith('/runinstudy')) return rows(url,names.map(name=>({run,name})));
      if (url.pathname.endsWith(run)) throw Object.assign(Error('network timeout'),{code:'ETIMEDOUT'});
      if (url.href===archive) return index(prefix,[run+'/']);
      return index(prefix+run+'/',[names[0]]);
    })});
    assert.equal(partial.partial,true); assert.match(partial.message,/缺端/); assert.match(partial.message,/1\/2/);
  });
  test('single Run / Study never expands parents; all parent choices, PRJDA and paired completeness', async () => {
    const info = {run_accession:'DRR1',study_accession:'PRJDA2;PRJDB3',secondary_study_accession:'DRP1',library_layout:'PAIRED',fastq_ftp:'ftp.sra.ebi.ac.uk/vol1/fastq/DRR000/DRR1/DRR1_1.fastq.gz'};
    for (const [id,field] of [['DRR1','run_accession'],['DRP1','secondary_study_accession'],['PRJDA2','study_accession']]) {
      const result = await lookupProject(id,{get:get(url=>{
        assert.equal(url.searchParams.get('query'),`${field}="${id}"`);
        return url.pathname.endsWith('/count') ? {count:1} : [info];
      })});
      assert.deepEqual(result.projects,['PRJDA2','PRJDB3']); assert.deepEqual(result.runs,['DRR1']); assert.equal(result.partial,true); assert.match(result.message,/缺端/);
    }
  });
  test('old EBI/ENA IPC rejects empty, failed or unrelated rows and keeps the exact positive EBI object', async t => {
    const {ipc, close} = isolatedMain(); t.after(close);
    const axios = require('axios'), head = axios.head, oldGet = axios.get;
    const unexpected = [];
    axios.head = async url => { unexpected.push(url); return {headers:{'content-length':230}}; };
    t.after(()=>{ axios.head = head; axios.get = oldGet; });
    const report = (run, name) => [{run_accession:run, fastq_ftp:`ftp.sra.ebi.ac.uk/vol1/fastq/${run.slice(0,6)}/${run}/${name}`,fastq_bytes:'101304405',fastq_md5:'a04ed1f37028cda9486eec9726237796'}];
    axios.get = async url => {
      const acc = new URL(url).searchParams.get('accession');
      assert.equal(new URL(url).hostname,'www.ebi.ac.uk');
      if (acc === 'SRR1') return {data:[]};
      if (acc === 'SRR2' || acc === 'ERR1') throw Object.assign(Error('503'),{response:{status:503}});
      if (acc === 'DRR1') return {data:report('DRR2','DRR2_1.fastq.gz')};
      assert.equal(acc,'SRR390728'); return {data:report(acc,`${acc}_1.fastq.gz`)};
    };
    for (const id of ['SRR1','SRR2','ERR1','DRR1']) await assert.rejects(ipc('check-download-size',{type:id==='SRR1'?'ebi_raw':'ena_raw',inputVal:id}),/重试.*明确改选 SRA/);
    const [file] = await ipc('check-download-size',{type:'ebi_raw',inputVal:'SRR390728'});
    assert.deepEqual(unexpected,[]); assert.equal(file.size,101304405); assert.equal(file.md5,'a04ed1f37028cda9486eec9726237796');
    assert.equal(file.url,'http://ftp.sra.ebi.ac.uk/vol1/fastq/SRR390/SRR390728/SRR390728_1.fastq.gz');
  });
}
async function live() {
  const {ipc,close} = isolatedMain();
  const requireAllSizes = process.argv.includes('--require-all-sizes');
  const evidence = {command:'node scripts/check-project-lookup-release.js --live'+(requireAllSizes ? ' --require-all-sizes' : ''), startedAt:new Date().toISOString(),projects:[]};
  try {
    for (const id of [hra,'HRA014809',run,'CRR077958','SRP318499']) {
      const result = await ipc('query-bioproject',{project:id});
      evidence.projects.push({id,officialUrl:result.officialUrl,applicationUrl:result.applicationUrl,access:result.access,projects:result.projects,runs:result.runs,files:result.files.length,
        https:result.files.filter(f=>[f.url,...f.alternatives].some(u=>u.startsWith('https:'))).length,
        ftp:result.files.filter(f=>[f.url,...f.alternatives].some(u=>u.startsWith('ftp:'))).length,
        exactSizes:result.files.filter(f=>f.size>0).length,md5s:result.files.filter(f=>f.md5).length,bytes:result.files.reduce((n,f)=>n+f.size,0),partial:result.partial || false,message:result.message,
        providerBlocked:result.providerBlocked === true, protocolPathMismatches:result.files.filter(f=>f.alternatives.some(u=>new URL(u).pathname!==new URL(f.url).pathname)).length,firstFile:result.files[0]});
      if (result.providerBlocked) {
        assert.equal(result.access,'unknown'); assert.deepEqual(result.files,[]); assert.deepEqual(result.runs,[]);
        assert.ok(result.officialUrl); assert.match(result.message,/重试/);
        evidence.stoppedAt = id;
        throw Error(`${id} 官方验证或拒绝。验收已停止，未再请求其他入口。`);
      }
    }
    evidence.sample = await ipc('query-biosample',{biosample:'SAMN03174610'});
    const ebi = await ipc('check-download-size',{type:'ebi_raw',inputVal:'SRR390728'});
    evidence.ebi = ebi.find(f=>f.name==='SRR390728_1.fastq.gz');
    const [open,controlled,single,native,study] = evidence.projects;
    assert.equal(open.access,'public'); assert.equal(open.runs.length,22); assert.equal(open.files,44); assert.equal(open.md5s,44); assert.equal(open.protocolPathMismatches,0);
    evidence.allHraSizesVerified = open.exactSizes === 44;
    if (evidence.allHraSizesVerified) assert.equal(open.bytes,1096952434885);
    else {
      assert.equal(open.partial,true);
      assert.ok(open.message.includes(`精确大小 ${open.exactSizes}/44`));
      assert.ok(open.bytes < 1096952434885);
    }
    assert.equal(controlled.access,'controlled'); assert.equal(controlled.files,0); assert.equal(controlled.applicationUrl,site+'request/HRA014809');
    assert.deepEqual(single.runs,[run]); assert.equal(single.files,2); assert.equal(single.protocolPathMismatches,0);
    assert.deepEqual(native.runs,['CRR077958']); assert.equal(native.bytes,123301059); assert.equal(native.firstFile.md5,'bba9ba189c3846fb0aa93e99b863a97b');
    assert.deepEqual(study.projects,['PRJNA727404']); assert.deepEqual([...study.runs].sort(),Array.from({length:8},(_,i)=>`SRR${14424777+i}`));
    assert.deepEqual(evidence.sample.runs,['SRR1647790']); assert.equal(evidence.sample.expectedCount,1);
    assert.equal(evidence.ebi.size,101304405); assert.equal(evidence.ebi.md5,'a04ed1f37028cda9486eec9726237796'); assert.equal(new URL(evidence.ebi.url).protocol,'http:');
    evidence.queryContractPassed = true;
    if (requireAllSizes) assert.equal(open.exactSizes,44,'本次未取得全部 44 个文件的精确大小');
    evidence.passed = true;
  } catch (error) { evidence.error = error.message; process.exitCode = 1; }
  finally { close(); }
  evidence.finishedAt = new Date().toISOString();
  console.log(JSON.stringify(evidence,null,2));
}
if (process.argv.includes('--live')) live().catch(e=>{console.error(e);process.exitCode=1;});
else if (process.argv.includes('--all')) {
  const scripts = ['check-project-lookup.js','check-project-lookup-biosample.js','check-project-lookup-gsa.js','check-project-lookup-release.js'];
  const child = require('node:child_process').spawnSync(process.execPath,['--test',...scripts.map(file=>path.join(__dirname,file))],{stdio:'inherit'});
  process.exitCode = child.status ?? 1;
} else offline();
