'use strict';

// NCBI SDL lists distinct object types and their exact locations. Only an
// anonymous public SRA container belongs to the fallback for a missing FASTQ.
function publicLocations(file, run) {
  if (file.type !== 'sra' || file.accession !== run || file.encryptedForProjectId || !Array.isArray(file.locations)) return [];
  return file.locations.flatMap(loc => {
    if (loc.payRequired || loc.ceRequired || loc.encryptedForProjectId || typeof loc.link !== 'string') return [];
    let url;
    try { url = new URL(loc.link); } catch { return []; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash || url.search) return [];
    if (url.hostname === 'sra-pub-run-odp.s3.amazonaws.com' && url.pathname === `/sra/${run}/${run}`) return [url.href];
    if (url.hostname === 'ftp.ncbi.nlm.nih.gov' && url.pathname.startsWith('/sra/') && url.pathname.endsWith(`/${run}.sra`)) return [url.href];
    return [];
  });
}

async function sraContainers(runs, request, signal) {
  const files = [];
  let unavailable = false;
  for (let i = 0; i < runs.length; i += 100) {
    const batch = runs.slice(i, i + 100);
    let reply;
    try { reply = await request(`https://locate.ncbi.nlm.nih.gov/sdl/2/retrieve?acc=${batch.join(',')}`); }
    catch (error) { if (signal?.aborted) throw error; unavailable = true; continue; }
    if (!Array.isArray(reply?.result)) { unavailable = true; continue; }
    for (const record of reply.result) {
      const run = record.bundle;
      if (!batch.includes(run) || Number(record.status) !== 200) continue;
      for (const f of record.files || []) {
        const [url, ...alternatives] = [...new Set(publicLocations(f, run))];
        if (!url) continue;
        const size = Number(f.size);
        files.push({run, name:`${run}.sra`, url, alternatives, format:'sra', size:Number.isSafeInteger(size) && size > 0 ? size : 0, md5:/^[0-9a-f]{32}$/i.test(f.md5) ? f.md5.toLowerCase() : ''});
      }
    }
  }
  return {files, unavailable};
}
module.exports = { sraContainers };
