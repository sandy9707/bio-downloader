const fs = require('fs');

// Logical size can include sparse holes. Credit only allocated bytes when the
// filesystem exposes them; on Windows an unfinished Axel file stays conservative.
async function additionalSpace(files, destination) {
  let bytes = 0;
  const seen = new Set();
  for (const file of files) {
    const filename = destination(file);
    if (seen.has(filename)) continue;
    seen.add(filename);
    const size = Number(file.size);
    if (!Number.isSafeInteger(size) || size <= 0) continue;
    let allocated = 0;
    try {
      const stat = await fs.promises.stat(filename);
      if (stat.isFile()) {
        allocated = Number.isFinite(stat.blocks) ? Math.min(stat.size, stat.blocks * 512)
          : fs.existsSync(filename + '.st') ? 0 : stat.size;
      }
    } catch (_) { /* Reserve the full size; report per-file path errors in its task. */ }
    bytes += Math.max(0, size - allocated);
  }
  return bytes;
}

module.exports = { additionalSpace };
