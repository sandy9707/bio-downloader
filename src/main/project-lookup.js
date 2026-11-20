'use strict';

const axios = require('axios');
const { lookupHuman } = require('./project-lookup-human');

const { sraContainers } = require('./project-lookup-sra');
const fields = [
  [/^[SED]RA\d+$/, 'submission_accession'],
  [/^PRJ(?:NA|EA|EB|DA|DB)\d+$/, 'study_accession'],
  [/^[SED]RP\d+$/, 'secondary_study_accession'],
  [/^[SED]RX\d+$/, 'experiment_accession'],
  [/^[SED]RR\d+$/, 'run_accession'],
  [/^[SED]RS\d+$/, 'secondary_sample_accession'],
  [/^(?:SAMN|SAMEA|SAMD)\d+$/, 'sample_accession']
];

function fastqFiles(row) {
  if (!row.fastq_ftp) return [];
  const paths = row.fastq_ftp.split(';');
  const sizes = (row.fastq_bytes || '').split(';');
  const hashes = (row.fastq_md5 || '').split(';');
  return paths.map((path, index) => {
    // ENA returns host/path without a protocol. Only adopt an official FASTQ object.
    const object = path.replace(/^(?:ftp|https):\/\//i, '');
    if (!/^ftp\.sra\.ebi\.ac\.uk\/vol1\/(?:fastq|run)\/(?:[\w.-]+\/)*[\w.-]+\.(?:fastq|fq)\.gz$/i.test(object) || object.split('/').some(part => part === '..' || part === '.')) {
      throw new Error('ENA 返回的 FASTQ 文件地址无效');
    }
    const size = sizes.length === paths.length && /^\d+$/.test(sizes[index]) ? Number(sizes[index]) : 0;
    const md5 = hashes.length === paths.length && /^[\da-f]{32}$/i.test(hashes[index]) ? hashes[index].toLowerCase() : '';
    return {run:row.run_accession, format:'fastq', name:object.split('/').pop(), url:`https://${object}`, alternatives:[`ftp://${object}`], size:Number.isSafeInteger(size) ? size : 0, md5};
  });
}

async function lookupProject(input, {get = (url, options) => axios.request({url, ...options}), signal, workbook} = {}) {
  const accession = String(input || '').trim().toUpperCase();
  const base = {accession, projects:[], runs:[], files:[], access:'unknown', officialUrl:'', applicationUrl:'', message:''};
  const request = async (url, config = {}) => {
    const response = await get(url, {timeout:30000, maxContentLength:32*1024*1024, signal, ...config});
    if (response.status != null && response.status !== 200) throw Object.assign(new Error(`查询返回 HTTP ${response.status}`), {response});
    return response.data;
  };
  if (/^(?:HRA|HRR|HIR)\d+$/.test(accession)) {
    const result = await lookupHuman(base, request, signal);
    if (workbook && result.access === 'public' && result.files.length) require('./project-lookup-workbook').enrichFiles(workbook, result.files);
    return result;
  }
  if (/^(?:PRJCA|CRA|CRR)\d+$/.test(accession)) {
    return require('./project-lookup-gsa').lookupGsa(base, request, signal);
  }
  const field = fields.find(([pattern]) => pattern.test(accession))?.[1];
  if (!field) throw new Error('请输入支持的 BioProject、BioSample、Study、Experiment、Run 或 GSA-Human 编号');
  const params = {result:'read_run', query:`${field}="${accession}"`, format:'json'};
  const url = (endpoint, extra) => `https://www.ebi.ac.uk/ena/portal/api/${endpoint}?${new URLSearchParams({...params, ...extra})}`;
  const columns = [...new Set([field,'study_accession','run_accession','fastq_ftp','fastq_md5','fastq_bytes'])];
  const [rows, count] = await Promise.all([request(url('search', {fields:columns.join(','),limit:'0'})), request(url('count'), {maxContentLength:4096})]);
  if (!Array.isArray(rows) || !/^\d+$/.test(String(count?.count)) || Number(count.count) !== rows.length) throw new Error('ENA 查询结果与独立计数不符，请重新查询');
  const projects = new Set(), runs = new Set(), files = [];
  for (const row of rows) {
    if (!String(row?.[field] || '').split(';').includes(accession) || !/^PRJ(?:NA|EA|EB|DA|DB|CA)\d+$/.test(row.study_accession) || !/^[SED]RR\d+$/.test(row.run_accession) || runs.has(row.run_accession)) throw new Error('ENA 返回了归属不符或重复的 Run');
    projects.add(row.study_accession);
    runs.add(row.run_accession);
    files.push(...fastqFiles(row));
  }
  const withFastq = new Set(files.map(file => file.run));
  const containers = await sraContainers([...runs].filter(run => !withFastq.has(run)), request, signal);
  files.push(...containers.files);
  const matched = new Set(files.map(file => file.run)).size;
  const message = runs.size ? `已找到 ${runs.size} 个 Run，其中 ${matched} 个有官方公开文件。` : 'ENA 未查询到该编号对应的公开 Run。';
  return {...base, projects:[...projects], runs:[...runs], files, access:files.length ? 'public' : 'unknown', officialUrl:`https://www.ebi.ac.uk/ena/browser/view/${accession}`, message:message + (containers.unavailable ? '部分 NCBI SRA 元数据暂不可用。' : '')};
}
module.exports = { lookupProject };
