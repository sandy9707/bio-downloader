const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const { createTransfersStore } = require('../src/main/transfers-store');
const root = path.resolve(__dirname, '..');
const renderer = fs.readFileSync(path.join(root, 'renderer.js'), 'utf8');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-transfers-test-'));
const filename = path.join(temp, 'data', 'transfers.json');
const store = createTransfersStore(filename);
const fixture = {
  completed: [{ name: 'done.sra', savePath: 'D:\\data\\done.sra' }],
  failed: [{ name: 'retry.sra', url: 'https://example.invalid/retry' }],
  active: [
    { name: 'running.sra', url: 'https://example.invalid/running', originalIndex: 0, status: 'downloading', percentage: 25, receivedBytes: 256, targetDir: 'D:\\original', md5: '12345678901234567890123456789012' },
    { name: 'queued.sra', originalIndex: 1, status: 'waiting', targetDir: 'D:\\original' },
    { name: 'paused.sra', originalIndex: 2, status: 'paused', targetDir: 'D:\\original' }
  ],
  extraction: [{ id: 'ex1', name: 'extracted.fastq', url: 'https://example.invalid/extracted', received: 128, total: 512, saveDir: 'E:\\extracted' }]
};

function harness(historyStore, cache = new Map()) {
  const events = {}, listeners = {}, messages = [];
  const context = vm.createContext({
    console: { error() {}, warn() {} }, Date, JSON, Object, Array,
    completedDownloads: [], failedDownloads: [], activeDownloads: [], extractionJobs: {}, defaultDir: 'C:\\new-default',
    localStorage: { getItem: key => cache.get(key) || null, setItem: (key, value) => cache.set(key, value) },
    setTimeout: fn => { events.timer = fn; return 1; }, clearTimeout: () => { delete events.timer; },
    document: { getElementById: () => null },
    showToast: (...args) => messages.push(args),
    renderCompletedList() {}, renderFailedList() {}, renderDownloadingList() {}, renderExtractionTransferCards() {}, updateGlobalTotalSpeed() {},
    window: {
      addEventListener: (name, fn) => { events[name] = fn; },
      api: {
        getTransfersHistory: async () => historyStore.read(),
        saveTransfersHistory: async data => historyStore.save(JSON.parse(JSON.stringify(data))),
        flushTransfersHistory: data => historyStore.save(JSON.parse(JSON.stringify(data))),
        onDownloadStatus: fn => { listeners.status = fn; },
        onDownloadProgress: fn => { listeners.progress = fn; }
      }
    }
  });
  const start = renderer.indexOf('// Persist every transfer category');
  const end = renderer.indexOf('// 载入历史与并发数', start);
  vm.runInContext(renderer.slice(start, end), context);
  context.updateTransferCounts = () => context.syncTransfersToStorage();
  vm.runInContext(renderer.slice(renderer.indexOf('window.api.onDownloadStatus('), renderer.indexOf('// 绑定到 window 暴露给 HTML 属性')), context);
  vm.runInContext(renderer.slice(renderer.indexOf('function handleExtractionDownload('), renderer.indexOf('function renderExtractionTransferCards(')), context);
  return { context, events, listeners, cache, messages };
}

(async () => {
  assert.equal(store.read().exists, false);
  // Two independent processes use the actual disk store, including Windows destination strings.
  const modulePath = path.join(root, 'src/main/transfers-store.js');
  execFileSync(process.execPath, ['-e', `require(${JSON.stringify(modulePath)}).createTransfersStore(process.argv[1]).save(JSON.parse(require('fs').readFileSync(0,'utf8')))`, filename], { input: JSON.stringify(fixture) });
  const restarted = JSON.parse(execFileSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(modulePath)}).createTransfersStore(process.argv[1]).read()))`, filename], { encoding: 'utf8' }));
  assert.equal(restarted.active.length, 3);
  assert.equal(restarted.extraction[0].saveDir, 'E:\\extracted');
  assert.equal(restarted.completed.length, 1);
  assert.equal(restarted.failed.length, 1);

  const h = harness(store);
  h.context.syncTransfersToStorage();
  assert.equal(store.read().active.length, 3, 'an uninitialized renderer must not erase disk history');
  await h.context.loadTransferHistory({ defaultDir: 'C:\\new-default' });
  assert.ok(h.context.activeDownloads.every(t => t.status === 'paused' && t.originalIndex > 9999));
  assert.equal(h.context.activeDownloads[0].targetDir, 'D:\\original');
  assert.equal(Object.values(h.context.extractionJobs)[0].paused, true);
  assert.equal(Object.values(h.context.extractionJobs)[0].received, 128);

  const active = h.context.activeDownloads[0];
  assert.equal(active.md5, fixture.active[0].md5, 'checksum must survive history recovery');
  h.listeners.progress({ index: active.originalIndex, percentage: 50, speed: '1 MB/s', receivedBytes: 512, totalBytes: 1024 });
  h.events.beforeunload();
  assert.equal(store.read().active[0].receivedBytes, 512, 'quit must flush progress without waiting for debounce');
  h.listeners.status({ index: active.originalIndex, status: 'completed', savePath: 'D:\\original\\running.sra', verification: { status: 'verified', actualMd5: active.md5 } });
  assert.equal(store.read().active.length, 2);
  assert.equal(store.read().completed.length, 2, 'terminal event must persist only one final category');
  assert.equal(store.read().completed[0].verification.status, 'verified');
  assert.equal(store.read().completed[0].fileObj.md5, active.md5);
  const extractionId = Object.keys(h.context.extractionJobs)[0];
  h.context.handleExtractionDownload({ id: extractionId, status: 'completed', savePath: 'E:\\extracted\\extracted.fastq', size: 512 });
  assert.equal(store.read().extraction.length, 0);
  assert.equal(store.read().completed.length, 3);

  const pending = h.context.activeDownloads[0];
  h.listeners.status({ index: pending.originalIndex, status: 'failed', savePath: 'D:\\original\\bad.fastq.gz', md5: active.md5, verification: { status: 'failed', actualMd5: 'bad-checksum' } });
  assert.equal(store.read().failed[0].fileObj.md5, active.md5);
  assert.equal(store.read().failed[0].verification.actualMd5, 'bad-checksum');
  assert.equal(store.read().failed[0].savePath, 'D:\\original\\bad.fastq.gz');

  // Persisted verification warnings must remain visible in the completed list.
  const cards = [];
  const ui = vm.createContext({
    completedDownloads: [{ name: 'unverified.fastq.gz', verification: { status: 'unavailable' } }, { name: 'old.bin', skip: true }, { name: 'mismatch.gz', verification: { status: 'mismatch' } }, { name: 'quick.gz', verification: { status: 'quick-checked' } }],
    document: {
      getElementById: id => id === 'transferCompletedList' ? { querySelectorAll: () => [], appendChild: card => cards.push(card) } : null,
      createElement: () => ({ dataset: {} })
    },
    matchesTransferSearch: () => true, getFileTypeIcon: () => '', getFileTypeBadge: () => '', formatBytes: () => '', escapeHtml: value => value
  });
  vm.runInContext(renderer.slice(renderer.indexOf('function renderCompletedList()'), renderer.indexOf('function renderFailedList()')), ui);
  ui.renderCompletedList();
  assert.match(cards[0].innerHTML, /MD5 未核验/);
  assert.match(cards[1].innerHTML, /大小匹配/);
  assert.ok(!cards[1].innerHTML.includes('已校验'), 'old size-only skips must not claim checksum verification');
  assert.match(cards[2].innerHTML, /与参考值不一致，需核对/);
  assert.match(cards[3].innerHTML, /快速检查通过（未做 MD5）/);

  // Existing empty histories are not repopulated from stale browser cache.
  store.save({ completed: [], failed: [], active: [], extraction: [] });
  const cleared = harness(store, new Map([['completed_downloads', JSON.stringify(fixture.completed)]]));
  await cleared.context.loadTransferHistory();
  assert.equal(cleared.context.completedDownloads.length, 0);
  // Migration retains 2.0.41 completed/failed files and localStorage-only histories.
  const legacyPath = path.join(temp, 'legacy.json');
  fs.writeFileSync(legacyPath, JSON.stringify({ completed: fixture.completed, failed: fixture.failed }));
  const legacy = createTransfersStore(legacyPath);
  legacy.save({ active: fixture.active });
  assert.equal(legacy.read().completed.length, 1);
  const migrated = harness(createTransfersStore(path.join(temp, 'new.json')), new Map([['failed_downloads', JSON.stringify(fixture.failed)]]));
  await migrated.context.loadTransferHistory();
  assert.equal(migrated.context.failedDownloads.length, 1);
  migrated.context.syncTransfersToStorage();

  const oldEmptyPath=path.join(temp,'old-empty.json');
  fs.writeFileSync(oldEmptyPath,JSON.stringify({completed:[],failed:[]}));
  const oldEmpty=harness(createTransfersStore(oldEmptyPath),new Map([['failed_downloads',JSON.stringify(fixture.failed)]]));
  await oldEmpty.context.loadTransferHistory();
  assert.equal(oldEmpty.context.failedDownloads.length,1,'2.0.41 empty disk file must migrate legacy browser records');

  // Corrupt primary recovers from a readable backup; two corrupt files remain untouched.
  store.save(fixture);
  store.save(fixture);
  fs.writeFileSync(filename, '{}');
  assert.equal(createTransfersStore(filename).read().active.length, 3);
  store.save({ failed: [] });
  assert.equal(store.read().active.length, 3);
  assert.equal(JSON.parse(fs.readFileSync(filename+'.bak')).active.length,3);
  fs.writeFileSync(filename, '{broken');
  fs.writeFileSync(filename + '.bak', '{broken-backup');
  assert.throws(() => store.save({ completed: [] }));
  assert.equal(fs.readFileSync(filename, 'utf8'), '{broken');

  const boot = renderer.slice(renderer.indexOf("window.addEventListener('DOMContentLoaded', async () => {"), renderer.indexOf('// 【主题切换】'));
  assert.ok(boot.indexOf('await initTransfersAndSettings') < boot.indexOf('await verifyToken'), 'offline login must not block local history');
  assert.ok(renderer.includes('const dir = file.targetDir || defaultDir'), 'resuming must use the original destination');
  console.log('传输持久化回归通过：跨进程重启、下载/排队/暂停/提取恢复、关闭刷新、完成归档、旧记录迁移、清空不复活、损坏备份恢复');
})().finally(() => fs.rmSync(temp, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
