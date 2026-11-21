(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BioProjectSources = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const domesticHosts = new Set(['download.cncb.ac.cn', 'download2.cncb.ac.cn', 'download.big.ac.cn']);
  const defaultStrategy = edition => edition === 'lite' ? 'domestic-first' : 'fastest';
  function checkStrategy(value) {
    if (!['fastest', 'domestic-first'].includes(value)) throw new Error('选源策略须为 fastest 或 domestic-first');
    return value;
  }
  function isDomestic(url) {
    try { return domesticHosts.has(new URL(url).hostname); } catch { return false; }
  }
  // The adapter must supply a successfully measured candidate for this exact
  // official file. Discovery/availability for a Run as a whole is insufficient.
  function eligible(file, source) {
    return source.available === true && source.run === file.run && source.name === file.name && source.format === file.format &&
      Number.isFinite(source.latencyMs) && source.latencyMs >= 0 && Number.isSafeInteger(source.size) && source.size > 0 &&
      (!file.size || Number(file.size) === source.size);
  }
  function matches(source, manual) {
    if (source.url === manual) return true;
    const address = new URL(source.url);
    return [address.protocol.slice(0, -1), address.host].includes(manual.toLowerCase());
  }
  function chooseProjectSource(file, sources, { strategy, edition = 'pro', manual = '' } = {}) {
    strategy = checkStrategy(strategy ?? defaultStrategy(edition));
    const available = sources.filter(s => eligible(file, s)).sort((a, b) => a.latencyMs - b.latencyMs);
    const single = available.length !== 1 ? '' : sources.length === 1 ? '（仅列出此同文件地址）' : '（仅此来源通过核验）';
    if (manual) {
      const source = available.find(s => matches(s, manual)) || null;
      return { source, reason: source ? '手动指定' + single : '手选来源本次未核实，请更换来源或重测' };
    }
    const domestic = available.find(s => isDomestic(s.url));
    const source = (strategy === 'domestic-first' && domestic) || available[0] || null;
    let reason;
    if (!source) reason = '本次没有通过文件核验的来源';
    else if (strategy === 'domestic-first') reason = domestic ? '已核实的国内同文件来源' : '本次无已核实国内同文件来源，采用已核实的其他来源';
    else reason = '同文件中实测响应最快';
    return { source, reason: reason + single };
  }
  function projectParentChoices(result) {
    const ids = [...new Set(result.projects || [])];
    // A Project, Study and archive can describe one lineage. Only multiple
    // parents at the same level require a choice. Querying a Project itself
    // explicitly includes the studies/archives under that Project.
    const projects = ids.filter(id => /^PRJ/.test(id));
    if (projects.length > 1) return projects;
    if (projects.includes(result.accession)) return [];
    const studies = ids.filter(id => /^(?:[SED]RP|CRA|HRA)\d+$/.test(id));
    return studies.length > 1 ? studies : [];
  }
  function queueFile(file, source, result, { manual, strategy } = {}) {
    return { name: file.name, sourceName: file.name, run: file.run, folder: file.run,
      project: file.project || (result.projects || []).find(id => /^PRJ/.test(id)) || (result.projects || [])[0] || result.accession,
      format: file.format, url: source.url, transport: new URL(source.url).protocol.slice(0, -1),
      size: source.size, md5: file.md5 || '', sourceSelection: manual ? 'manual' : strategy || defaultStrategy('pro') };
  }
  return { defaultStrategy, checkStrategy, isDomestic, chooseProjectSource, projectParentChoices, queueFile };
});
