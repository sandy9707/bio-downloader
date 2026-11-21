'use strict';
// Exercise the panel's actual controls and CLI command actions with isolated IPC.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { load } = require('cheerio');
const { Command } = require('commander');
const root = path.join(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const policy = require('../shared/project-source-policy');
const { createProjectService } = require('../packages/cli/project-sources');

const files = Array.from({ length: 12 }, (_, i) => {
  const run = `ERR${100 + i}`, name = `${run}_1.fastq.gz`;
  return { run, name, format: 'fastq', size: 64 + i, md5: 'a'.repeat(32), url: `https://ftp.sra.ebi.ac.uk/vol1/fastq/${run}/${name}` };
});
const cn = file => `https://download2.cncb.ac.cn/INSDC1/FASTQ/${file.run}/${file.name}`;
const ftp = file => file.url.replace('https:', 'ftp:');

function fixture() {
  const calls = [], unavailable = new Set();
  const lookup = async accession => ({ accession, projects: accession === 'SAMN2' ? ['PRJEB1', 'PRJEB2'] : ['PRJEB1', 'ERP77'],
    files, runs: files.map(f => f.run), access: accession === 'HRA9' ? 'controlled' : 'public',
    partial: accession === 'SAMN2', message: '官方消息', applicationUrl: accession === 'HRA9' ? 'https://example.test/application' : '' });
  const service = createProjectService(lookup);
  const probe = ({ page }) => (typeof page === 'object' ? page.indices : files.slice(10 * page, 10 * (page + 1)).map((_,i)=>10*page+i)).map(index => {
    const f = files[index];
    return { index, sources: f ? [[cn(f),25],[ftp(f),10],[f.url,5]].map(([url,latencyMs])=>({...f,url,latencyMs,available:!unavailable.has(url),reason:unavailable.has(url)?'源暂不可用':''})).filter(source => !page.column || require('../shared/project-view-model').columnFor(source.url) === page.column) : [] };
  });
  async function ipc(channel, args) {
    calls.push({ channel, args });
    if (channel === 'query-bioproject') return service.query(args.project);
    if (channel === 'probe-project-page') return args.page?.cancel ? [] : probe(args);
    throw Error('unexpected channel: ' + channel);
  }
  return { calls, unavailable, service, ipc };
}

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.value = ''; }
  set textContent(value) { this.children = [String(value)]; }
  get textContent() { return this.children.map(n => typeof n === 'string' ? n : n.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
}

function panel() {
  const f = fixture(), html = read('index.html'), $ = load(html);
  const elements = new Map();
  $('#bioProjectPanel').find('[id]').each((_, node) => {
    const el = new Element(node.name);
    el.value = $(node).val() || '';
    elements.set(node.attribs.id, el);
  });
  elements.set('totalQueueSize', new Element('span'));
  const el = id => elements.get(id);
  const initial = { name: 'user.fastq.gz', folder: 'other', url: 'https://example.test/user', size: 100 };
  const context = vm.createContext({ URL, document: { createElement: tag => new Element(tag), getElementById: el },
    window: { api: { queryBioProject: project => f.ipc('query-bioproject', { project }), probeProjectPage: (queryId, page) => f.ipc('probe-project-page', { queryId, page }), openExternalUrl() {} } },
    BioDownloadSources: require('../shared/download-sources'), BioProjectSources: policy,
    currentDownloadType: 'bioproject', currentQueue: [initial], isDownloading: false, renderQueue() {}, formatBytes: String, showToast() {} });
  vm.runInContext(read('shared/project-view-model.js'), context);
  vm.runInContext(read('shared/project-view-table.js'), context);
  const renderer = read('renderer.js');
  vm.runInContext(renderer.slice(renderer.indexOf('let projectView ='), renderer.indexOf('// BioSample 查询:')), context);
  const evaluate = code => vm.runInContext(code, context);
  const action = (selector, key = 'onclick') => {
    const code = $(selector).attr(key), id = $(selector).attr('id');
    assert.ok(code, `missing ${key} on ${selector}`);
    return vm.runInContext(`(function(){${key === 'onsubmit' ? '' : 'return '}${code}})`, context).call(el(id));
  };
  const query = async value => { el('bioProjectInput').value = value; return context.queryBioProject(); };
  const controls = index => {
    const row = el('bioProjectFiles').children[0].children[1].children[index];
    const item = evaluate(`projectView.files.get(BioProjectView.visible(projectView)[${index}].indices[0])`);
    const check = row.children[0].children[0].children[0];
    return { check, item, row };
  };
  const setManual = (index, url) => { controls(index).item.manual=url;context.renderProjectPage(evaluate('projectView')); };
  const setChecked = (index, checked) => { const {check}=controls(index);check.checked=checked;check.onchange(); };
  const setStrategy = strategy => { el('bioSourceStrategy').value = strategy; action('#bioSourceStrategy', 'onchange'); };
  return { ...f, $, el, context, evaluate, action, query, controls, setManual, setChecked, setStrategy, queue: context.currentQueue, initial };
}

test('query immediately exposes manifest then updates one file at a time',async()=>{
 const h=panel();const waiting=[];
 h.context.window.api.probeProjectPage=(_id,page)=>page.cancel?Promise.resolve([]):new Promise(resolve=>waiting.push({page,resolve}));
 const pending=h.query('ERP77');while(!waiting.length)await Promise.resolve();
 assert.equal(h.evaluate('projectView.rows.length'),12);assert.equal(h.el('bioProjectFiles').children[0].children[1].children.length,8);
 assert.equal(waiting[0].page.indices.length,1);
 waiting[0].resolve([{index:0,sources:[{...files[0],available:true,latencyMs:5}]}]);
 while(waiting.length<2)await Promise.resolve();
 assert.equal(h.controls(0).item.sources.length,1);assert.ok(h.controls(1).item.sources.every(source=>source.pending&&!source.available));
 assert.equal(waiting[1].page.indices.length,1);
 h.context.cancelProjectCheck();waiting[1].resolve([]);await pending;assert.equal(waiting.length,2);
});

test('pending manifest candidates stay unverified and strategy selects actual first-Run winner',async()=>{
 const M=require('../shared/project-view-model');
 const view=M.create({accession:'ERP1',runs:[files[0].run],files:[{...files[0],candidateSources:[{...files[0],available:true}]}]},new Map(),()=>null);
 assert.equal(view.files.get(0).sources[0].available,false);assert.equal(view.files.get(0).sources[0].pending,true);
 for(const [strategy,winner] of [['fastest','ena'],['domestic-first','cncb']]){
  const h=panel();h.el('bioSourceStrategy').value=strategy;await h.query('ERP77');
  assert.equal(h.evaluate('projectView.recommended'),winner);
  const calls=h.calls.filter(call=>call.channel==='probe-project-page');
  assert.ok(calls.filter(call=>call.args.page.column).every(call=>call.args.page.column===winner));
 }
});

test('query form directly precedes selection and table; column actions belong to footer',async()=>{
 const h=panel();const form=h.$('#bioProjectPanel form');
 assert.equal(form.next().attr('id'),'bioProjectAdoptActions');
 assert.equal(h.$('#bioProjectAdoptActions').next().attr('id'),'bioProjectFiles');
 assert.match(read('index.html'),/>BioDownloader Pro<\/span>/);
 await h.query('ERP77');await h.context.showProjectPage(1);
 const table=h.el('bioProjectFiles').children[0],foot=table.children.at(-1);
 assert.equal(foot.tag,'tfoot');assert.equal(table.children[0].children.length,1);
 for(const cell of foot.children[0].children.slice(1))assert.equal(cell.children.filter(n=>n.tag==='button').length,2);
 const check=foot.children[0].children[1].children.find(n=>n.tag==='button'&&n.textContent==='校验全部');
 const before=h.calls.length;await check.onclick();
 const indices=h.calls.slice(before).flatMap(call=>call.args?.page?.indices||[]);
 assert.equal(new Set(indices).size,h.evaluate('projectView.files.size'));
});

test('desktop and Linux panel share wired controls, per-file strategy, cross-page selection and rename-safe append', async () => {
  const h = panel();
  const panelHtml = page => load(page)('#bioProjectPanel').html();
  assert.equal(panelHtml(read('packages/web/index.html')), panelHtml(read('index.html')));
  assert.ok(h.$('#bioProjectPanel script[src="shared/project-source-policy.js"]').length);
  for (const bridge of ['preload.js', 'packages/web/web-bridge.js']) assert.match(read(bridge), /probeProjectPage:.*probe-project-page/);
  assert.equal(h.el('bioSourceStrategy').value, 'fastest');
  await h.query('erp77');
  assert.equal(h.el('bioProjectFiles').children[0].children[1].children.length, 8);
  assert.equal(h.context.projectChoice(h.controls(0).item).source.url,files[0].url);
  h.setManual(0, ftp(files[0]));
  h.setChecked(1, false);
  await h.action('#bioNext');
  await h.context.checkProjectColumn('cncb',false);
  h.setStrategy('domestic-first');
  assert.equal(h.context.projectChoice(h.controls(0).item).source.url,cn(files[8]));
  assert.match(h.el('bioSelectedCount').textContent, /11 \/ 12 个/);
  h.action('#bioAdopt');
  assert.equal(h.queue.length, 12);
  assert.equal(h.queue[0], h.initial);
  assert.equal(h.queue[1].url, ftp(files[0]));
  assert.equal(h.queue[1].sourceSelection, 'manual');
  assert.equal(h.queue[1].transport, 'ftp');
  assert.equal(h.queue[1].project, 'PRJEB1');
  assert.equal(h.queue[1].md5, files[0].md5);
  assert.equal(h.queue[2].url, cn(files[2]));
  assert.ok(!h.queue.some(task => task.run === files[1].run));
  const renamed = h.queue[1]; renamed.name = 'local-name.fq.gz';
  const probeCount=h.calls.filter(x=>x.channel==='probe-project-page').length;
  await h.action('#bioPrev');
  assert.equal(h.calls.filter(x => x.channel === 'probe-project-page').length, probeCount, 'returning to a measured page uses stored results');
  assert.equal(h.controls(0).item.manual, ftp(files[0]));
  assert.equal(h.controls(1).check.checked, false);
  h.setStrategy('fastest');
  h.setManual(0, '');
  h.action('#bioAdopt');
  assert.equal(h.queue.length, 12);
  assert.equal(h.queue[1], renamed);
  assert.deepEqual([renamed.sourceName, renamed.name, renamed.url], [files[0].name, 'local-name.fq.gz', files[0].url]);
  assert.equal(h.queue.at(-1).url, files.at(-1).url, 'strategy changes apply to automatic off-page selections');
  await h.query('PRJEB1');
  h.setChecked(1, false);
  h.action('#bioAdopt');
  assert.equal(h.queue.length, 12, 'same Run files reached from another accession keep their queue identity');
});

test('manual choices survive re-querying the same Run file via a related project', async () => {
  const h = panel(); await h.query('ERP77');
  h.setManual(0, ftp(files[0])); h.setChecked(1, false);
  await h.query('ERP77');
  assert.equal(h.controls(0).item.manual, ftp(files[0]));
  assert.equal(h.controls(1).check.checked, false);
  await h.context.showProjectPage(1); h.action('#bioAdopt'); await h.query('PRJEB1');
  assert.equal(h.controls(0).item.manual, ftp(files[0]));
  h.action('#bioAdopt'); assert.equal(h.queue[1].url, ftp(files[0]));
});

test('remeasure retains a failed manual choice until the user actively changes it', async () => {
  const h = panel(); await h.query('ERP77');
  h.setManual(0, ftp(files[0]));
  h.unavailable.add(ftp(files[0]));
  await h.action('#bioProjectAdoptActions button:contains("重测")');
  assert.equal(h.controls(0).item.manual, ftp(files[0]));
  assert.match(h.context.projectChoice(h.controls(0).item).reason, /手选来源/);
  assert.equal(h.context.projectChoice(h.controls(0).item).source, null);
  h.context.adoptBioProjectRuns(); assert.equal(h.queue.length, 1);
  h.setManual(0, ''); await h.context.showProjectPage(1); h.action('#bioAdopt');
  assert.equal(h.queue[1].url, files[0].url);
});

test('narrow scopes remain visible and multi-parent results wait for explicit parent navigation', async () => {
  const h = panel(); await h.query('SAMN2');
  assert.match(h.el('bioProjectResult').textContent, /SAMN2.*部分结果/);
  assert.equal(h.calls.filter(x => x.channel === 'probe-project-page').length, 0);
  assert.equal(h.evaluate('projectView'), null);
  const multi = await h.service.query('SAMN2');
  await assert.rejects(h.service.probe({ queryId: multi.queryId }), /范围/);
  const buttons = h.el('bioProjectResult').children.filter(child => child.tag === 'button');
  assert.deepEqual(buttons.map(b => b.textContent), ['查询 PRJEB1', '查询 PRJEB2']);
  await buttons[0].onclick();
  assert.match(h.el('bioProjectResult').title, /PRJEB1/);
  await h.query('HRA9');
  assert.equal(h.evaluate('projectView'), null);
  assert.equal(h.el('bioProjectAdoptActions').style.display, 'none');
  assert.match(h.el('bioProjectResult').textContent, /访问申请/);
  await assert.rejects(h.service.probe({ queryId: 'https://unknown.example' }));
});

test('late query and probe replies cannot replace the current scope or revive old selections', async () => {
  const h = panel(); const api = h.context.window.api;
  let resolveQuery, resolvePage;
  const query = api.queryBioProject;
  api.queryBioProject = () => new Promise(resolve => { resolveQuery = resolve; });
  const old = h.query('PRJEB1');
  h.context.resetProjectView(); resolveQuery(await query('PRJEB1')); await old;
  assert.equal(h.evaluate('projectView'), null);
  api.queryBioProject = query;
  await h.query('ERP77');
  api.probeProjectPage = (_id, page) => page?.cancel ? Promise.resolve([]) : new Promise(resolve => { resolvePage = resolve; });
  const page = h.context.showProjectPage(1, true);
  await h.query('HRA9'); resolvePage([]); await page;
  assert.equal(h.evaluate('projectView'), null);
  assert.equal(h.queue.length, 1);
});

test('clear/page/invert are independent of probes and cancellation discards late results', async () => {
  const h = panel(); await h.query('ERP77');
  h.context.selectProjectRows('none');
  assert.equal(h.el('bioAdopt').disabled, true);
  await h.context.showProjectPage(1);
  assert.equal(h.evaluate('BioProjectView.selected(projectView).length'), 0);
  h.context.selectProjectRows('page');
  assert.equal(h.evaluate('BioProjectView.selected(projectView).length'), 4);
  h.context.selectProjectRows('invert');
  assert.equal(h.evaluate('BioProjectView.selected(projectView).length'), 0);
  let resolve;
  const original = h.context.window.api.probeProjectPage;
  h.context.window.api.probeProjectPage = (id, page) => page.cancel ? original(id,page) : new Promise(done => { resolve=done; });
  const pending = h.context.checkProjectColumn('ena', false);
  h.context.cancelProjectCheck(); resolve([]); await pending;
  assert.equal(h.evaluate('projectView.loading'), false);
  assert.equal(h.evaluate('BioProjectView.selected(projectView).length'), 0);
  assert.ok(h.calls.some(call => call.args.page?.cancel));
});

test('HRA 44-file table adopts only the selected HTTPS or FTP identity including R2', async () => {
  const h = panel();
  const hra = Array.from({length:44},(_,i)=>{
    const run=`HRR${100+Math.floor(i/2)}`,name=`${run}_${i%2+1}.fastq.gz`;
    return {run,name,format:'fastq',size:100+i,md5:'b'.repeat(32),url:`https://download.cncb.ac.cn/${run}/${name}`};
  });
  h.context.window.api.queryBioProject=async()=>({accession:'HRA1',access:'public',runs:[...new Set(hra.map(f=>f.run))],files:hra,pageSize:10,queryId:'hra'});
  h.context.window.api.probeProjectPage=async(_id,page)=>page.cancel?[]:page.indices.map(index=>({index,sources:['https','ftp'].filter(p=>!page.column||p===page.column).map(protocol=>({...hra[index],url:hra[index].url.replace('https:',protocol+':'),latencyMs:protocol==='https'?5:10,available:true}))}));
  await h.query('HRA1');
  assert.equal(h.evaluate('projectView.rows.length'),44);
  const captions=node=>[node.textContent,...(node.children||[]).flatMap(captions)];
  const labels=captions(h.el('bioProjectFiles'));
  assert.ok(labels.some(text=>text?.includes('FASTQ · R1')));
  assert.ok(labels.some(text=>text?.includes('FASTQ · R2')));
  assert.equal(h.evaluate('BioProjectView.selected(projectView).length'),44);
  h.context.adoptBioProjectRuns();
  assert.equal(h.queue.length,45,'default HTTPS verifies all 44 files without browsing');
  h.queue.splice(1);
  await h.context.checkProjectColumn('ftp',false);
  h.setChecked(1,false);await h.context.showProjectPage(4);
  h.context.adoptBioProjectRuns('ftp');
  assert.equal(h.queue.length,44);
  assert.ok(h.queue.slice(1).every(task=>task.transport==='ftp'&&task.md5==='b'.repeat(32)));
  assert.ok(!h.queue.some(task=>task.sourceName===hra[1].name));
  assert.equal(h.queue.find(task=>task.sourceName===hra[3].name).url,hra[3].url.replace('https:','ftp:'));
  await h.context.showProjectPage(0);assert.equal(h.controls(1).check.checked,false);
});

test('default query verifies the recommended column across the project; browsing sends no probes', async () => {
  const h = panel(); await h.query('ERP77');
  assert.equal(h.evaluate('projectView.pageSize'),8);
  h.context.adoptBioProjectRuns();assert.equal(h.queue.length,13);
  const before=h.calls.length;
  await h.context.showProjectPage(1);await h.context.showProjectPage(0);
  assert.equal(h.calls.length,before);
  const summary=h.el('bioProjectResult').textContent;
  h.context.cancelProjectCheck();
  assert.equal(h.el('bioProjectResult').textContent,summary);
  await h.context.checkProjectColumn('ena',false);
  assert.doesNotMatch(h.el('bioProjectProgress').textContent,/已取消/);
});

test('53 Runs complete recommended ENA without browsing; failed first Run does not expand scan', async () => {
  const h=panel();const runs=Array.from({length:53},(_,i)=>'ERR'+(500+i));
  const manifest=runs.map(run=>({run,name:run+'.fastq.gz',format:'fastq',url:`https://ftp.sra.ebi.ac.uk/${run}.fastq.gz`,size:100}));
  h.context.window.api.queryBioProject=async()=>({accession:'ERP53',access:'public',runs,files:manifest,queryId:'53'});
  const probes=[];
  const reply=page=>page.indices.map(index=>({index,sources:[{...manifest[index],latencyMs:5,available:true}]}));
  h.context.window.api.probeProjectPage=async(_id,page)=>{probes.push(page);return page.cancel?[]:reply(page);};
  await h.query('ERP53');h.context.adoptBioProjectRuns();assert.equal(h.queue.length,54);
  assert.equal(probes.length,53);assert.ok(probes.slice(1).every(page=>page.column==='ena'));
  assert.match(h.el('bioProjectProgress').textContent,/可用 53，未通过 0，未核 0 Run/);
  const texts=node=>[node.textContent,...(node.children||[]).flatMap(texts)];
  h.evaluate("for (const [index,item] of projectView.files) if(index>0){item.checkedColumns.delete('ena');item.sources=[];} renderProjectPage(projectView)");
  const enaActions=h.el('bioProjectFiles').children[0].children[2].children[0].children[3];
  assert.ok(!texts(enaActions).includes('重试'),'successful first Run plus unverified rows must not offer failure retry');
  const before=probes.length;await h.context.showProjectPage(6);assert.equal(probes.length,before);
  probes.length=0;
  h.context.window.api.probeProjectPage=async(_id,page)=>{probes.push(page);return page.indices.map(index=>({index,sources:[]}));};
  await h.query('ERP53');assert.equal(probes.length,1);assert.match(h.el('bioProjectProgress').textContent,/未确认推荐/);
});

test('cancel during first Run never starts recommended project scan',async()=>{
 const h=panel();let resolve;const calls=[];
 h.context.window.api.probeProjectPage=async(_id,page)=>{calls.push(page);if(page.cancel)return [];return new Promise(done=>{resolve=done;});};
 const pending=h.query('ERP77');
 while(!resolve) await Promise.resolve();
 h.context.cancelProjectCheck();resolve([]);await pending;
 assert.equal(calls.length,2);assert.ok(calls[1].cancel);assert.match(h.el('bioProjectProgress').textContent,/已取消/);
});

test('real HTTP refusal on second batch clears prior renderer sources and retains scope/selection',async t=>{
 const http=require('node:http'),bytes=require('node:zlib').gzipSync('@r\nACGT\n+\nIIII\n');const calls=[];
 const server=http.createServer((req,res)=>{calls.push(req.url);if(req.url.includes('/f11.')){res.writeHead(403);res.end('denied');return;}res.writeHead(206,{'content-range':`bytes 0-${bytes.length-1}/${bytes.length}`});res.end(bytes);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const manifest=Array.from({length:24},(_,i)=>({run:`HRR${100+i}`,name:`f${i}.fastq.gz`,format:'fastq',size:bytes.length,url:`https://download.cncb.ac.cn/f${i}.fastq.gz`}));
 const service=require('../packages/cli/project-sources').createProjectService(async()=>({accession:'HRA1',access:'public',runs:manifest.map(f=>f.run),files:manifest}),{get:async(url,options)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,{signal:options.signal});return {status:r.status,headers:Object.fromEntries(r.headers),data:Buffer.from(await r.arrayBuffer())};}});
 const h=panel();h.context.window.api.queryBioProject=service.query;h.context.window.api.probeProjectPage=(queryId,page)=>service.probe({queryId,page});
 await h.query('HRA1');assert.equal(calls.length,12);assert.equal(h.evaluate('[...projectView.files.values()].reduce((n,i)=>n+i.sources.length,0)'),0);
 assert.equal(h.evaluate('BioProjectView.selected(projectView).length'),24);assert.match(h.el('bioProjectResult').title,/24 个/);assert.match(h.el('bioProjectProgress').textContent,/来源拒绝/);
 h.context.adoptBioProjectRuns();assert.equal(h.queue.length,1);await h.context.checkProjectColumn('ftp',false);assert.equal(calls.length,12);assert.equal(h.el('bioAdopt').disabled,true);
});

test('column adoption is exact, preserves existing tasks and never switches protocols', async () => {
  const h = panel(); await h.query('ERP77');
  await h.context.checkProjectColumn('cncb',false);
  h.context.adoptBioProjectRuns('cncb');
  assert.equal(h.queue.length, 13);
  assert.equal(h.queue[0],h.initial);
  for (const task of h.queue.slice(1)) assert.ok(task.url.startsWith('https://download2.cncb.ac.cn/'));
  h.context.selectProjectRows('none');h.context.adoptBioProjectRuns('ena');assert.equal(h.queue.length,13);
});

async function cli(argv, { proxyReady = false } = {}) {
  const f = fixture(), program = new Command(), logs = [], calls = [];
  const console = { log: (...args) => logs.push(args.join(' ')), error: (...args) => logs.push(args.join(' ')), warn: (...args) => logs.push(args.join(' ')) };
  const main = { eventBus: { on() {} }, async callIpcHandler(channel, args) {
    calls.push({ channel, args });
    if (['query-bioproject', 'probe-project-page'].includes(channel)) return f.ipc(channel, args);
    if (channel === 'get-settings') return { token: 'unit-test' };
    if (channel === 'api-get-user-info') return { username: 'test', success: true, isActive: true };
    if (channel === 'check-download-size') return [files[0]];
    if (channel === 'clash-status') return false;
    if (channel === 'clash-start') return { success: proxyReady };
    if (['save-settings', 'start-download', 'clash-stop'].includes(channel)) return { success: true };
    throw Error(`unexpected CLI IPC: ${channel}`);
  } };
  let sockets = 0;
  const socketModule = { connect() {
    const events = {}, connected = ++sockets > 1 && proxyReady;
    const socket = { once(event, fn) { events[event] = fn; }, setTimeout() { queueMicrotask(() => events[connected ? 'connect' : 'error']()); }, destroy() {} };
    return socket;
  } };
  const process = { argv: ['node', 'biodl', ...argv], env: {}, platform: 'linux', stdout: { write() {} }, exitCode: 0 };
  const context = vm.createContext({ URL, process, console, require(id) {
    if (id === 'commander') return { program };
    if (id === '../../main') return main;
    if (id === '../../shared/project-source-policy') return policy;
    if (id === '../../package.json') return { version: '0.0.0' };
    if (id === 'node:net') return socketModule;
    return require(id);
  } });
  await vm.runInContext(read('packages/cli/bin.js'), context);
  return { logs: logs.join('\n'), calls, sockets, code: process.exitCode };
}

test('CLI project actions apply both strategies, Run filtering, source overrides, multiple parents and invalid policy', async () => {
  for (const [args, selected] of [[[], files[0].url], [['--strategy', 'domestic-first'], cn(files[0])],
    [['--strategy', 'domestic-first', '--source', 'ftp'], ftp(files[0])]]) {
    const c = await cli(['project', 'ERP77', '--run', files[0].run.toLowerCase(), ...args]);
    assert.equal(c.code, 0, c.logs); assert.ok(c.logs.includes('* ' + selected));
    assert.ok(!c.logs.includes(files[1].name));
  }
  const parents = await cli(['project', 'SAMN2']); assert.match(parents.logs, /PRJEB1、PRJEB2/);
  assert.ok(!parents.calls.some(c => c.channel === 'probe-project-page'));
  const bad = await cli(['project', 'ERP77', '--strategy', 'fake']); assert.equal(bad.code, 1);
  assert.ok(!bad.calls.length);
});

test('CLI get dispatches only an explicit working mode and applies the engine to that batch', async () => {
  const direct = await cli(['get', 'bioproject', 'ERP77', '--direct', '--run', files[0].run, '--engine', 'axel', '--strategy', 'domestic-first']);
  assert.equal(direct.code, 0, direct.logs);
  assert.equal(direct.sockets, 0);
  assert.ok(!direct.calls.some(c => c.channel.startsWith('clash-') || c.args?.downloadEngines));
  const [task] = direct.calls.find(c => c.channel === 'start-download').args.files;
  assert.deepEqual([task.sourceName, task.run, task.format, task.transport, task.url, task.downloadEngine, task.networkMode], [files[0].name, files[0].run, 'fastq', 'https', cn(files[0]), 'axel', 'direct']);
  const accelerated = await cli(['get', 'ebi', files[0].run], { proxyReady: true });
  assert.equal(accelerated.code, 0, accelerated.logs);
  assert.equal(accelerated.calls.find(c => c.channel === 'start-download').args.files[0].networkMode, 'accelerated');
  assert.ok(accelerated.calls.some(c => c.channel === 'clash-stop'));
  const failed = await cli(['get', 'sra', 'SRR9']); assert.equal(failed.code, 1); assert.match(failed.logs, /--direct/);
  assert.ok(!failed.calls.some(c => c.channel === 'start-download'));
  for (const args of [['SAMN2'], ['ERP77', '--source', 'unknown.example']]) {
    const none = await cli(['get', 'bioproject', ...args, '--direct']);
    assert.equal(none.code, 1); assert.ok(!none.calls.some(c => c.channel === 'start-download'));
  }
});
