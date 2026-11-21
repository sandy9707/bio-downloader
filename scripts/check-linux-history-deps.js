// Offline packages-only upgrade check. Never installs dependencies or builds Linux binaries.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

// This explicit allowlist is also used by build-linux. Fail closed on graph changes.
const allowed = {
  'proper-lockfile': { version: /^4\./, dependencies: ['graceful-fs', 'retry', 'signal-exit'] },
  'graceful-fs': { version: /^4\./, dependencies: [] },
  retry: { version: /^0\.12\./, dependencies: [] },
  'signal-exit': { version: /^3\./, dependencies: [] },
  'js-yaml': { version: /^4\./, dependencies: ['argparse'] },
  argparse: { version: /^2\./, dependencies: [] }
};

function vendorDependencies(source, destination, roots) {
  const copied = new Map();
  function copy(name, from) {
    assert(Object.hasOwn(allowed, name), `Unapproved Linux dependency: ${name}`);
    // Resolve from the requiring package, NOT root/node_modules: npm may nest signal-exit@3.
    const manifest = require.resolve(name + '/package.json', { paths: [from] });
    const directory = path.dirname(manifest);
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const rule = allowed[name];
    assert.equal(pkg.name, name);
    assert(rule.version.test(pkg.version), `Unsupported ${name} version: ${pkg.version}`);
    assert.deepStrictEqual(Object.keys(pkg.dependencies || {}).sort(), [...rule.dependencies].sort(), `Review dependency allowlist for ${name}`);
    assert.equal(Object.keys(pkg.optionalDependencies || {}).length, 0, `Review optional dependencies for ${name}`);
    assert.equal(Object.keys(pkg.peerDependencies || {}).length, 0, `Review peer dependencies for ${name}`);
    if (copied.has(name)) {
      assert.equal(copied.get(name), pkg.version, `Cannot flatten conflicting ${name} versions`);
      return;
    }
    copied.set(name, pkg.version);
    const target = path.join(destination, name);
    assert(!fs.existsSync(target), `Refusing to merge stale vendored dependency: ${target}`);
    fs.mkdirSync(destination, { recursive: true });
    fs.cpSync(directory, target, {
      recursive: true,
      filter(file) {
        const relative = path.relative(directory, file);
        if (relative.split(path.sep).some(part => part === 'node_modules' || part.startsWith('.'))) return false;
        assert(!fs.lstatSync(file).isSymbolicLink(), `Refusing dependency symlink: ${file}`);
        return true;
      }
    });
    for (const dependency of rule.dependencies) copy(dependency, directory);
  }
  for (const name of roots) copy(name, source);
  return Object.fromEntries(copied);
}

// Self-contained so the upgrade check can execute it with the old bundled Node runtime.
function verifyStore(storeModule, filename) {
  const assert = require('assert');
  const fs = require('fs');
  const { createTransfersStore } = require(storeModule);
  const store = createTransfersStore(filename);
  const initial = store.read();
  assert.equal(initial.exists, false);
  assert.equal(initial.revision, null);
  const first = store.save({ completed: [{ id: 'linux-history-probe' }], active: [{ id: 'keep-active' }] }, { expectedRevision: null });
  assert.match(first.revision, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(createTransfersStore(filename).read().revision, first.revision);
  const second = store.save({ failed: [{ id: 'second-write' }] }, { expectedRevision: first.revision });
  assert.notEqual(second.revision, first.revision);
  assert.deepStrictEqual(second.completed, first.completed);
  assert.deepStrictEqual(second.active, first.active);
  const bytes = fs.readFileSync(filename, 'utf8');
  assert.throws(() => store.save({ completed: [] }, { expectedRevision: first.revision }), error => error.code === 'TRANSFER_HISTORY_CONFLICT');
  assert.equal(fs.readFileSync(filename, 'utf8'), bytes, 'stale CAS must not overwrite history');
  assert.equal(createTransfersStore(filename).read().revision, second.revision);
  assert(!fs.existsSync(filename + '.lock'), 'store must release lock after stale CAS');
  console.log('LINUX_HISTORY_STORE_OK: read/save/revision/stale-CAS');
}

function storeProbeCode(storeModule, filename) {
  return `(${verifyStore.toString()})(${JSON.stringify(storeModule)}, ${JSON.stringify(filename)});`;
}

function removeTemporary(temp) {
  const resolved = path.resolve(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('biodl-history-deps-'));
  assert.equal(fs.realpathSync(resolved), resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function checkOffline({ withoutVendor = false } = {}) {
  const root = path.resolve(__dirname, '..');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'biodl-history-deps-'));
  try {
    let source = root;
    // First use the real npm layout (currently nested signal-exit@3), then feed
    // the resulting flat layout back through the exact same copier.
    for (const layout of withoutVendor ? ['missing'] : ['installed', 'hoisted']) {
      const app = path.join(temp, layout);
      const core = path.join(app, 'packages/core');
      fs.mkdirSync(path.join(core, 'main'), { recursive: true });
      fs.copyFileSync(path.join(root, 'src/main/transfers-store.js'), path.join(core, 'main/transfers-store.js'));
      if (!withoutVendor) console.log('LINUX_HISTORY_VENDOR', layout, JSON.stringify(vendorDependencies(source, path.join(core, 'node_modules'), ['proper-lockfile'])));
      assert(!fs.existsSync(path.join(app, 'node_modules')), 'test must have no application root node_modules');
      const code = `const Module=require('module');const path=require('path');const assert=require('assert');
        const core=${JSON.stringify(core)};const original=Module._resolveFilename;
        Module._resolveFilename=function(...args){const result=original.apply(this,args);
          if(path.isAbsolute(result))assert(result.startsWith(core+path.sep),'Dependency escaped isolated core: '+result);
          return result;};
        ${storeProbeCode(path.join(core, 'main/transfers-store.js'), path.join(app, 'profile/transfers.json'))}`;
      cp.execFileSync(process.execPath, ['-e', code], {
        cwd: app, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, stdio: 'inherit', timeout: 30000
      });
      source = core;
    }
  } finally { removeTemporary(temp); }
}

// Only transform the staged artifact; desktop/source execution keeps its src/ path.
function rewriteProjectService(bundle) {
  const filename = path.join(bundle, 'packages/cli/project-sources.js');
  const original = fs.readFileSync(filename, 'utf8');
  const before = "require('../../src/main/project-lookup-sra')";
  assert.equal(original.split(before).length - 1, 1, 'Review project service packaging import');
  fs.writeFileSync(filename, original.replace(before, "require('../core/main/project-lookup-sra')"));
}

async function verifyProjectService(app) {
  const assert = require('assert');
  const path = require('path');
  const filename = path.join(app, 'packages/cli/project-sources.js');
  const helper = path.join(app, 'packages/core/main/project-lookup-sra.js');
  const { createProjectService } = require(filename);
  assert(require.cache[filename].children.some(child => child.filename === helper), 'Service must load the staged core helper, not missing/stale src');
  let requests = 0;
  const run = 'SRR123456';
  const service = createProjectService(async () => ({ access: 'public', accession: run, runs: [run], files: [] }), {
    get: async url => {
      requests++;
      assert.equal(url, 'https://locate.ncbi.nlm.nih.gov/sdl/2/retrieve?acc=' + run);
      // No public objects: exercises real sraContainers without external file probes.
      return { status: 200, data: { result: [{ bundle: run, status: 200, files: [] }] } };
    },
    ftp: async () => { throw Error('Unexpected FTP in offline probe'); }
  });
  const result = await service.query(run);
  assert.equal(result.count, 1);
  assert.equal(result.matrixFiles[0].pendingMetadata, true);
  const rows = await service.probe({ queryId: result.queryId, page: { indices: [0], column: 'aws' } });
  assert.equal(requests, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note, '官方记录未列出公开 SRA 容器');
  assert.deepStrictEqual(rows[0].sources, []);
  console.log('LINUX_PROJECT_SERVICE_OK: core helper loaded, synthetic query/SDL probe');
}

function serviceProbeCode(app) {
  return `(${verifyProjectService.toString()})(${JSON.stringify(app)}).catch(error=>{console.error(error);process.exitCode=1});`;
}

function checkProjectServiceOffline({ withoutRewrite = false } = {}) {
  const root = path.resolve(__dirname, '..');
  const sourceService = fs.readFileSync(path.join(root, 'packages/cli/project-sources.js'), 'utf8');
  const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'biodl-history-deps-'));
  try {
    for (const [source, target] of [
      ['packages/cli/project-sources.js', 'packages/cli/project-sources.js'],
      ['src/main/project-lookup-sra.js', 'packages/core/main/project-lookup-sra.js'],
      ['shared/project-source-policy.js', 'shared/project-source-policy.js'],
      ['shared/project-view-model.js', 'shared/project-view-model.js']
    ]) {
      fs.mkdirSync(path.dirname(path.join(temp, target)), { recursive: true });
      fs.copyFileSync(path.join(root, source), path.join(temp, target));
    }
    if (!withoutRewrite) {
      rewriteProjectService(temp);
      assert.equal(fs.readFileSync(path.join(temp, 'packages/cli/project-sources.js'), 'utf8'),
        sourceService.replace("require('../../src/main/project-lookup-sra')", "require('../core/main/project-lookup-sra')"));
    }
    assert.equal(fs.readFileSync(path.join(temp, 'packages/core/main/project-lookup-sra.js'), 'utf8'),
      fs.readFileSync(path.join(root, 'src/main/project-lookup-sra.js'), 'utf8'));
    assert.equal(fs.readFileSync(path.join(root, 'packages/cli/project-sources.js'), 'utf8'), sourceService, 'Product source must remain unchanged');
    assert(!fs.existsSync(path.join(temp, 'src')));
    // Existing axios/cheerio are stand-ins for retained baseline root dependencies.
    // Only those two entry points may resolve outside the staged package; no source escape.
    const dependencies = Object.fromEntries(['axios', 'cheerio'].map(name => [name, require.resolve(name)]));
    const code = `const Module=require('module');const original=Module._resolveFilename;
      const dependencies=${JSON.stringify(dependencies)};
      Module._resolveFilename=function(request,parent,...rest){
        if(parent?.filename===${JSON.stringify(path.join(temp, 'packages/cli/project-sources.js'))} && Object.hasOwn(dependencies,request))return dependencies[request];
        return original.call(this,request,parent,...rest);
      };
      ${serviceProbeCode(temp)}`;
    cp.execFileSync(process.execPath, ['-e', code], {
      cwd: temp, env: { ...process.env, NODE_PATH: '', NODE_OPTIONS: '' }, stdio: 'inherit', timeout: 30000
    });
  } finally { removeTemporary(temp); }
}

module.exports = { vendorDependencies, storeProbeCode, checkOffline, rewriteProjectService, serviceProbeCode, checkProjectServiceOffline };
if (require.main === module) {
  if (process.argv.includes('--service-only')) checkProjectServiceOffline({ withoutRewrite: process.argv.includes('--without-service-rewrite') });
  else {
    checkOffline({ withoutVendor: process.argv.includes('--without-vendor') });
    checkProjectServiceOffline();
  }
}
