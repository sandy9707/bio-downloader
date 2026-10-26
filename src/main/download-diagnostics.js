'use strict';

// Never serialize Axios errors wholesale: config/request/headers can contain
// account tokens and proxy credentials. Keep only bounded diagnostic fields.
function redact(value) {
  return String(value ?? '')
    .replace(/\b(?:https?|s?ftp):\/\/[^\s"'<>]+/gi, text => {
      try {
        const url = new URL(text);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        if (['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) url.pathname = '/[local]';
        return url.href;
      } catch (_) { return '[URL redacted]'; }
    })
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [redacted]')
    .replace(/((?:token|password|secret|authorization|cookie|api[-_]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 2000);
}
function errorDetails(error, depth = 0) {
  if (!error) return null;
  const detail = { name: redact(error.name || 'Error'), message: redact(error.message || error) };
  for (const key of ['code', 'syscall']) if (error[key] !== undefined) detail[key] = redact(error[key]);
  const status = error.status ?? error.response?.status;
  if (Number.isInteger(status)) detail.httpStatus = status;
  for (const key of ['retryable', 'resumable']) if (typeof error[key] === 'boolean') detail[key] = error[key];
  if (error.range && Number.isSafeInteger(error.range.start) && Number.isSafeInteger(error.range.end)) detail.range = { start: error.range.start, end: error.range.end };
  if (Number.isSafeInteger(error.receivedBytes)) detail.receivedBytes = error.receivedBytes;
  if (error.cause && error.cause !== error && depth < 2) detail.cause = errorDetails(error.cause, depth + 1);
  return detail;
}
function formatDiagnostic(record) {
  return '[diagnostic] ' + JSON.stringify({ time: new Date().toISOString(), ...record }, (_key, value) => typeof value === 'string' ? redact(value) : value) + '\n';
}
module.exports = { redact, errorDetails, formatDiagnostic };
