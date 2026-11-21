'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { createTransfersStore } = require('../src/main/transfers-store');

if (process.argv[2] === '--child') {
  const filename = process.argv[3], cut = process.argv[4], rename = fs.renameSync;
  fs.renameSync = function (from, to) {
    if (to === filename) {
      if (cut === 'before') process.exit(137);
      rename.call(fs, from, to);
      process.exit(137);
    }
    return rename.call(fs, from, to);
  };
  createTransfersStore(filename).save({
    active: [{ name: 'accepted-replacement', originalIndex: 902 }], completed: []
  }, { expectedRevision: process.argv[5] });
  throw Error('crash cut not reached');
} else {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-store-commit-crash-'));
  try {
    for (const cut of ['before', 'after']) {
      const filename = path.join(root, cut, 'transfers.json');
      const store = createTransfersStore(filename);
      const initial = store.save({ active: [], completed: [{ name: 'old-complete', originalIndex: 901 }] });
      const options = { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL' };
      const child = spawnSync(process.execPath, [__filename, '--child', filename, cut, initial.revision], options);
      assert.ifError(child.error);
      assert.equal(child.status, 137, child.stderr);
      const reader = `
        const assert = require('node:assert/strict');
        const store = require(${JSON.stringify(path.resolve(__dirname, '../src/main/transfers-store'))}).createTransfersStore(process.argv[1]);
        const history = store.read();
        if (process.argv[2] === 'before') {
          assert.equal(history.revision, process.argv[3]);
          assert.equal(history.completed[0].name, 'old-complete');
          assert.equal(history.active.length, 0);
        } else {
          assert.notEqual(history.revision, process.argv[3]);
          assert.equal(history.completed.length, 0);
          assert.equal(history.active[0].name, 'accepted-replacement');
        }
        console.log('FRESH_PROCESS_COMMIT_READ_OK');
      `;
      const reopened = spawnSync(process.execPath, ['-e', reader, filename, cut, initial.revision], options);
      assert.ifError(reopened.error);
      assert.equal(reopened.status, 0, reopened.stderr);
      assert.match(reopened.stdout, /FRESH_PROCESS_COMMIT_READ_OK/);
      assert.equal(fs.existsSync(filename + '.tmp'), cut === 'before', 'pre-rename tmp is not accepted history');
    }
    console.log('TRANSFER_STORE_COMMIT_CRASH_OK: child exits immediately before/after rename, fresh process reads whole old/new revision; process crash cuts not power-loss durability');
  } finally {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('biodl-store-commit-crash-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
