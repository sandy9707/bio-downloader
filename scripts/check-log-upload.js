const assert = require('assert/strict'), fs = require('fs'), vm = require('vm');
const source = fs.readFileSync(require('path').join(__dirname, '../renderer.js'), 'utf8');
const nodes = new Map();
const element = id => {
  if (!nodes.has(id)) nodes.set(id, { innerText: id === 'logPreviewContent' ? 'preview unchanged' : '', style: { display: 'flex' }, disabled: false });
  return nodes.get(id);
};
const uploads = [];
const now = Date.now();
const ctx = vm.createContext({ Date, Set, console, currentUser: { token: 'fixture' }, showToast: () => {},
  document: { getElementById: element }, window: { api: {
    readLogContent: async name => name.startsWith('good') ? 'completed' : '{"status":"failed"}',
    uploadLogContent: async (token, name, content) => { uploads.push({ name, content }); return { success: true }; }
  } } });
vm.runInContext(source.slice(source.indexOf('let localLogsList ='), source.indexOf('// 绑定到 window 暴露给 HTML 属性', source.indexOf('let localLogsList ='))), ctx);
(async () => {
  vm.runInContext(`localLogsList=[{name:'error-new.log',time:${now}},{name:'good-new.log',time:${now}},{name:'error-old.log',time:${now - 3600000}}];selectedLogFilename='error-new.log'`, ctx);
  await ctx.uploadSelectedLog();
  assert.equal(element('logPreviewSection').style.display, 'flex');
  assert.equal(element('logPreviewContent').innerText, 'preview unchanged');
  assert.equal(vm.runInContext('selectedLogFilename', ctx), 'error-new.log');
  uploads.length = 0;
  await ctx.uploadCheckedLogs(30);
  assert.deepEqual(uploads.map(x => x.name), ['error-new.log']);
  uploads.length = 0;
  ctx.toggleLogChecked('error-old.log', true);
  await ctx.uploadCheckedLogs();
  assert.deepEqual(uploads.map(x => x.name), ['error-old.log']);
  console.log('LOG_UPLOAD_OK: preview retained, selected uploads, time-window errors only');
})().catch(error => { console.error(error); process.exitCode = 1; });
