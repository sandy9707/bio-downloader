(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BioProjectView = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function columnFor(url) {
    try {
      const { hostname } = new URL(url);
      if (['download.cncb.ac.cn', 'download2.cncb.ac.cn', 'download.big.ac.cn'].includes(hostname)) return 'cncb';
      if (hostname === 'sra-pub-run-odp.s3.amazonaws.com') return 'aws';
      if (hostname === 'ftp.sra.ebi.ac.uk') return 'ena';
    } catch { /* An unresolved metadata slot has no URL yet. */ }
    return '';
  }

  function create(result, preferences, key) {
    const human = /^(HRA|HRR)/.test(result.accession) || result.files.some(file => /^HRR/.test(file.run));
    const files = new Map((result.matrixFiles || result.files).map((file, index) => {
      const preference = preferences.get(key(file));
      return [index, {
        file, sources: (file.candidateSources || []).map(source => ({ ...source, available: false, pending: true })), manual: preference?.manual || '',
        checked: preference?.checked ?? true, checkedColumns: new Set()
      }];
    }));
    const groups = new Map();
    if (!human) {
      for (const run of result.runs) groups.set(run, { key: run, indices: [], checked: true });
    }
    for (const [index, item] of files) {
      const id = human ? String(index) : item.file.run;
      const row = groups.get(id) || { key: id, indices: [], checked: true };
      row.indices.push(index);
      if (!item.checked) row.checked = false;
      groups.set(id, row);
    }
    return {
      result, files, rows: [...groups.values()], human,
      page: 0, pageSize: 8, loading: false, strategy: 'fastest',
      columns: human
        ? [{ id: 'https', label: 'HTTPS' }, { id: 'ftp', label: 'FTP' }]
        : [{ id: 'cncb', label: 'CNCB / GSA' }, { id: 'aws', label: 'AWS / SRA' }, { id: 'ena', label: 'EBI / ENA' }]
    };
  }

  const visible = view => view.rows.slice(view.page * view.pageSize, (view.page + 1) * view.pageSize);
  const selected = view => view.rows.filter(row => row.checked);

  function sync(view) {
    for (const row of view.rows) {
      for (const index of row.indices) view.files.get(index).checked = row.checked;
    }
  }

  function select(view, mode) {
    const page = new Set(visible(view));
    for (const row of view.rows) {
      if (mode === 'all') row.checked = true;
      else if (mode === 'none') row.checked = false;
      else if (mode === 'invert' && page.has(row)) row.checked = !row.checked;
      else if (mode === 'page' && page.has(row)) row.checked = true;
    }
    sync(view);
  }

  function inColumn(view, source, id) {
    return !id || (view.human ? String(source.url).startsWith(id + ':') : columnFor(source.url) === id);
  }

  function columnItems(view, row, column, choice) {
    const items = row.indices.map(index => view.files.get(index));
    if (view.human) return items.filter(item => choice(item, column).source);
    const formats = column === 'aws' ? ['sra'] : column === 'ena' ? ['fastq'] : ['fastq', 'sra'];
    for (const format of formats) {
      const group = items.filter(item => item.file.format === format);
      if (group.length && group.every(item => choice(item, column).source)) return group;
    }
    return [];
  }

  return { create, visible, select, selected, sync, columnFor, inColumn, columnItems };
});
