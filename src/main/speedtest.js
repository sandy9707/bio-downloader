const axios = require('axios');
const fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const { ariaArgs, ariaEnvironment, ariaWorkingDirectory } = require('./download-engines');
const { startNativeDownload } = require('./native-download');
const { createBioTransferGuard } = require('./bio-transfer-guard');
const duration = ms => Math.max(250, Math.min(30000, Number(ms) || 10000));
function meter(onProgress, started) {
  let bytes = 0, last = 0, totalBytes = null;
  const snapshot = () => {
    const elapsedSeconds = Math.max(0.001, (Date.now() - started) / 1000);
    return { bytesReceived: bytes, totalBytes, elapsedSeconds, bytesPerSecond: bytes / elapsedSeconds };
  };
  return {
    add(n) { bytes += n; if (Date.now() - last >= 200) { last = Date.now(); onProgress(snapshot()); } },
    total(n) { if (Number(n) > 0) totalBytes = Number(n); },
    result() { const data = snapshot(); onProgress(data); return bytes > 0 ? { success: true, ...data } : { success: false, error: '测速超时或未收到文件数据' }; }
  };
}
async function measureNetwork({ url, timeoutMs, onProgress = () => {} }) {
  const started = Date.now(), counter = meter(onProgress, started), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), duration(timeoutMs));
  try {
    const response = await axios.get(url, { proxy: false, signal: controller.signal, responseType: 'stream', maxRedirects: 5, timeout: duration(timeoutMs) });
    counter.total(response.headers['content-length']);
    if (/text\/html/i.test(response.headers['content-type'] || '')) { response.data.destroy(); throw new Error('测速地址返回了网页而非文件'); }
    for await (const chunk of response.data) counter.add(chunk.length);
    return counter.result();
  } catch (e) {
    return controller.signal.aborted ? counter.result() : { success: false, error: '测速失败: ' + e.message };
  } finally { clearTimeout(timer); }
}
async function measureDownloader({ url, axelBin, binary = axelBin, engine = 'axel', proxy = false, timeoutMs, expectedSizeMB = 200, onProgress = () => {} }) {
  const started = Date.now(), counter = meter(onProgress, started);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'biodl-speedtest-'));
  let nativeTask;
  let guard, proc, timer, stopped = false, received = 0;
  try {
    if (engine === 'native') {
      nativeTask = startNativeDownload({ url, filename: path.join(dir, 'sample.bin'), proxy, connections: 8,
        timeoutMs: Math.min(5000, duration(timeoutMs)) }, event => {
        if (event.type === 'progress') { const delta = Math.max(0, event.networkBytes - received); received = event.networkBytes; counter.add(delta); }
        if (received >= (Number(expectedSizeMB) || 200) * 1024 * 1024) stop();
      });
      timer = setTimeout(stop, duration(timeoutMs));
      try { await nativeTask.promise; } catch (error) { if (!stopped) throw error; }
      return counter.result();
    }
    // Reuse the real range-checked download path. Count network chunks instead of
    // sparse/preallocated file length, which can be the full file immediately.
    guard = await createBioTransferGuard({ url, engine, filename: path.join(dir, 'sample.bin'), proxy,
      timeout: Math.min(5000, duration(timeoutMs)),
      checkControl: async () => { if (Date.now() - started >= duration(timeoutMs)) throw new Error('测速连接超时'); },
      onBytes(n) { received += n; counter.add(n); if (received >= (Number(expectedSizeMB) || 200) * 1024 * 1024) stop(); }
    });
    const env = engine === 'aria2' ? ariaEnvironment(binary) : { ...process.env };
    for (const key of ['http_proxy','https_proxy','all_proxy','HTTP_PROXY','HTTPS_PROXY','ALL_PROXY']) delete env[key];
    if (engine === 'aria2' && process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(path.dirname(binary), 'lib');
    proc = spawn(binary, engine === 'aria2' ? ariaArgs({ url: guard.url, filename: path.join(dir, 'sample.bin'), threads: 16, binary }) : ['-n', '16', '-k', '-o', path.join(dir, 'sample.bin'), guard.url], { env, cwd: engine === 'aria2' ? ariaWorkingDirectory(binary) : undefined, windowsHide: true });
    let errorText = '';
    proc.stderr.on('data', d => { errorText = (errorText + d).slice(-2000); });
    proc.stdout.resume();
    timer = setTimeout(stop, Math.max(1, duration(timeoutMs) - (Date.now() - started)));
    const code = await new Promise((resolve, reject) => { proc.once('error', reject); proc.once('close', resolve); });
    if (!stopped && code !== 0) throw new Error(errorText.trim().slice(0, 300) || engine + ' 退出码 ' + code);
    return counter.result();
  } catch (e) { return { success: false, error: '测速失败: ' + e.message }; }
  finally {
    clearTimeout(timer);
    if (guard) await guard.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  function stop() { if (nativeTask && !stopped) { stopped = true; nativeTask.cancel(); } if (!stopped && proc) { stopped = true; proc.kill('SIGKILL'); } }
}
module.exports = { measureNetwork, measureDownloader };
