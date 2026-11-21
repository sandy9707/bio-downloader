'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { fork } = require('node:child_process');
const { createTransfersStore } = require('../src/main/transfers-store');

if (process.argv[2] === '--hold') {
  require('proper-lockfile').lockSync(process.argv[3], { realpath: false, retries: 0, stale: 30000 });
  process.send({ locked: true });
  setTimeout(() => process.exit(2), 20000);
} else {
  (async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-crashed-store-lock-'));
    let child, timer;
    const watchdog = setTimeout(() => {
      if (child) child.kill('SIGKILL');
      console.error('crashed lease suite timeout');
      process.exit(1);
    }, 30000);
    try {
      const filename = path.join(root, 'transfers.json');
      const store = createTransfersStore(filename);
      const initial = store.save({ active: [{ name: 'original' }] });
      const original = fs.readFileSync(filename);
      child = fork(__filename, ['--hold', filename], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      let errors = '';
      child.stderr.on('data', chunk => { errors += chunk; });
      await new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(Error('lock child timeout')), 10000);
        child.once('error', reject);
        child.once('exit', code => reject(Error('lock child exited early ' + code + ' ' + errors)));
        child.once('message', message => message.locked ? resolve() : reject(Error('unexpected child response')));
      });
      clearTimeout(timer);
      const stopped = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
      assert(child.kill('SIGKILL'), 'termination request must be accepted');
      const termination = await stopped;
      // Windows emulates SIGKILL with unconditional process termination; accept its
      // nonzero exit-code representation too, but still require the orphan lease.
      assert(termination.signal === 'SIGKILL' || (process.platform === 'win32' && Number.isInteger(termination.code) && termination.code !== 0), JSON.stringify(termination));
      assert(fs.existsSync(filename + '.lock'));
      assert.throws(() => store.save({ active: [{ name: 'too-early' }] }, { expectedRevision: initial.revision }), { code: 'TRANSFER_HISTORY_CONFLICT' });
      assert.deepEqual(fs.readFileSync(filename), original);
      // Age only this isolated dead child's lease, never a live lease.
      const past = new Date(Date.now() - 60000);
      fs.utimesSync(filename + '.lock', past, past);
      const saved = store.save({ active: [{ name: 'after-expiry' }] }, { expectedRevision: initial.revision });
      assert.equal(store.read().revision, saved.revision);
      assert.equal(store.read().active[0].name, 'after-expiry');
      assert(!fs.existsSync(filename + '.lock'));
      const beforeStale = fs.readFileSync(filename);
      assert.throws(() => store.save({ active: [] }, { expectedRevision: initial.revision }), { code: 'TRANSFER_HISTORY_CONFLICT' });
      assert.deepEqual(fs.readFileSync(filename), beforeStale);
      assert(!fs.existsSync(filename + '.lock'));
      console.log('TRANSFER_STORE_CRASHED_LEASE_OK: holder forcibly terminated, orphan lease blocks writes, aged dead lease reclaimed, stale CAS rejected; simulated expiry, not live long-transaction or power-loss proof');
    } finally {
      clearTimeout(timer);
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await stopped;
      }
      const resolved = fs.realpathSync(root);
      assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
      assert(path.basename(resolved).startsWith('biodl-crashed-store-lock-'));
      fs.rmSync(resolved, { recursive: true, force: true });
      clearTimeout(watchdog);
    }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
