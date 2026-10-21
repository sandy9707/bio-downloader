'use strict';
const path = require('path');
const { Worker } = require('worker_threads');
let activeWorkers = 0;
const waiting = [];
function acquireWorker(start) {
  const request = { start };
  waiting.push(request);
  const pump = () => {
    while (activeWorkers < 8 && waiting.length) {
      const next = waiting.shift(); activeWorkers++;
      next.start(() => { activeWorkers--; pump(); });
    }
  };
  pump();
  return () => { const index = waiting.indexOf(request); if (index >= 0) waiting.splice(index, 1); };
}

// Keep the logical task alive while paused: resume never creates a second
// scheduler/billing task. Each run closes its files before another worker starts.
function startNativeDownload(options, onEvent = () => {}) {
  options = { ...options, connections: Math.max(1, Math.min(4, options.connections || 4)) };
  let worker, timer, cancelWaiting, settled = false, state = 'running', cancelRequested = false;
  let resolveRun, rejectRun, resolvePause;
  const started = Date.now(), promise = new Promise((resolve, reject) => { resolveRun = resolve; rejectRun = reject; });
  const emit = event => { try { onEvent(event); } catch (_) {} };
  function finish(error, result) {
    if (settled) return;
    settled = true; state = 'finished'; clearTimeout(timer); resolvePause?.();
    error ? rejectRun(error) : resolveRun(result);
  }
  function paused() {
    if (cancelRequested) return finish(new Error('Cancelled'));
    state = 'paused'; emit({ type: 'state', phase: 'paused' }); resolvePause?.(); resolvePause = null;
  }
  function launch() {
    if (settled || cancelRequested) return;
    state = 'running'; let message;
    emit({ type: 'state', phase: 'waiting-slot' });
    cancelWaiting = acquireWorker(releaseSlot => {
    try { worker = new Worker(path.join(__dirname, 'native-transfer-worker.js'), { workerData: options }); }
    catch (error) { releaseSlot(); finish(error); return; }
    worker.on('message', data => { if (data.event) emit(data.event); else message = data; });
    worker.on('error', error => { message = { error: { code: 'WORKER_ERROR', message: error.message } }; });
    worker.once('exit', code => {
      releaseSlot();
      worker = null;
      if (cancelRequested) return finish(new Error('Cancelled'));
      if (message?.result?.status === 'completed') return finish(null, message.result);
      if (message?.result?.status === 'paused') return paused();
      const error = Object.assign(new Error(message?.error?.message || `下载内核异常退出 (${code})；断点保留`), { code: message?.error?.code || 'WORKER_EXIT' });
      // A freshly restarted application can encounter its previous stale lock.
      // Wait for the lock library to expire it; never delete a live writer's lock.
      if (error.code === 'ELOCKED' && Date.now() - started < 20000) {
        if (state === 'pausing') return paused();
        emit({ type: 'state', phase: 'waiting-lock' }); timer = setTimeout(launch, 1000); return;
      }
      finish(error);
    });
    });
  }
  launch();
  return {
    promise,
    get state() { return state; },
    pause() {
      if (settled || state === 'paused') return Promise.resolve();
      if (state === 'pausing') return this.pausePromise;
      state = 'pausing'; this.pausePromise = new Promise(resolve => { resolvePause = resolve; });
      clearTimeout(timer); if (worker) worker.postMessage('pause'); else { cancelWaiting?.(); paused(); }
      return this.pausePromise;
    },
    resume() { if (state !== 'paused' || settled || cancelRequested) return false; launch(); return true; },
    cancel() {
      cancelRequested = true; clearTimeout(timer);
      if (worker) worker.postMessage('pause'); else { cancelWaiting?.(); finish(new Error('Cancelled')); }
      return promise.catch(() => {});
    }
  };
}
const nativeReceiptKey = token => require('crypto').createHash('sha256').update(String(token)).digest('hex');
async function acknowledgeNativeDownload(filename, transferId, token) {
  const release = await require('proper-lockfile').lock(filename, { realpath: false, retries: 0 });
  let journal;
  try {
    journal = await require('./native-transfer/journal').Journal.open(filename + '.biodl-journal');
    if (journal.records[0]?.transferId !== transferId) throw new Error('下载任务标识已变化，不能记录流量确认');
    await journal.append({ type: 'receipt', accountKey: nativeReceiptKey(token) });
  } finally { try { await journal?.close(); } finally { await release(); } }
}
module.exports = { startNativeDownload, acknowledgeNativeDownload, nativeReceiptKey };
