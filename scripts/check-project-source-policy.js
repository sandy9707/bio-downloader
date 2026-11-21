'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { gzipSync } = require('node:zlib');
const { chooseProjectSource, defaultStrategy, projectParentChoices } = require('../shared/project-source-policy');
const { createProjectService } = require('../packages/cli/project-sources');

const run = 'ERR123';
const name = `${run}_1.fastq.gz`;
const data = gzipSync('@read\nACGT\n+\nIIII\n');
const digest = bytes => createHash('md5').update(bytes).digest('hex');
const file = { run, name, format: 'fastq', size: data.length, md5: digest(data),
  url: `https://ftp.sra.ebi.ac.uk/vol1/fastq/${run}/${name}` };
const cn = `https://download2.cncb.ac.cn/INSDC1/FASTQ/${run}/${name}`;
const search = `https://ngdc.cncb.ac.cn/gsa/search?searchTerm=${run}`;
const detail = `https://ngdc.cncb.ac.cn/gsa/browse/insdc/ERA7/${run}`;
const choice = (url, latencyMs, changes) => ({ url, run, name, format: 'fastq', size: file.size, available: true, latencyMs, ...changes });

test('per-file strategy, Lite default, manual precedence and verified alternatives', () => {
  const remote = choice(file.url, 8), domestic = choice(cn, 26), faster = choice(file.url.replace('https:', 'ftp:'), 5);
  const sources = [remote, domestic, faster, choice(cn + 'x', 1, { size: 1 }), choice(cn, 2, { format: 'sra' }),
    choice(cn, 0, { run: 'ERR99' }), choice(cn, 0, { name: 'R2.fastq.gz' }), choice(cn, 0, { available: false })];
  assert.equal(defaultStrategy('pro'), 'fastest');
  assert.equal(defaultStrategy('lite'), 'domestic-first');
  assert.equal(chooseProjectSource(file, sources).source, faster);
  assert.equal(chooseProjectSource(file, sources, { edition: 'lite' }).source, domestic);
  assert.equal(chooseProjectSource(file, sources, { strategy: 'domestic-first', manual: remote.url }).source, remote);
  assert.equal(chooseProjectSource(file, [faster], { manual: cn }).source, null);
  assert.equal(chooseProjectSource(file, [remote, { ...domestic, available: false }], { strategy: 'domestic-first' }).source, remote);
  const spoof = choice('https://download.cncb.ac.cn.somewhere.example/test', 40);
  assert.equal(chooseProjectSource(file, [remote, spoof], { strategy: 'domestic-first' }).source, remote);
  assert.throws(() => chooseProjectSource(file, sources, { strategy: 'unknown' }), /策略/);
});

test('different levels of one lineage are not multiple parents', () => {
  assert.deepEqual(projectParentChoices({ accession: run, projects: ['PRJEB2', 'ERP1'] }), []);
  assert.deepEqual(projectParentChoices({ accession: 'SAMN1', projects: ['PRJNA8', 'PRJNA9'] }), ['PRJNA8', 'PRJNA9']);
  assert.deepEqual(projectParentChoices({ accession: 'CRR1', projects: ['CRA111', 'PRJCA222'] }), []);
});

const range = (bytes, type = 'application/octet-stream', size = bytes.length) => ({ status: 206, headers: {
  'content-range': `bytes 0-${bytes.length - 1}/${size}`, 'content-length': String(bytes.length), 'content-type': type }, data: bytes });
const html = links => ({ status: 200, data: `<html>${links.map(url => `<a href="${url}">官方记录</a>`).join('')}</html>` });
const lookup = async () => ({ accession: run, projects: ['PRJEB2'], access: 'public', runs: [run], files: [file] });

async function inspect({ attrs = {}, links = [cn], bytes = data, reply = range(data), listing, metaError } = {}) {
  const requests = [];
  const service = createProjectService(async () => ({ ...await lookup(), files: [{ ...file, ...attrs }] }), { get: async (url, options) => {
    assert.equal(options.proxy, false);
    assert.equal(options.maxRedirects, 0);
    requests.push(url);
    if (url === search) { if (metaError) throw metaError; return html(listing || [detail]); }
    if (url === detail) { assert.equal(options.headers.Referer, search); return html(links); }
    assert.match(options.headers.Range, /^bytes=0-\d+$/);
    if (url === file.url) return reply;
    assert.ok(links.includes(url), 'only published candidates may reach file probes');
    return range(bytes);
  } });
  const result = await service.query(run);
  const [row] = await service.probe({ queryId: result.queryId });
  return { row, requests };
}

test('only actual official links to the same Run, mate and format reach probes', async () => {
  const wrongType = cn.replace('/FASTQ/', '/SRA/').replace(name, `${run}.sra`);
  const wrongMate = cn.replace('_1.', '_2.');
  const { row, requests } = await inspect({ links: [wrongType, wrongMate, 'https://unofficial.example/' + name, cn] });
  assert.deepEqual(new Set(requests), new Set([search, detail, file.url, cn]));
  assert.deepEqual(new Set(row.sources.filter(s => s.available).map(s => s.url)), new Set([file.url, cn]));
  assert.equal(chooseProjectSource(file, row.sources, { strategy: 'domestic-first' }).source.url, cn);
  const unsupported = await inspect({ links: [wrongType] });
  assert.equal(unsupported.row.sources.length, 1);
  assert.match(unsupported.row.note, /同文件|FASTQ|同格式/);
});

test('reject HTML, wrong magic, wrong length, shifted ranges and different bytes before selection', async () => {
  for (const reply of [range(data, 'text/html'), range(gzipSync('>record\nACG\n')), range(data, 'application/gzip', file.size + 1),
    { ...range(data), headers: { ...range(data).headers, 'content-range': `bytes 1-${data.length}/${data.length + 1}` } },
    range(Buffer.alloc(data.length, 65))]) {
    const { row } = await inspect({ reply, links: [] });
    assert.equal(row.sources.some(s => s.available), false);
  }
  const bad = Buffer.from(data); bad[4] ^= 1; // valid gzip of identical records with a different header, same length
  const { row } = await inspect({ bytes: bad });
  assert.equal(row.sources.find(s => s.url === cn).available, false);
  assert.equal(chooseProjectSource(file, row.sources, { strategy: 'domestic-first' }).source.url, file.url);
});

test('large published SRA mirror needs the same prefix and an authoritative size, conflicting official protocols stop selection', async () => {
  const original = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${run}/${run}`;
  const alternate = `https://ftp.ncbi.nlm.nih.gov/sra/vol1/${run}/${run}.sra`;
  const mirror = `https://download2.cncb.ac.cn/INSDC1/SRA/vol1/raw/${run}//${run}.sra`;
  const size = 230000, bytes = Buffer.alloc(65536, 7), different = Buffer.alloc(65536, 9);
  for (const sample of [bytes, different]) sample.write('NCBI.sra');
  async function measured(manifestSize, alternateBytes, mirrorBytes) {
    const file = { run, name: `${run}.sra`, format: 'sra', size: manifestSize, url: original, alternatives: [alternate] };
    const service = createProjectService(async () => ({ ...await lookup(), files: [file] }), { get: async url => {
      if (url === search) return html([detail]);
      if (url === detail) return html([mirror]);
      assert.ok([original, alternate, mirror].includes(url));
      return range(url === mirror ? mirrorBytes : url === alternate ? alternateBytes : bytes, 'application/octet-stream', size);
    } });
    const result = await service.query(run);
    const [row] = await service.probe({ queryId: result.queryId });
    return chooseProjectSource(file, row.sources, { strategy: 'domestic-first' }).source;
  }
  assert.equal((await measured(size, bytes, bytes)).url, mirror);
  assert.notEqual((await measured(size, bytes, different)).url, mirror);
  assert.notEqual((await measured(0, bytes, bytes)).url, mirror);
  assert.equal(await measured(size, different, bytes), null);
});

test('ambiguous discovery, protection pages and rate limits leave the original available', async () => {
  for (const options of [{ listing: [detail, detail.replace('ERA7', 'ERA8')] }, { listing: ['https://example.test/fake'] },
    { metaError: Object.assign(new Error('429'), { response: { status: 429 } }) }]) {
    const { row, requests } = await inspect(options);
    assert.equal(row.sources.filter(s => s.available).length, 1);
    assert.ok(row.note);
    assert.ok(!requests.includes(cn));
  }
});
