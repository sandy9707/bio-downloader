// Exercise the shared renderer with real source selection and isolated IPC fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const { createProjectService } = require('../packages/cli/project-sources');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');

class Element {
  constructor() { this.style = {}; this.children = []; this.value = ''; }
  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.append(node); }
  prepend(...nodes) { this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(key, value) { this[key] = value; }
}

async function test() {
  const files = Array.from({ length: 11 }, (_, i) => ({ run: 'SRR1', name: `read${i}.fq.gz`, size: 8, md5: 'a'.repeat(32),
    url: `https://mirror.example/${i}`, alternatives: [`ftp://mirror.example/${i}`, `https://wrong-size.example/${i}`, `https://login.example/${i}`] }));
  const lookup = async accession => ({ accession, projects: [], files, runs: ['SRR1'], access: accession === 'PRIVATE' ? 'controlled' : 'public' });
  let probes = 0;
  const service = createProjectService(lookup, async url => {
    probes++;
    await new Promise(resolve => setTimeout(resolve, 12));
    return { status: 200, headers: { 'content-type': url.includes('login.') ? 'text/html' : 'application/gzip', 'content-length': url.includes('wrong-size.') ? 9 : 8 } };
  }, async () => { probes++; return 8; });
  const elements = {};
  const el = id => elements[id] ||= new Element();
  const context = vm.createContext({ document: { createElement: () => new Element(), getElementById: el }, URL,
    window: { api: { queryBioProject: service.query, probeProjectPage: (queryId, page) => service.probe({ queryId, page }) } },
    BioDownloadSources: require('../shared/download-sources'), currentDownloadType: 'bioproject', isDownloading: false,
    currentQueue: [], renderQueue() {}, formatBytes: String, showToast() {} });
  const renderer = read('renderer.js');
  vm.runInContext(renderer.slice(renderer.indexOf('let projectView ='), renderer.indexOf('// BioSample 查询:')), context);
  const evaluate = code => vm.runInContext(code, context);
  el('bioProjectInput').value = 'PRJNA1';
  await context.queryBioProject();
  assert.equal(probes, 40);
  assert.equal(evaluate('projectView.rows.length'), 10);
  assert.equal(evaluate('projectView.rows[0].select.value'), files[0].alternatives[0]);
  assert.equal(evaluate('projectView.rows[0].sources.filter(s=>s.available).length'), 2);
  evaluate('projectView.rows[0].select.value = projectView.rows[0].file.url; projectView.rows[1].include.checked = false');
  context.adoptBioProjectRuns();
  assert.equal(context.currentQueue.length, 9);
  assert.equal(context.currentQueue[0].url, files[0].url);
  assert.equal(context.currentQueue[0].md5, files[0].md5);
  context.adoptBioProjectRuns();
  assert.equal(context.currentQueue.length, 9);
  await context.showProjectPage(1);
  context.adoptBioProjectRuns();
  assert.equal(context.currentQueue.length, 10);
  el('bioProjectInput').value = 'PRIVATE';
  await context.queryBioProject();
  assert.equal(probes, 44);
  assert.equal(evaluate('projectView'), null);
  assert.equal(el('bioProjectAdoptActions').style.display, 'none');
  const stale = context.window.api.queryBioProject;
  let finish;
  context.window.api.queryBioProject = () => new Promise(resolve => { finish = resolve; });
  const old = context.queryBioProject();
  context.resetProjectView();
  finish(await stale('PRJNA1'));
  await old;
  assert.equal(evaluate('projectView'), null);
  await assert.rejects(service.probe({ queryId: 'https://untrusted.example' }));
  const panel = html => html.slice(html.indexOf('id="bioProjectPanel"'), html.indexOf('id="group-sra_raw"'));
  assert.equal(panel(read('index.html')), panel(read('packages/web/index.html')));
  for (const bridge of ['preload.js', 'packages/web/web-bridge.js']) assert.match(read(bridge), /probeProjectPage:.*probe-project-page/);
  const cli = read('packages/cli/bin.js');
  const cliContext = vm.createContext({ URL, console: { log() {} }, main: {callIpcHandler: (channel, args) =>
    channel === 'query-bioproject' ? service.query(args.project) : service.probe(args) } });
  vm.runInContext(cli.slice(cli.indexOf('async function projectFiles('), cli.indexOf("program.command('project")), cliContext);
  const chosen = await cliContext.projectFiles('PRJNA1', { run: 'srr1' }, true);
  assert.equal(chosen.length, 11);
  assert.equal(chosen[0].url, files[0].alternatives[0]);
  const manual = await cliContext.projectFiles('PRJNA1', { source: 'https' }, true);
  assert.equal(manual[0].url, files[0].url);
  await assert.rejects(cliContext.projectFiles('PRJNA1', { source: 'login.example' }, true));
  console.log('PASS project file probes, pagination, manual selection, queue, restricted access, stale responses, desktop/web bridges and CLI');
}
test().catch(error => { console.error(error); process.exitCode = 1; });
