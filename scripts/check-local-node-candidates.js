'use strict';
const assert = require('node:assert/strict');
const { enumerateLocalNodeCandidates } = require('../src/main/local-node-policy');
const nodes = Array.from({ length: 12 }, (_, i) => ({ name: `route-${i}`, type: 'ss' }));
const config = { proxies: [...nodes, { name: '剩余流量 info', type: 'ss' }, { name: 'DIRECT', type: 'direct' }], 'proxy-groups': [
  { name: '⚡ 多账号并发下载池', proxies: ['nested', 'route-0', 'DIRECT', 'REJECT', 'missing'] },
  { name: 'nested', proxies: [...nodes.slice(0, 9).map(p => p.name), 'cycle', '剩余流量 info'] },
  { name: 'cycle', proxies: ['nested'] }
] };
const result = enumerateLocalNodeCandidates(config);
assert.deepEqual(result.primaryNames, nodes.slice(0, 9).map(p => p.name));
assert.deepEqual(result.secondaryNames, nodes.slice(9).map(p => p.name));
assert.equal(result.candidateNames.length, 12);
assert.deepEqual(enumerateLocalNodeCandidates({ proxies: nodes }).primaryNames, []);
assert.equal(enumerateLocalNodeCandidates({ proxies: nodes }).secondaryNames.length, 12);
assert.deepEqual(enumerateLocalNodeCandidates({}).candidateNames, []);
console.log('LOCAL_NODE_CANDIDATES_OK: nine pool routes do not hide other configured candidates; nested, cyclic, reserved and informational refs');
