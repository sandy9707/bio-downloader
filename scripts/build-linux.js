// Build an explicit allowlist; private backend, profiles and credentials are never packaged.
const fs = require('fs'), path = require('path'), cp = require('child_process'), crypto = require('crypto'), os = require('os'), assert = require('assert');
const { vendorDependencies, storeProbeCode, rewriteProjectService, serviceProbeCode } = require('./check-linux-history-deps');
// This builder executes the packaged runtime and engines as a smoke test.
// Refuse cross-host builds before touching dist rather than shipping Darwin Node.
if (process.platform !== 'linux' || process.arch !== 'x64') {
  throw new Error('Linux x64 packaging must run on a Linux x64 host; use the isolated Linux builder or release CI.');
}
const root = path.resolve(__dirname, '..'), version = require('../package.json').version;
const out = path.join(root, 'dist');
// Stage only in a newly allocated OS temporary directory; never recursively delete dist.
const temp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'biodl-linux-build-'));
const bundle = path.join(temp, 'BioDownloader-Linux-x64');
try {
  fs.mkdirSync(bundle);
  fs.mkdirSync(out, { recursive: true });
  for (const item of ['main.js','renderer.js','preload.js','index.html','speedtest.html','package.json','package-lock.json','THIRD_PARTY_NOTICES.md','packages','shared','img','src/main']) {
    fs.cpSync(path.join(root, item), path.join(bundle,item), {
      recursive:true,
      // Never import a developer's installed modules or hidden/private directories.
      filter: file => !path.relative(root, file).split(path.sep).some(part => part === 'node_modules' || part.startsWith('.'))
    });
  }
  // Old updaters sync packages/ but not src/ or newly added root dependencies.
  fs.cpSync(path.join(root,'src/main'),path.join(bundle,'packages/core/main'),{recursive:true});
  const main = path.join(bundle,'main.js');fs.writeFileSync(main,fs.readFileSync(main,'utf8').replaceAll("require('./src/", "require('./packages/core/"));
  rewriteProjectService(bundle);
  fs.cpSync(path.join(root,'bin/linux'),path.join(bundle,'bin/linux'),{recursive:true});
  for(const name of ['Country.mmdb','GeoSite.dat'])fs.copyFileSync(path.join(root,'bin',name),path.join(bundle,'bin',name));
  fs.mkdirSync(path.join(bundle,'runtime'),{recursive:true});
  fs.copyFileSync(process.env.BIODL_NODE_RUNTIME || process.execPath,path.join(bundle,'runtime/node'));
  fs.copyFileSync(path.join(root,'packages/cli/biodl'),path.join(bundle,'biodl'));
  fs.copyFileSync(path.join(root,'logo.png'),path.join(bundle,'packages/web/logo.png'));
  for(const file of ['runtime/node','biodl','bin/linux/axel','bin/linux/mihomo_linux_amd64','bin/linux/aria2/aria2c'])fs.chmodSync(path.join(bundle,file),0o755);

  cp.execFileSync('npm',['ci','--omit=dev','--ignore-scripts','--no-audit'],{cwd:bundle,stdio:'inherit'});
  // Resolve each edge from its parent package: signal-exit@3 may be nested beneath
  // proper-lockfile while the root contains incompatible signal-exit@4.
  vendorDependencies(bundle, path.join(bundle, 'packages/core/node_modules'), ['proper-lockfile']);
  vendorDependencies(bundle, path.join(bundle, 'packages/vendor/node_modules'), ['js-yaml']);
  cp.execFileSync(path.join(bundle,'runtime/node'),['--version'],{stdio:'inherit'});
  cp.execFileSync(path.join(bundle,'runtime/node'), ['-e', storeProbeCode(
    path.join(bundle, 'packages/core/main/transfers-store.js'), path.join(temp, 'history-probe/transfers.json')
  )], { stdio: 'inherit' });
  cp.execFileSync(path.join(bundle,'runtime/node'), ['-e', serviceProbeCode(bundle)], { stdio: 'inherit', timeout: 30000 });
  cp.execFileSync(path.join(bundle,'bin/linux/axel'),['--version'],{stdio:'inherit'});
  cp.execFileSync(path.join(bundle,'bin/linux/aria2/aria2c'),['--version'],{stdio:'inherit'});
  const name=`BioDownloader-Linux-x64-${version}.tar.gz`;
  cp.execFileSync('tar',['-czf',path.join(out,name),'-C',temp,'BioDownloader-Linux-x64']);
  const hash=crypto.createHash('sha256').update(fs.readFileSync(path.join(out,name))).digest('hex');
  fs.writeFileSync(path.join(out,name+'.sha256'),`${hash}  ${name}\n`);
  console.log('LINUX_PACKAGE',JSON.stringify({version,name,sha256:hash,bytes:fs.statSync(path.join(out,name)).size}));
} finally {
  assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir()));
  assert(path.basename(temp).startsWith('biodl-linux-build-'));
  assert.equal(fs.realpathSync(temp), temp);
  fs.rmSync(temp, { recursive: true, force: true });
}
