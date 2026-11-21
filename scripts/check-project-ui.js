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
  const probe = ({ page }) => files.slice(10 * page, 10 * (page + 1)).map((f, i) => ({ index: 10 * page + i,
    sources: [[cn(f), 25], [ftp(f), 10], [f.url, 5]].map(([url, latencyMs]) => ({ ...f, url, latencyMs, available: !unavailable.has(url), reason: unavailable.has(url) ? '源暂不可用' : '' })) }));
  async function ipc(channel, args) {
    calls.push({ channel, args });
    if (channel === 'query-bioproject') return service.query(args.project);
    if (channel === 'probe-project-page') return probe(args);
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
    const [label, select, note] = el('bioProjectFiles').children[index].children;
    return { check: label.children[0], select, note };
  };
  const setManual = (index, url) => { const { select } = controls(index); select.value = url; select.onchange(); };
  const setChecked = (index, checked) => { const { check } = controls(index); check.checked = checked; check.onchange(); };
  const setStrategy = strategy => { el('bioSourceStrategy').value = strategy; action('#bioSourceStrategy', 'onchange'); };
  return { ...f, $, el, context, evaluate, action, query, controls, setManual, setChecked, setStrategy, queue: context.currentQueue, initial };
}

test('desktop and Linux panel share wired controls, per-file strategy, cross-page selection and rename-safe append', async () => {
  const h = panel();
  const panelHtml = page => load(page)('#bioProjectPanel').html();
  assert.equal(panelHtml(read('packages/web/index.html')), panelHtml(read('index.html')));
  assert.ok(h.$('#bioProjectPanel script[src="shared/project-source-policy.js"]').length);
  for (const bridge of ['preload.js', 'packages/web/web-bridge.js']) assert.match(read(bridge), /probeProjectPage:.*probe-project-page/);
  assert.equal(h.el('bioSourceStrategy').value, 'fastest');
  await h.query('erp77');
  assert.equal(h.el('bioProjectFiles').children.length, 10);
  assert.match(h.controls(0).select.children[0].textContent, /ftp\.sra\.ebi\.ac\.uk.*5 ms/);
  h.setManual(0, ftp(files[0]));
  h.setChecked(1, false);
  await h.action('#bioNext');
  h.setStrategy('domestic-first');
  assert.match(h.controls(0).select.children[0].textContent, /download2\.cncb.*25 ms/);
  assert.match(h.el('bioSelectedCount').textContent, /11 个/);
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
  await h.action('#bioPrev');
  assert.equal(h.calls.filter(x => x.channel === 'probe-project-page').length, 2, 'returning to a measured page uses stored results');
  assert.equal(h.controls(0).select.value, ftp(files[0]));
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
  assert.equal(h.controls(0).select.value, ftp(files[0]));
  assert.equal(h.controls(1).check.checked, false);
  h.action('#bioAdopt'); await h.query('PRJEB1');
  assert.equal(h.controls(0).select.value, ftp(files[0]));
  h.action('#bioAdopt'); assert.equal(h.queue[1].url, ftp(files[0]));
});

test('remeasure retains a failed manual choice until the user actively changes it', async () => {
  const h = panel(); await h.query('ERP77');
  h.setManual(0, ftp(files[0]));
  h.unavailable.add(ftp(files[0]));
  await h.action('#bioProjectAdoptActions button:contains("重测")');
  assert.equal(h.controls(0).select.value, ftp(files[0]));
  assert.match(h.controls(0).note.textContent, /手选来源/);
  assert.equal(h.el('bioAdopt').disabled, true);
  h.context.adoptBioProjectRuns(); assert.equal(h.queue.length, 1);
  h.setManual(0, ''); h.action('#bioAdopt');
  assert.equal(h.queue[1].url, files[0].url);
});

test('narrow scopes remain visible and multi-parent results wait for explicit parent navigation', async () => {
  const h = panel(); await h.query('SAMN2');
  assert.match(h.el('bioProjectResult').textContent, /当前范围 SAMN2.*部分结果/);
  assert.equal(h.calls.filter(x => x.channel === 'probe-project-page').length, 0);
  assert.equal(h.evaluate('projectView'), null);
  const multi = await h.service.query('SAMN2');
  await assert.rejects(h.service.probe({ queryId: multi.queryId }), /范围/);
  const buttons = h.el('bioProjectResult').children.filter(child => child.tag === 'button');
  assert.deepEqual(buttons.map(b => b.textContent), ['查询 PRJEB1', '查询 PRJEB2']);
  await buttons[0].onclick();
  assert.match(h.el('bioProjectResult').textContent, /当前范围 PRJEB1/);
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
  api.probeProjectPage = () => new Promise(resolve => { resolvePage = resolve; });
  const page = h.action('#bioNext');
  await h.query('HRA9'); resolvePage([]); await page;
  assert.equal(h.evaluate('projectView'), null);
  assert.equal(h.queue.length, 1);
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
