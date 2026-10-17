const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runAria } = require('./download-engines');

// Derive immutable, versioned mirrors only for our own release assets. The
// official manifest remains the authority for SHA256 and patch signatures.
function updateSources(url, backend, accelerated = false) {
  const source = new URL(url, backend), origin = new URL(backend);
  const match = source.pathname.match(/^\/downloads\/(patch-(\d+\.\d+\.\d+(?:-preview\.\d+)?)\.asar|BioDownloader-Linux-x64-(\d+\.\d+\.\d+(?:-preview\.\d+)?)\.tar\.gz)$/);
  if (source.origin !== origin.origin || !match) return [{ url: source.href, label: '更新服务器', proxy: false }];
  const github = `https://github.com/sandy9707/bio-downloader/releases/download/v${match[2] || match[3]}/${match[1]}`;
  source.searchParams.set('source', 'server');
  const mirror = { url: 'https://gh-proxy.org/' + github, label: 'GitHub 镜像', proxy: false };
  const direct = { url: github, label: accelerated ? 'GitHub · 高速通道' : 'GitHub', proxy: accelerated };
  return [
    ...(accelerated ? [direct, mirror] : [mirror, direct]),
    { url: source.href, label: '备用服务器', proxy: false }
  ];
}
async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
async function downloadUpdate({ sources, filename, binary, expectedSha256, onProgress = () => {}, timeoutMs = 180000 }) {
  if (!/^[a-f0-9]{64}$/i.test(expectedSha256 || '')) throw new Error('更新清单缺少有效 SHA256，已中止更新');
  const clean = () => { for (const file of [filename, filename + '.aria2']) fs.rmSync(file, { force: true }); };
  let lastError;
  for (const source of sources) {
    // No resume across mirrors: never combine unverified chunks from sources.
    clean();
    let proc, timedOut = false;
    const timer = setTimeout(() => { timedOut = true; if (proc) proc.kill('SIGKILL'); }, timeoutMs);
    try {
      onProgress({ phase: 'connecting', source: source.label, accelerated: !!source.proxy, percentage: 0 });
      const env = { ...process.env };
      if (process.platform === 'linux') env.LD_LIBRARY_PATH = path.join(path.dirname(binary), 'lib');
      await runAria({ binary, url: source.url, filename, threads: 16, env,
        proxy: source.proxy ? (typeof source.proxy === 'string' ? source.proxy : 'http://127.0.0.1:43289') : '',
        onProcess(child) { proc = child; },
        onProgress(data) { onProgress({ ...data, phase: 'downloading', source: source.label, accelerated: !!source.proxy }); }
      });
      if (timedOut) throw new Error('更新源响应超时');
      onProgress({ phase: 'verifying', source: source.label });
      if (await sha256(filename) !== expectedSha256.toLowerCase()) throw new Error('更新包 SHA256 校验失败');
      return { source: source.label };
    } catch (error) {
      lastError = error;
      onProgress({ phase: 'retrying', source: source.label });
    } finally { clearTimeout(timer); }
  }
  clean();
  throw new Error('所有更新下载源均失败，当前版本未更改：' + (lastError?.message || '无可用下载源'));
}
module.exports = { updateSources, downloadUpdate, sha256 };
