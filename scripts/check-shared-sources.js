const fs = require('fs');
const path = require('path');
const contract = require('../shared/download-sources');

const root = path.resolve(__dirname, '..');
const desktop = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const web = fs.readFileSync(path.join(root, '01_backend_server/views/user.html'), 'utf8');
const expected = ['bioproject','sra_raw','ena_raw','ebi_raw','geo_suppl','links','other'];
if (contract.sources.map(s => s.id).join(',') !== expected.join(',')) throw new Error('数据源顺序不符合产品契约');
if (contract.byId.bioproject.example !== 'PRJNA727404') throw new Error('BioProject 示例回归');
if (!desktop.includes('shared/download-sources.js') || !web.includes('/shared/download-sources.js')) throw new Error('网页或桌面未加载共享契约');
if (!desktop.includes('id="localSourceGrid"') || !web.includes('id="cdSourceGrid"')) throw new Error('网页或桌面未使用动态数据源容器');
if (contract.normalizeValue('geo_suppl', 'gse13575') !== 'GSE13575') throw new Error('编号大写转换失败');
console.log('共享下载中心契约检查通过：' + expected.join(' → '));
