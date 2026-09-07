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
if (/useAria2ForHttp/.test(main)) {
  throw new Error('HTTP/SRA 下载路径不得使用 aria2c');
}
if (!/未找到 Axel/.test(main)) {
  throw new Error('Axel 缺失时必须显式停止下载并提示配置路径');
}

for (const pattern of [/systemBinaryPath/, /axelPath/, /aria2Path/, /plugin-set-path/]) {
  if (!pattern.test(main)) throw new Error(`插件三级选择契约缺失: ${pattern}`);
}

console.log('Linux CLI 契约检查通过: 在线鉴权、HTTP 固定 Axel、内置/PATH/绝对路径三级选择');
