'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createTransfersStore } = require('../src/main/transfers-store');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-store-lock-'));
try {
  const filename = path.join(root, 'transfers.json');
  const store = createTransfersStore(filename);
  const first = store.save({ active: [] });
  const before = fs.readFileSync(filename);
  const release = require('proper-lockfile').lockSync(filename, { realpath: false, retries: 0 });
  try {
    const code = `
      const store = require(${JSON.stringify(path.resolve(__dirname, '../src/main/transfers-store'))}).createTransfersStore(process.argv[1]);
      try {
        store.save({ active: [{ name: 'other' }] }, { expectedRevision: process.argv[2] });
        process.exitCode = 2;
      } catch (error) {
        if (error.code !== 'TRANSFER_HISTORY_CONFLICT') throw error;
        console.log('CHILD_LOCK_CONFLICT_OK');
      }
    `;
    const child = spawnSync(process.execPath, ['-e', code, filename, first.revision || ''], {
      encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL'
    });
    assert.ifError(child.error);
    assert.equal(child.status, 0, child.stderr);
    assert.match(child.stdout, /CHILD_LOCK_CONFLICT_OK/);
    assert.deepEqual(fs.readFileSync(filename), before);
  } finally {
    release();
  }
  store.save({ active: [{ name: 'after-release' }] }, { expectedRevision: first.revision });
  assert.equal(store.read().active[0].name, 'after-release');
  assert(!fs.existsSync(filename + '.lock'));
  console.log('TRANSFER_STORE_PROCESS_LOCK_OK: competing process denied, disk unchanged, released lease permits CAS; not power-loss proof');
} finally {
  const resolved = fs.realpathSync(root);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('biodl-store-lock-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
