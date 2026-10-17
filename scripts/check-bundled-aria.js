const assert = require('node:assert/strict');
const path = require('path'), fs = require('fs'), os = require('os'), { spawnSync } = require('child_process');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-binary-'));
process.env.BIODL_DATA_DIR = path.join(temp, 'profile');
const main = require('../main');
try {
  main.ensureBinaries();
  const binary = process.platform === 'linux'
    ? path.resolve('bin/linux/aria2/aria2c')
    : path.join(temp, 'profile', 'bin', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c');
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true, env: require('../src/main/download-engines').ariaEnvironment(binary) });
  console.log(JSON.stringify({binary,status:result.status,signal:result.signal,error:result.error?.message,stdout:result.stdout,stderr:result.stderr},null,2));
  assert.equal(result.status, 0, 'bundled aria2 runtime must start without a system installation');
  assert.match(result.stdout, /aria2 version 1\.37\.0/);
} finally { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3 }); }
