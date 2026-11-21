'use strict';
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), assert = require('node:assert/strict');
const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
async function probe(axios, expected) {
  const logs = [];
  const c = vm.createContext({ axios, AbortController, setTimeout, clearTimeout, writeClashLog: s => logs.push(s) });
  vm.runInContext(source.slice(source.indexOf('async function measureProxyThroughputMbps('), source.indexOf('async function validateLocalClashNodes(')), c);
  assert.equal(await c.measureProxyThroughputMbps(43310, 'https://fixture.invalid/private?token=DO_NOT_LOG', 65536, 10), 0);
  assert.ok(logs.some(s => s.includes(expected)));
  assert.ok(logs.every(s => !s.includes('DO_NOT_LOG') && !s.includes('/private')));
}
(async () => {
  await probe(async () => ({ status: 403, data: { destroy() {} } }), 'http=403');
  await probe(async () => { const e = new Error('https://private?token=DO_NOT_LOG'); e.code = 'ECONNREFUSED'; throw e; }, 'error=ECONNREFUSED');
  await probe(async () => ({ status: 206, data: { async *[Symbol.asyncIterator]() { yield Buffer.alloc(10); }, destroy() {} } }), 'bytes=10');
  console.log('CLASH_PROBE_DIAGNOSTICS_OK: status/error/short-read without credentials or request paths');
})().catch(e => { console.error(e); process.exitCode = 1; });
