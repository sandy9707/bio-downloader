'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {lookupBioSample} = require('../src/main/biosample-runs');

// Named reproducible control; these 201 UIDs/Runs are synthetic, not a claim
// about the current contents of the public BioSample used by the live smoke test.
const sample = 'SAMN90000201';
const ids = Array.from({length:201}, (_, i) => String(10001 + i));
const run = uid => `SRR${uid}`;
function fixture(change = () => {}) {
  const calls = [];
  const get = async raw => {
    const url = new URL(raw), q = url.searchParams;
    const endpoint = url.pathname.split('/').pop();
    calls.push({endpoint, offset:q.get('retstart')});
    let data;
    if (endpoint === 'count') {
      assert.equal(q.get('query'), `sample_accession="${sample}"`);
      assert.equal(q.get('result'), 'read_run');
      data = {count:String(ids.length)};
    } else if (endpoint === 'esearch.fcgi') {
      assert.equal(q.get('term'), `${sample}[BioSample]`);
      const offset = Number(q.get('retstart'));
      data = {esearchresult:{count:String(ids.length), retstart:String(offset), idlist:ids.slice(offset, offset + Number(q.get('retmax')))}};
    } else {
      assert.equal(endpoint, 'esummary.fcgi');
      const uids = q.get('id').split(',');
      assert(uids.length <= 50);
      data = {result:{uids}};
      for (const uid of uids) data.result[uid] = {uid, expxml:`<Summary/><Biosample>${sample}</Biosample>`, runs:`<Run acc="${run(uid)}" is_public="true"/>`};
    }
    change(endpoint, data, q);
    return {status:200, data};
  };
  return {get, calls};
}
const query = f => lookupBioSample(sample.toLowerCase(), {get:f.get, pace:false});
test('SAMN90000201 fixture: exact 201 distinct Runs, not the first 200 search records', async () => {
  const f = fixture();
  const r = await query(f);
  assert.equal(r.biosample, sample); assert.deepEqual(r.runs, ids.map(run));
  assert.equal(r.count,201); assert.equal(r.expectedCount,201); assert.equal(r.complete,true);
  assert.deepEqual(f.calls.filter(c=>c.endpoint==='esearch.fcgi').map(c=>c.offset),['0','200']);
});
test('missing page, repeated UID, missing summary, wrong sample and independent count fail closed', async () => {
  for (const [change, message] of [
    [(e,d,q)=>{ if(e==='esearch.fcgi' && q.get('retstart')==='200') d.esearchresult.idlist=[]; }, /200.*201/],
    [(e,d,q)=>{ if(e==='esearch.fcgi' && q.get('retstart')==='200') d.esearchresult.idlist=[ids[0]]; }, /重复|分页/],
    [(e,d)=>{ if(e==='esummary.fcgi') d.result.uids.pop(); }, /摘要|缺/],
    [(e,d)=>{ if(e==='esummary.fcgi') d.result[d.result.uids[0]].expxml=`<Title>${sample}</Title><Biosample>SAMN1</Biosample>`; }, /归属|BioSample/],
    [(e,d)=>{ if(e==='esummary.fcgi') d.result[d.result.uids[0]].runs += '<Run acc="'; }, /截断|完整|格式/],
    [(e,d)=>{ if(e==='count') d.count='203'; }, /201.*203/]
  ]) await assert.rejects(query(fixture(change)),message);
});
test('invalid sample cannot initiate a query', async () => {
  await assert.rejects(lookupBioSample('SAMN1 OR all', {get:()=>assert.fail('network')}), /BioSample/);
});
