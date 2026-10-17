const fs = require('fs');
const crypto = require('crypto');
const downloadFiles = require('./download-files');
const { bioSource } = require('./bio-transfer-guard');
const { verifyFile } = require('./download-integrity');

// One local disk reader at a time, independent of download scheduling/billing.
function createManualMd5(reference) {
  let active = null;
  return {
    cancel(id) {
      if (!active || active.id !== id) return false;
      active.cancelled = true;
      active.interrupt?.();
      return true;
    },
    async verify({ id, savePath, file }, notify = () => {}) {
      if (active) throw new Error('已有 MD5 校验正在进行，请等待完成或停止校验');
      if (!id || typeof savePath !== 'string' || !savePath) throw new Error('缺少文件路径，无法校验');
      const job = { id, cancelled: false };
      active = job;
      const checkControl = () => { if (job.cancelled) throw new Error('MD5 校验已停止'); };
      let lastProgress = 0, release;
      try {
        release = downloadFiles.claimFile(savePath);
        // Detect moved/deleted files before spending time querying metadata.
        if (!(await fs.promises.stat(savePath)).isFile()) throw new Error('目标不是普通文件');
        if (downloadFiles.hasResume(savePath)) throw new Error('文件仍有下载断点，请先恢复下载完成后再校验');
        notify({ id, phase: 'reference' });
        checkControl();
        const ref = await Promise.race([
          reference(file, { deep: true, refresh: true }),
          new Promise((_resolve, reject) => { job.interrupt = () => reject(new Error('MD5 校验已停止')); })
        ]);
        job.interrupt = null;
        checkControl();
        const verification = await verifyFile(savePath, ref, {
          deep: true, computeWithoutReference: true, checkControl,
          onProgress(bytes, total) {
            const now = Date.now();
            if (now - lastProgress < 250 && bytes !== total) return;
            lastProgress = now;
            notify({ id, phase: 'hashing', bytes, total });
          }
        });
        verification.checkedAt = new Date().toISOString();
        // Keep the downloader's existing-file decision aware of a manual MD5
        // mismatch. Never create a resume record or claim a partial file complete.
        const sidecar = savePath + '.biodl.json';
        const source = bioSource(file.url);
        const sourceKey = source && crypto.createHash('sha256').update(source).digest('hex');
        if (sourceKey && ['verified', 'mismatch'].includes(verification.status) && fs.existsSync(sidecar)) {
          const before = await fs.promises.stat(sidecar);
          if (before.size <= 1024 * 1024) {
            const state = JSON.parse(await fs.promises.readFile(sidecar, 'utf8'));
            const after = await fs.promises.stat(sidecar);
            if (state.version === 1 && state.sourceKey === sourceKey && state.completed === true && state.size === verification.actualSize && before.mtimeMs === after.mtimeMs && !downloadFiles.hasResume(savePath)) {
              const tmp = sidecar + '.md5.tmp';
              await fs.promises.writeFile(tmp, JSON.stringify({ ...state, verification }), { mode: 0o600 });
              await fs.promises.rename(tmp, sidecar);
            }
          }
        }
        await downloadFiles.persistVerification(savePath, file.url, verification);
        return { verification };
      } catch (error) {
        if (job.cancelled) return { cancelled: true };
        if (error.verification) return { verification: error.verification };
        if (error.code === 'ENOENT') throw new Error('找不到本地文件，可能已移动或删除，请先定位文件');
        throw error;
      } finally { release?.(); active = null; }
    }
  };
}
module.exports = { createManualMd5 };
