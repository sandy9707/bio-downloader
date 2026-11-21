'use strict';

// Input groups have already been deduplicated by airport + route name and sampled
// locally. Neither a group nor an account alias proves an independent egress IP.
function selectLocalNodeGroups(measuredGroups, { tier1Mbps = 6, tier2Mbps = 2, candidateAliasCount } = {}) {
  const ranked = measuredGroups.filter(item => Number.isFinite(item.mbps) && item.mbps > 0)
    .slice().sort((a, b) => b.mbps - a.mbps);
  const tier1Groups = ranked.filter(item => item.mbps >= tier1Mbps);
  const tier2Groups = ranked.filter(item => item.mbps >= tier2Mbps);
  const aliases = list => [...new Set(list.flatMap(item => item.groupNames))];
  const totalAliases = candidateAliasCount ?? aliases(measuredGroups).length;
  const continuedToTier2 = tier1Groups.length < 5;
  let selectedGroups = [], selectedTier = null;
  if (!continuedToTier2) {
    selectedGroups = tier1Groups;
    selectedTier = 1;
  } else if (tier2Groups.length > 0 && (
    aliases(tier2Groups).length >= Math.min(totalAliases, 4)
    || (tier2Groups.length > tier1Groups.length && aliases(tier2Groups).length >= 2)
  )) {
    // Preserve the existing tier-2 sufficiency gate; five is only the tier-1
    // stopping threshold, not a reason to discard working smaller pools.
    selectedGroups = tier2Groups;
    selectedTier = 2;
  } else if (ranked.length) {
    selectedGroups = ranked;
    selectedTier = 3;
  }
  const passedNames = aliases(selectedGroups);
  return { selectedGroups, selectedTier, passedNames, continuedToTier2,
    tier1PhysicalCount: tier1Groups.length, physicalNodeCount: selectedGroups.length,
    nodeCount: passedNames.length };
}

// Expand strategy references, but never manufacture nodes from group labels or
// DIRECT/REJECT. Unselected configured proxies remain a second-stage candidate set.
function enumerateLocalNodeCandidates(config) {
  const informational = /剩余流量|套餐到期|距离下次|官网地址|套餐订阅已过期|请去官网/;
  const proxies = new Map((Array.isArray(config.proxies) ? config.proxies : [])
    .filter(p => p && typeof p.name === 'string' && p.name && typeof p.type === 'string'
      && !informational.test(p.name) && !/^(DIRECT|REJECT|REJECT-DROP|PASS)$/i.test(p.name)
      && !/^(direct|reject)$/i.test(p.type)).map(p => [p.name, p]));
  const groups = new Map((Array.isArray(config['proxy-groups']) ? config['proxy-groups'] : [])
    .filter(g => g && typeof g.name === 'string').map(g => [g.name, g]));
  const primary = new Set();
  function expand(name, visited = new Set()) {
    if (proxies.has(name)) { primary.add(name); return; }
    if (visited.has(name)) return;
    const group = groups.get(name);
    if (!Array.isArray(group?.proxies)) return;
    const next = new Set([...visited, name]);
    group.proxies.forEach(child => expand(child, next));
  }
  expand('⚡ 多账号并发下载池');
  const primaryNames = [...primary];
  const secondaryNames = [...proxies.keys()].filter(name => !primary.has(name));
  return { primaryNames, secondaryNames, candidateNames: [...primaryNames, ...secondaryNames] };
}

module.exports = { selectLocalNodeGroups, enumerateLocalNodeCandidates };
