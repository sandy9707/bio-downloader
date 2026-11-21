'use strict';
const assert = require('assert/strict');
const { selectLocalNodeGroups } = require('../src/main/local-node-policy');
const group = (id, mbps, aliases = 1) => ({ representative: `${id}-0`, mbps, groupNames: Array.from({ length: aliases }, (_, i) => `${id}-${i}`) });
let cases = 0;
function check(name, fn) { fn(); cases++; console.log(`OK ${name}`); }
for (const fastCount of [0, 3, 4, 5]) {
  check(`${fastCount} tier-1 groups`, () => {
    const fast = Array.from({ length: fastCount }, (_, i) => group(`fast${i}`, 8 + i));
    const mid = Array.from({ length: 4 }, (_, i) => group(`mid${i}`, 2 + i * 0.5));
    const result = selectLocalNodeGroups([...fast, ...mid, group('slow', 0.1)], { candidateAliasCount: fastCount + 5 });
    assert.equal(result.selectedTier, fastCount >= 5 ? 1 : 2);
    assert.equal(result.continuedToTier2, fastCount < 5);
    assert.equal(result.tier1PhysicalCount, fastCount);
    assert.equal(result.selectedGroups.length, fastCount >= 5 ? 5 : fastCount + 4);
  });
}
check('aliases and all-fast shortcut cannot make five groups', () => {
  for (const count of [1, 3, 4]) {
    const groups = Array.from({ length: count }, (_, i) => group(`fast${i}`, 9, 8));
    const result = selectLocalNodeGroups(groups, { candidateAliasCount: count * 8 });
    assert.equal(result.continuedToTier2, true);
    assert.equal(result.selectedTier, 2);
    assert.equal(result.physicalNodeCount, count);
    assert.equal(result.nodeCount, count * 8);
  }
});
check('tier-2 original sufficiency gate and tier-3 measured fallback', () => {
  assert.equal(selectLocalNodeGroups([group('mid', 2)], { candidateAliasCount: 10 }).selectedTier, 3);
  assert.equal(selectLocalNodeGroups([group('mid', 2, 2)], { candidateAliasCount: 10 }).selectedTier, 2);
  assert.equal(selectLocalNodeGroups([group('mid', 2)], { candidateAliasCount: 1 }).selectedTier, 2);
  const result = selectLocalNodeGroups([group('slow', 0.001), group('failed', 0), group('invalid', NaN), group('infinite', Infinity)]);
  assert.equal(result.selectedTier, 3);
  assert.deepEqual(result.passedNames, ['slow-0']);
});
check('no usable sample is not tier 3 or invented nodes', () => {
  for (const input of [[], [group('failed', 0), group('negative', -2)]]) {
    const result = selectLocalNodeGroups(input);
    assert.equal(result.selectedTier, null);
    assert.equal(result.nodeCount, 0);
    assert.equal(result.physicalNodeCount, 0);
  }
});
check('sort by throughput without mutating measurements; preserve thresholds', () => {
  const input = [group('slow', 0.5), group('mid', 2), group('fast', 6)];
  const before = JSON.stringify(input);
  const result = selectLocalNodeGroups(input, { candidateAliasCount: 3 });
  assert.equal(result.selectedTier, 2);
  assert.deepEqual(result.passedNames, ['fast-0', 'mid-0']);
  assert.equal(JSON.stringify(input), before);
  assert.equal(selectLocalNodeGroups([group('custom', 1.5)], { tier2Mbps: 1.5, candidateAliasCount: 1 }).selectedTier, 2);
});
console.log(`LOCAL_NODE_POLICY_OK ${cases} cases`);
