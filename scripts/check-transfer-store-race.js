'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { createTransfersStore } = require('../src/main/transfers-store');

if (process.argv[2] === '--child') {
  const store = createTransfersStore(process.argv[3]);
  const watchdog = setTimeout(() => process.exit(2), 15000);
  process.send({ ready: true });
  process.once('message', () => {
    let result;
    try {
      const saved = store.save({ active: [{ name: process.argv[5] }] }, { expectedRevision: process.argv[4] });
      result = { ok: true, revision: saved.revision, name: process.argv[5] };
    } catch (error) {
      result = { ok: false, code: error.code };
    }
    process.send(result, () => { clearTimeout(watchdog); process.exit(0); });
  });
} else {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-store-race-'));
    const children = [];
    const watchdog = setTimeout(() => {
      for (const child of children) child.kill('SIGKILL');
      console.error('race suite timeout');
      process.exit(1);
    }, 60000);
    try {
      for (let round = 0; round < 5; round++) {
        const file = path.join(root, 'history-' + round + '.json');
        const store = createTransfersStore(file);
        const baseline = store.save({ active: [] });
        const runs = [0, 1].map(index => {
          const child = fork(__filename, ['--child', file, baseline.revision, 'writer-' + index], {
            stdio: ['ignore', 'ignore', 'pipe', 'ipc']
          });
          children.push(child);
          let error = '', result, readyResolve;
          child.stderr.on('data', chunk => { error += chunk; });
          const ready = new Promise(resolve => { readyResolve = resolve; });
          const done = new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              child.kill('SIGKILL');
              reject(Error('race child timeout'));
            }, 10000);
            child.on('message', message => {
              if (message.ready) readyResolve();
              else result = message;
            });
            child.once('error', reject);
            child.once('exit', code => {
              clearTimeout(timer);
              if (code !== 0) reject(Error(error || 'race child failed'));
              else resolve(result);
            });
          });
          return { child, ready, done };
        });
        await Promise.race([
          Promise.all(runs.map(run => run.ready)),
          ...runs.map(run => run.done.then(() => { throw Error('child exited before barrier'); }))
        ]);
        for (const run of runs) run.child.send('go');
        const results = await Promise.all(runs.map(run => run.done));
        assert.equal(results.filter(result => result.ok).length, 1);
        const winner = results.find(result => result.ok);
        assert.equal(results.find(result => !result.ok).code, 'TRANSFER_HISTORY_CONFLICT');
        const persisted = store.read();
        assert.equal(persisted.revision, winner.revision);
        assert.equal(persisted.active[0].name, winner.name);
        assert(!fs.existsSync(file + '.lock'));
        assert(!fs.existsSync(file + '.tmp'));
      }
      console.log('TRANSFER_STORE_SIMULTANEOUS_CAS_OK: five real two-process barrier rounds, one winner/one conflict, exact winning revision/content and no temp/lease remains');
    } finally {
      await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => new Promise(resolve => {
        child.once('exit', resolve);
        child.kill('SIGKILL');
      })));
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
      assert(path.basename(resolved).startsWith('biodl-store-race-'));
      fs.rmSync(resolved, { recursive: true, force: true });
      clearTimeout(watchdog);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
