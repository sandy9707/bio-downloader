const fs = require('fs');
const path = require('path');

const fields = ['completed', 'failed', 'active', 'extraction'];
function parseHistory(text) {
  const data = JSON.parse(text);
  if (!data || !fields.some(field => Array.isArray(data[field]))) throw new Error('Missing transfer history fields');
  return { ...normalize(data), legacy: data.version !== 2 };
}
function normalize(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid transfer history');
  const result = { version: 2 };
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

  function save(data) {
    const current = read();
    const next = { ...current };
    for (const field of fields) {
      if (Object.prototype.hasOwnProperty.call(data, field)) next[field] = data[field];
    }
    const updated = normalize(next);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
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
