'use strict';

const axios = require('axios');
const { lookupHuman } = require('./project-lookup-human');

const { sraContainers } = require('./project-lookup-sra');
const { missingMates } = require('./project-lookup-pairs');
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
    if (object.split('/').at(-2) !== row.run_accession) throw new Error('ENA FASTQ 地址与 Run 归属不符');
    const size = sizes.length === paths.length && /^\d+$/.test(sizes[index]) ? Number(sizes[index]) : 0;
    const md5 = hashes.length === paths.length && /^[\da-f]{32}$/i.test(hashes[index]) ? hashes[index].toLowerCase() : '';
    return {run:row.run_accession, format:'fastq', name:object.split('/').pop(), url:`https://${object}`, alternatives:[`ftp://${object}`], size:Number.isSafeInteger(size) ? size : 0, md5};
  });
}

async function lookupProject(input, {get = (url, options) => axios.request({url, ...options}), signal, workbook} = {}) {
  const accession = String(input || '').trim().toUpperCase();
  const base = {accession, projects:[], runs:[], files:[], access:'unknown', partial:false, officialUrl:'', applicationUrl:'', message:''};
  const request = async (url, config = {}) => {
    const response = await get(url, {timeout:30000, maxContentLength:32*1024*1024, signal, ...config});
    if (response.status != null && response.status !== 200) throw Object.assign(new Error(`查询返回 HTTP ${response.status}`), {response});
    if (response.headers?.['cf-mitigated'] === 'challenge' || response.headers?.['www-authenticate']) throw Object.assign(new Error('官网要求验证访问'), {code:'HRA_STOP',response});
    return config.method === 'HEAD' ? response.headers : response.data;
  };
  if (/^(?:HRA|HRR|HIR)\d+$/.test(accession)) {
    return lookupHuman(base, request, signal, workbook);
  }
  if (/^(?:PRJCA|CRA|CRR)\d+$/.test(accession)) {
    return require('./project-lookup-gsa').lookupGsa(base, request, signal);
  }
  const field = fields.find(([pattern]) => pattern.test(accession))?.[1];
  if (!field) throw new Error('请输入支持的 BioProject、BioSample、Study、Experiment、Run 或 GSA-Human 编号');
  const params = {result:'read_run', query:`${field}="${accession}"`, format:'json'};
  const url = (endpoint, extra) => `https://www.ebi.ac.uk/ena/portal/api/${endpoint}?${new URLSearchParams({...params, ...extra})}`;
  const columns = [...new Set([field,'study_accession','run_accession','library_layout','fastq_ftp','fastq_md5','fastq_bytes'])];
  const [rows, count] = await Promise.all([request(url('search', {fields:columns.join(','),limit:'0'})), request(url('count'), {maxContentLength:4096})]);
  if (!Array.isArray(rows) || !/^\d+$/.test(String(count?.count)) || Number(count.count) !== rows.length) throw new Error(`ENA 清单与独立计数不符（${Array.isArray(rows) ? rows.length : '未知'}/${count?.count ?? '未知'}），请重新查询`);
  const projects = new Set(), runs = new Set(), files = [];
  let missingEnds = 0;
  for (const row of rows) {
    const parents = String(row?.study_accession || '').split(';').map(id=>id.trim());
    if (!String(row?.[field] || '').split(';').map(id=>id.trim()).includes(accession) || parents.some(id=>!/^PRJ(?:NA|EA|EB|DA|DB|CA)\d+$/.test(id)) || !/^[SED]RR\d+$/.test(row.run_accession) || runs.has(row.run_accession)) throw new Error('ENA 返回了归属不符或重复的 Run');
    parents.forEach(id => projects.add(id));
    runs.add(row.run_accession);
    const group = fastqFiles(row);
    if (new Set(group.map(f=>f.name)).size !== group.length) throw new Error('ENA 文件清单含重复文件');
    if (group.length && missingMates(group,row.library_layout)) missingEnds++;
    files.push(...group);
  }
  const withFastq = new Set(files.map(file => file.run));
  const containers = await sraContainers([...runs].filter(run => !withFastq.has(run)), request, signal);
  files.push(...containers.files);
  const matched = new Set(files.map(file => file.run)).size;
  const message = runs.size ? `已找到 ${runs.size} 个 Run，其中 ${matched} 个有官方公开文件。` : 'ENA 未查询到该编号对应的公开 Run。';
  return {...base, projects:[...projects].sort(), runs:[...runs], files, access:files.length ? 'public' : 'unknown', officialUrl:`https://www.ebi.ac.uk/ena/browser/view/${accession}`, partial:matched < runs.size || missingEnds > 0 || containers.unavailable, message:message + (missingEnds ? `${missingEnds} 个 Run 仅凭现有 FASTQ 无法确认双端完整，可能缺端或合并存放。` : '') + (containers.unavailable ? '部分 NCBI SRA 元数据暂不可用。' : '')};
}
module.exports = { lookupProject };
