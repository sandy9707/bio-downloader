'use strict';
const {load} = require('cheerio');
const {workbookRows} = require('./project-lookup-workbook');
const SITE = 'https://ngdc.cncb.ac.cn/gsa-human/';
const ARCHIVE = 'https://download.cncb.ac.cn/gsa-human/';
const clean = text => String(text ?? '').trim().replace(/\s+/g, ' ');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
function document(html) {
  if (typeof html !== 'string' || !/<\/html>/i.test(html)) throw failure('HRA_INCOMPLETE', 'GSA-Human 页面不完整');
  return load(html);
}

// Exact project access takes precedence over links elsewhere on a page (navigation,
// examples, abstracts and linked projects may mention other access policies).
function projectRecord(html, accession, projectUrl) {
  const $ = document(html);
  if ($('input#idacc').length !== 1 || $('input#idacc').val() !== accession) throw failure('HRA_ACCESS_UNKNOWN', '官网未确认该项目编号或访问状态');
  const label = $('b').filter((_, el) => /^(?:访问方式|Data Accessibility|Access(?: mode| type)?)[:：]?$/i.test(clean($(el).text())));
  const value = label.closest('.col-md-2').next();
  if (label.length !== 1 || value.length !== 1) throw failure('HRA_ACCESS_UNKNOWN', '官网未明确标记访问方式');
  const text = clean(value.clone().find('a').remove().end().text());
  if (/^(?:controlled access|controlled|受控访问)$/i.test(text)) {
    const applicationUrl = value.find('a[href]').toArray().map(a => {
      try { return new URL($(a).attr('href'), SITE).href; } catch { return null; }
    }).find(url => url === SITE + 'request/' + accession);
    return {access:'controlled', status:clean(value.text()), applicationUrl:applicationUrl || projectUrl};
  }
  if (!/^(?:open access|open|开放访问|公开访问)$/i.test(text)) throw failure('HRA_ACCESS_UNKNOWN', '项目访问方式未确认');
  const download = $('.panel,.panel-info').filter((_, el) => /^(?:数据下载|Data(?:set)? Download|Download Data)$/i.test(clean($(el).children('.panel-heading').text())));
  const published = download.find('a[href]').toArray().some(a => [ARCHIVE + accession, `ftp://download.big.ac.cn/gsa-human/${accession}`].includes(($(a).attr('href') || '').replace(/\/$/, '')));
  if (!published) throw failure('HRA_UNAVAILABLE', '项目标记为开放，但官网未开放数据下载入口');
  return {access:'open', status:'Open access', workbookUrl:publishedWorkbook($, accession)};
}

// The site's export action carries a server-issued path and access parameters. Read
// the actual control; never manufacture these inputs from an accession or Run ID.
function publishedWorkbook($, accession) {
  const anchor = $('#csvHumanFile_open');
  const path = /^downHumanExcel\('([^']+)'\);?$/.exec((anchor.attr('onclick') || '').trim())?.[1];
  if (!path || !path.endsWith(`/human/${accession}/${accession}.xlsx`) || /\.\.|[\\\x00-\x1f]/.test(path) || clean(anchor.text()) !== `${accession}.xlsx`) return null;
  const script = $('script').toArray().map(s => $(s).text()).find(s => s.includes('/gsa-human/file/exportExcelFile?fileName='));
  const study = /\bvar\s+study_id\s*=\s*'(\d+)'/.exec(script || '')?.[1];
  const flag = /\bvar\s+requestFlag\s*=\s*'(\d+)'/.exec(script || '')?.[1];
  if (!study || flag !== '0') return null;
  return `${SITE}file/exportExcelFile?` + new URLSearchParams({fileName:path, study_id:study, requestFlag:flag});
}

// This is the Browse page's filtered workbook for its “Available” tab, not a
// directory probe. An empty result (e.g. registration pending) cannot grant access.
function catalogueRecord(bytes, accession, projectUrl) {
  const sheets = workbookRows(bytes, load).filter(sheet => sheet[0]?.includes('Study') && sheet[0].includes('Access'));
  const [rows] = sheets;
  const column = name => rows?.[0]?.indexOf(name);
  if (sheets.length !== 1 || rows.length !== 2 || ['Study','Access'].some(key=>rows[0].filter(h=>h===key).length !== 1) || rows[1][column('Study')] !== accession) throw failure('HRA_ACCESS_UNKNOWN', '官方可获取项目表未返回唯一匹配编号，访问状态未知');
  const access = clean(rows[1][column('Access')]);
  if (/^Control(?:led)?$/i.test(access)) return {access:'controlled', status:'受控访问，请在官方项目页查看申请状态', applicationUrl:projectUrl};
  if (access !== 'Open') throw failure('HRA_ACCESS_UNKNOWN', '官方可获取项目表未确认访问方式');
  return {access:'open', status:'Open access'};
}

// Older public record pages expose the same two fields in a labelled table.
// Page titles and abstract text alone cannot supply an access declaration.
function tableRecord($, accession, projectUrl) {
  const values = [];
  for (const section of $('table,dl').toArray()) {
    const fields = $(section).find('th,dt').toArray().filter(el => $(el).closest('table,dl')[0] === section)
      .map(el => [clean($(el).text()).replace(/[:：]$/, ''), clean($(el).next().text())]);
    const ids = fields.filter(([key]) => /^(?:Accession(?: number| ID)?|GSA(?:-Human)? accession|项目编号|数据集编号)$/i.test(key));
    if (ids.length !== 1 || ids[0][1] !== accession) continue;
    for (const [key,value] of fields) if (/^(?:(?:Data )?Access(?: type| mode| status)?|数据访问类型|访问类型|访问权限)$/i.test(key)) values.push(value);
  }
  if (!values.length) throw failure('HRA_ACCESS_UNKNOWN', '官方表格未明确确认该项目的访问方式');
  if (values.some(v=>/^(?:controlled(?: access)?|restricted(?: access)?|受控(?:访问)?)$/i.test(v))) {
    const applicationUrl = $('a[href]').toArray().map(a=>{ try { return new URL($(a).attr('href'), projectUrl).href; } catch { return ''; } }).find(u => [SITE+'request/'+accession, SITE+'apply/'+accession].includes(u));
    return {access:'controlled', status:'官方记录为受控访问，请从项目页申请数据访问。', applicationUrl:applicationUrl || projectUrl};
  }
  if (!values.every(v=>/^(?:open(?: access)?|public(?: access)?|开放(?:访问)?|公开(?:访问)?)$/i.test(v))) throw failure('HRA_ACCESS_UNKNOWN', '项目访问方式未确认');
  return {access:'open', status:'Open access'};
}
module.exports = {projectRecord, catalogueRecord, tableRecord};
