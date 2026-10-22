const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const cli = fs.readFileSync(path.join(root, 'packages/cli/bin.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');

const requiredCliPatterns = [
  /callIpcHandler\('api-get-user-info'/,
  /command\('login'\)/,
  /url\.searchParams\.get\('token'\)/,
  /if \(!info\.isActive\)/
];

for (const pattern of requiredCliPatterns) {
  if (!pattern.test(cli)) throw new Error(`Linux CLI 鉴权契约缺失: ${pattern}`);
}

if (/return fs\.existsSync\(aria2\) \? aria2 : 'aria2c'/.test(main)) {
  throw new Error('HTTP 下载不得在 Axel 缺失时静默回退 aria2c');
}
const { defaults, selectEngine } = require('../src/main/download-engines');
if (defaults.http !== 'native' || selectEngine({url:'https://example.org/a'}) !== 'native') throw new Error('普通下载默认引擎必须为专属内核');
if (selectEngine({url:'https://example.org/a'}, {downloadEngines:{http:'axel'}}) !== 'axel') throw new Error('必须保留 Axel 切换');
for (const pattern of [/systemBinaryPath/, /toolId \+ 'Path'/, /plugin-set-path/]) {
  if (!pattern.test(main)) throw new Error(`插件路径选择契约缺失: ${pattern}`);
}
console.log('Linux CLI 契约检查通过: 在线鉴权、默认专属内核、可切换 aria2/Axel、自定义/内置/PATH 路径选择');
