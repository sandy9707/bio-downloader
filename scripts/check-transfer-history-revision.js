'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTransfersStore } = require('../src/main/transfers-store');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-history-revision-'));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
try {
  const file = path.join(temp, 'transfers.json'), store = createTransfersStore(file);
  assert.equal(store.read().revision, null, 'absent history has no revision');
  const row = {
    name: 'local.fastq.gz', sourceName: 'official.fastq.gz', originalIndex: 17,
    url: 'https://example.invalid/official.fastq.gz', networkMode: 'accelerated',
    engine: 'aria2', downloadEngine: 'aria2', targetDir: 'D:\\original',
    verification: { status: 'verified', expectedMd5: 'a'.repeat(32), actualMd5: 'a'.repeat(32) },
    fileObj: { networkMode: 'accelerated', downloadEngine: 'aria2', md5: 'a'.repeat(32), future: { keep: true } },
    usage: { bytes: 1234, reported: true }, unknownRowField: { nested: ['preserve', 0, false] }
  };
  const extraction = [{ id: 'ex-1', url: 'https://example.invalid/extract', saveDir: 'E:\\extracted',
    received: 128, total: 512, paused: true, futureExtraction: { headers: ['synthetic'], keep: true } }];
  const fixture = { active: [row], completed: [{ ...row, status: 'completed' }], failed: [{ ...row, status: 'failed' }], extraction };
  const originalFixture = JSON.stringify(fixture);
  fs.writeFileSync(file, JSON.stringify({ version: 2, ...fixture }));
  assert.equal(store.read().revision, null, 'old v2 history explicitly returns null');
  const first = store.save(fixture, { expectedRevision: null });
  assert.match(first.revision, uuid);
  assert.equal(JSON.stringify(fixture), originalFixture, 'save must not mutate caller rows');
  for (const field of Object.keys(fixture)) assert.deepEqual(createTransfersStore(file).read()[field], fixture[field], field);
  const second = createTransfersStore(file).save({ completed: [] }, { expectedRevision: first.revision });
  assert.notEqual(first.revision, second.revision);
  for (const field of ['active', 'failed', 'extraction']) assert.deepEqual(second[field], fixture[field], 'partial save preserves ' + field);
  const snapshot = () => ['','.bak','.tmp'].map(suffix => fs.existsSync(file + suffix) ? fs.readFileSync(file + suffix) : null);
  const beforeConflict = snapshot();
  for (const reader of [store, createTransfersStore(file)]) {
    assert.throws(() => reader.save({ completed: [{ name: 'resurrected' }] }, { expectedRevision: first.revision }), { code: 'TRANSFER_HISTORY_CONFLICT' });
    assert.deepEqual(snapshot(), beforeConflict, 'conflict must precede tmp/backup writes');
    assert(!fs.existsSync(file + '.lock'));
  }
  assert.throws(() => store.save({ active: 'invalid' }), /Invalid transfer history/);
  assert.deepEqual(snapshot(), beforeConflict);
  assert(!fs.existsSync(file + '.lock'), 'validation failure releases lock');
  // Legacy callers intentionally remain unconditional: this is not an end-to-end stale UI fix.
  const unconditional = store.save({ completed: fixture.completed });
  assert.match(unconditional.revision, uuid);
  assert.notEqual(unconditional.revision, second.revision);
  assert.deepEqual(unconditional.completed, fixture.completed);
  assert.deepEqual(unconditional.extraction, extraction);
  // Backup recovery keeps its revision; a corrupt primary must not replace the readable backup.
  const backup = fs.readFileSync(file + '.bak');
  fs.writeFileSync(file, '{broken');
  assert.equal(store.read().revision, second.revision);
  const recovered = store.save({ active: [] }, { expectedRevision: second.revision });
  assert.match(recovered.revision, uuid);
  assert.deepEqual(fs.readFileSync(file + '.bak'), backup);
  fs.writeFileSync(file, '{broken'); fs.writeFileSync(file + '.bak', '{broken-backup');
  const corrupt = snapshot();
  assert.throws(() => store.save({ active: [] }));
  assert.deepEqual(snapshot(), corrupt);
  assert(!fs.existsSync(file + '.lock'), 'read failure releases lock');
  const legacy = path.join(temp, 'legacy.json');
  fs.writeFileSync(legacy, JSON.stringify({ completed: fixture.completed }));
  assert.equal(createTransfersStore(legacy).read().revision, null);
  assert.equal(createTransfersStore(legacy).read().legacy, true);
  console.log('TRANSFER_HISTORY_REVISION_OK: UUID/CAS, null legacy revision, unchanged Pro accelerated/engine/verification/fileObj/usage/extraction rows, partial merge, recovery and error release; unconditional callers can still overwrite stale snapshots.');
} finally {
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert(path.basename(resolved).startsWith('biodl-history-revision-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
