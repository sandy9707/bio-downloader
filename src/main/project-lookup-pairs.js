'use strict';

// Compare mates within a lane and extension. GSA-Human uses both f1/r2 and
// r1/r2; ENA often uses _1/_2 and an extra unsuffixed file of unpaired reads.
function missingMates(files, layout) {
  const mode = String(layout || '').trim().toUpperCase();
  if (mode === 'SINGLE') return false;
  const groups = new Map();
  for (const {name} of files) {
    const mate = /^(.*[._-])(?:[rf])?([12])(_\d{3})?(\.(?:fastq|fq)\.gz)$/i.exec(name);
    if (!mate) continue;
    const key = (mate[1] + (mate[3] || '') + mate[4]).toLowerCase();
    if (!groups.has(key)) groups.set(key, new Set());
    groups.get(key).add(mate[2]);
  }
  return (mode === 'PAIRED' && files.length < 2) || [...groups.values()].some(mates => mates.size !== 2);
}
module.exports = {missingMates};
