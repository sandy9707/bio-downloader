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

module.exports = { selectLocalNodeGroups };
