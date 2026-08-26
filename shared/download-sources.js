(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.BioDownloadSources = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const sources = [
    { id:'bioproject', label:'BioProject', project:true, example:'PRJNA727404', exampleText:'PRJNA727404（8 个 Run）', placeholder:'例如 PRJNA727404 / PRJEB12345 / PRJDB12345' },
    { id:'sra_raw', label:'SRA', example:'SRR390728', exampleText:'SRR390728', placeholder:'每行一个，例如 SRR390728' },
    { id:'ebi_raw', label:'EBI', example:'ERR164407', exampleText:'ERR164407', placeholder:'每行一个，例如 ERR164407' },
    { id:'geo_suppl', label:'GEO', example:'GSE13575', exampleText:'GSE13575', placeholder:'每行一个，例如 GSE13575' },
    { id:'links', label:'直链下载', example:'https://raw.githubusercontent.com/sandy9707/bio-downloader/main/README.md', exampleText:'项目 README.md', placeholder:'每行一个完整 HTTP(S) 下载链接' },
    { id:'other', label:'其他数据源', children:['zenodo','huggingface'] }
  ];
  const extras = [
    { id:'zenodo', label:'Zenodo', example:'10.5281/zenodo.22080384', exampleText:'10.5281/zenodo.22080384（约 12 KB）', placeholder:'每行一个 Record ID、DOI 或链接' },
    { id:'huggingface', label:'Hugging Face', example:'lhoestq/demo1', exampleText:'lhoestq/demo1（小型示例）', placeholder:'每行一个，例如 lhoestq/demo1' }
  ];
  const all = [...sources.filter(s => s.id !== 'other'), ...extras];
  const byId = Object.fromEntries(all.map(s => [s.id, s]));
  const accessionTypes = new Set(['bioproject','sra_raw','ena_raw','ebi_raw','geo_suppl']);
  const aliases = { ena_raw:'ebi_raw' };

  function canonicalType(type) {
    return aliases[type] || type;
  }

  function normalizeValue(type, raw) {
    let value = String(raw || '').trim();
    if (accessionTypes.has(type)) return value.toUpperCase().replace(/\s+/g, '');
    if (type === 'zenodo') {
      const match = value.match(/(?:zenodo\.|records\/)(\d{4,})/i);
      return match ? match[1] : value;
    }
    if (type === 'huggingface') {
      const match = value.match(/(?:huggingface\.co\/datasets\/)?([\w.-]+\/[\w.-]+)/i);
      return match ? match[1].replace(/\/$/, '') : value;
    }
    return value;
  }
  function normalizeList(type, raw) {
    const separator = accessionTypes.has(type) ? /[\s,，;；]+/ : /[\r\n]+/;
    return [...new Set(String(raw || '').split(separator).map(v => normalizeValue(type, v)).filter(Boolean))];
  }
  function applyRuns(textarea, runs) {
    const normalized = normalizeList('sra_raw', Array.isArray(runs) ? runs.join('\n') : runs);
    if (textarea) textarea.value = normalized.join('\n');
    return normalized;
  }
  function renderPrimaryButtons(onclickName, className) {
    return sources.map((s, i) => `<button class="${className}${i === 0 ? ' active' : ''}" data-type="${s.id}" data-download-type="${s.id}" onclick="${onclickName}('${s.id}',this)">${s.label}</button>`).join('');
  }
  return { sources, extras, all, byId, accessionTypes, aliases, canonicalType, normalizeValue, normalizeList, applyRuns, renderPrimaryButtons };
});
