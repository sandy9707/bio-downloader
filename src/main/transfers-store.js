const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const lockfile = require('proper-lockfile');

const fields = ['completed', 'failed', 'active', 'extraction'];
function parseHistory(text) {
  const data = JSON.parse(text);
  if (!data || !fields.some(field => Array.isArray(data[field]))) throw new Error('Missing transfer history fields');
  return { ...normalize(data), legacy: data.version !== 2 };
}
function normalize(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid transfer history');
  if (data.revision != null && (typeof data.revision !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(data.revision))) throw new Error('Invalid transfer history revision');
  const result = { version: 2, revision: data.revision || null };
  for (const field of fields) {
    if (data[field] !== undefined && !Array.isArray(data[field])) throw new Error('Invalid transfer history: ' + field);
    result[field] = (data[field] || []).filter(item => item && typeof item === 'object');
  }
  return result;
}

function createTransfersStore(filename) {
  function read() {
    let error;
    for (const candidate of [filename, filename + '.bak']) {
      if (!fs.existsSync(candidate)) continue;
      try {
        return { ...parseHistory(fs.readFileSync(candidate, 'utf8')), exists: true };
      } catch (e) { error = e; }
    }
    if (error) throw error; // Do not turn unreadable history into an empty list and overwrite it.
    return { ...normalize({}), exists: false };
  }

  // Optional CAS only: legacy unconditional callers can still submit stale snapshots.
  function save(data, { expectedRevision } = {}) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    let release;
    try {
      release = lockfile.lockSync(filename, { realpath: false, retries: 0, stale: 30000 });
    } catch (error) {
      if (error.code === 'ELOCKED') throw Object.assign(new Error('传输记录正在由另一进程保存，请重新读取后重试'), { code: 'TRANSFER_HISTORY_CONFLICT' });
      throw error;
    }
    try { return saveLocked(data, expectedRevision); } finally { release(); }
  }

  function saveLocked(data, expectedRevision) {
    // Fresh read, compare and merge all belong inside the same disk transaction.
    const current = read();
    if (expectedRevision !== undefined && expectedRevision !== current.revision) {
      throw Object.assign(new Error('传输记录已更新，请重新读取后再保存'), { code: 'TRANSFER_HISTORY_CONFLICT' });
    }
    const next = { ...current };
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) next[field] = data[field];
    }
    const updated = { ...normalize(next), revision: randomUUID() };
    const tmp = filename + '.tmp';
    const fd = fs.openSync(tmp, 'w', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(updated, null, 2), 'utf8');
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    // Preserve the last readable revision, including when recovering a broken primary file.
    if (fs.existsSync(filename)) {
      try {
        parseHistory(fs.readFileSync(filename, 'utf8'));
        fs.copyFileSync(filename, filename + '.bak');
      } catch (_) { /* The readable backup must not be replaced by corrupt data. */ }
    }
    fs.renameSync(tmp, filename);
    return { ...updated, exists: true };
  }
  return { read, save };
}

module.exports = { createTransfersStore };
