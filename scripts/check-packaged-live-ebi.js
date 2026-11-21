// Run the existing EBI acceptance against the payload and runtime from the final installer.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const version = require('../package.json').version;
const installers = {
  darwin: `BioDownloader-${version}-arm64.dmg`,
  win32: `BioDownloader-Setup-${version}.exe`,
  linux: `BioDownloader-Linux-x64-${version}.tar.gz`,
};
const installer = path.resolve('dist', installers[process.platform]);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-installer-ebi-'));
const mount = path.join(tmp, 'mount');
let mounted = false;
const run = (file, args, options) => execFileSync(file, args, { stdio: 'inherit', ...options });

function payload() {
  if (process.platform === 'darwin') {
    fs.mkdirSync(mount);
    run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, installer]);
    mounted = true;
    const contents = path.join(mount, 'BioDownloader.app', 'Contents');
    return [path.join(contents, 'MacOS', 'BioDownloader'), path.join(contents, 'Resources', 'app.asar')];
  }
  if (process.platform === 'win32') {
    const nsis = path.join(tmp, 'nsis'), installed = path.join(tmp, 'installed');
    run('7z', ['x', '-y', '-bso0', `-o${nsis}`, installer]);
    const archives = fs.readdirSync(nsis, { recursive: true }).filter(file => /(?:^|[\\/])app-(?:64|x64)\.7z$/i.test(file));
    assert(archives.length <= 1, 'Expected one x64 application payload');
    // Full 7-Zip exposes the NSIS layer. Readers that recognize its embedded
    // 7z stream first can extract the application files directly.
    if (archives.length) run('7z', ['x', '-y', '-bso0', `-o${installed}`, path.join(nsis, archives[0])]);
    const app = archives.length ? installed : nsis;
    const files = [path.join(app, 'BioDownloader.exe'), path.join(app, 'resources', 'app.asar')];
    for (const file of files) assert(fs.statSync(file).isFile(), `Missing installed file: ${file}`);
    return files;
  }
  run('tar', ['-xzf', installer, '-C', tmp]);
  const installed = path.join(tmp, 'BioDownloader-Linux-x64');
  return [path.join(installed, 'runtime', 'node'), installed];
}

try {
  const [runtime, productRoot] = payload();
  run(runtime, [path.join(__dirname, 'check-live-ebi-download.js')], {
    cwd: tmp,
    env: { ...process.env, BIODL_HEADLESS: '1', ELECTRON_RUN_AS_NODE: '1', BIODL_TEST_PRODUCT_ROOT: productRoot },
    timeout: 22 * 60 * 1000,
  });
  const name = `packaged-live-ebi-${process.platform}.json`;
  const result = JSON.parse(fs.readFileSync(path.join(tmp, '.evidence', name)));
  assert.equal(result.engineSource, 'bundled');
  assert.equal(result.networkMode, 'direct');
  assert.equal(result.billingPostCalls, 0);
  assert.equal(result.version, version);
  assert.equal(result.actualBytes, 101304405);
  assert.equal(result.actualMd5, 'a04ed1f37028cda9486eec9726237796');
  result.installer = { name: path.basename(installer), bytes: fs.statSync(installer).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(installer)).digest('hex') };
  fs.mkdirSync('.evidence', { recursive: true });
  fs.writeFileSync(path.resolve('.evidence', name), JSON.stringify(result, null, 2));
  console.log('PACKAGED_FULL_EBI_VERIFIED', result.installer.name, result.actualBytes, result.actualMd5, result.installer.sha256);
} finally {
  if (mounted) run('hdiutil', ['detach', mount]);
  assert.equal(path.dirname(tmp), os.tmpdir());
  assert.match(path.basename(tmp), /^biodl-installer-ebi-[a-zA-Z0-9]+$/);
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
