const fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..');
function webIndex() {
  return fs.readFileSync(path.join(root, 'index.html'), 'utf8')
    .replace(/<webview id="cloudWorkspaceWebview"[^>]*><\/webview>/, '<iframe id="cloudWorkspaceFrame" data-src="https://biodown.ye.aimeals.cn/user/cloud?embed=cloud" allow="clipboard-write" style="width:100%;height:calc(100vh - 160px);border:0;border-radius:12px;background:#f7f8fc;"></iframe>')
    .replace('<script src="shared/download-sources.js">', '<script src="web-bridge.js"></script>\n  <script src="shared/download-sources.js">');
}
function speedtest() {
  return fs.readFileSync(path.join(root, 'speedtest.html'), 'utf8')
    .replace('<script>', '<script src="web-bridge.js"></script>\n  <script>')
    .replace('onclick="window.history.back()"', 'href="/"')
    .replace('测试您的宽带真实下载速度。', '测试 Linux 服务器的下载速度（不是当前浏览器所在电脑）。');
}
for (const [file, content] of [['index.html', webIndex()], ['speedtest.html', speedtest()]]) {
  const target = path.join(root, 'packages/web', file);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) throw new Error('Linux 页面未同步: ' + file);
  } else fs.writeFileSync(target, content);
}
