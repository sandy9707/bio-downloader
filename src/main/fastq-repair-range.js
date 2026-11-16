'use strict';
// Pure acceptance gate; callers must also bound streaming reads and fix source URL.
// A valid range is evidence for candidate bytes, not proof of whole-file integrity.
function unsafe(message) {
  throw Object.assign(new Error('局部修复响应不安全：' + message), { code: 'REPAIR_RANGE_UNSAFE' });
}
function strongEtag(value) {
  return typeof value === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(value);
}
function validateRepairHeaders(expected, response) {
  if (!expected || !response) unsafe('缺少范围信息');
  const { start, end, size, etag, maxBytes } = expected;
  for (const value of [start, end, size, maxBytes]) if (!Number.isSafeInteger(value)) unsafe('范围必须为安全整数');
  if (start < 0 || end <= start || size <= 0 || end > size || maxBytes <= 0 || end - start > maxBytes) unsafe('超出文件或补取预算');
  if (!strongEtag(etag)) unsafe('需要强 ETag 固定源版本');
  if (response.status !== 206) unsafe('源站未返回精确分段');
  const headers = response.headers || {};
  if (headers.etag !== etag || !strongEtag(headers.etag)) unsafe('源版本不一致');
  if (headers['content-range'] !== `bytes ${start}-${end - 1}/${size}`) unsafe('分段位置或总大小不符');
  if (headers['content-encoding'] && String(headers['content-encoding']).toLowerCase() !== 'identity') unsafe('响应经过编码');
  const length = end - start;
  if (headers['content-length'] !== undefined && String(headers['content-length']) !== String(length)) unsafe('声明长度不符');
  return length;
}
function validateRepairRange(expected, response) {
  const length = validateRepairHeaders(expected, response);
  if (!Buffer.isBuffer(response.data) || response.data.length !== length) unsafe('实际字节长度不符');
  return response.data;
}
module.exports = { validateRepairRange, validateRepairHeaders };
