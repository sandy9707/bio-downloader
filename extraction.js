// 引导式提取 · 独立弹窗控制器
// 内置浏览器(<webview>) 的分区会话 persist:biodl-browser 已在主进程接入下载拦截/资源嗅探/代理,
// 本窗口只负责 UI:导航、起始页、嗅探侧边栏、代码框。拦截到的下载由主窗口「传输列表」呈现。

const SITES = [
  {
    icon: '🧬', name: 'NCBI', url: 'https://www.ncbi.nlm.nih.gov/nuccore/?term=blaNDM',
    desc: '默认示例：blaNDM 检索结果，Send to → File 后自动转 efetch 分页下载并校验。',
    eg: '1. 打开 ncbi.nlm.nih.gov，搜索基因/序列\n2. 勾选结果 → Send to → File → 选格式 → Create File\n3. 本工具自动拦截并转 efetch 分页下载（断点续传）\n4. 会话过期时点右上角 🧹 清除会话后重新登录'
  },
  {
    icon: '🔬', name: 'Broad Single Cell', url: 'https://singlecell.broadinstitute.org',
    desc: '把网页 Download 给出的 curl 配置代码粘到右下代码框执行。',
    eg: '1. 打开研究页，例如 SCP259\n2. 点 Download，复制形如：\n   curl "…/generate_curl_config?accessions=SCP259&auth_code=…" -o cfg.txt; curl -K cfg.txt\n3. 粘到代码框 → 执行下载（逐文件断点续传）\n4. auth_code 过期时回网页重新 Download 复制'
  },
  {
    icon: '🌐', name: '通用网站', url: 'https://www.baidu.com',
    desc: '任意网站的真实下载自动拦截；右侧列出嗅探到的媒体/数据资源。',
    eg: '正常浏览并触发下载：\n• 下载被自动拦截 → 主窗口传输列表\n• 右侧「资源嗅探」列出 png/mp4/数据文件\n• 重要资源加粗红字置顶，点击即下\n• 有 Cookie 次数限制的网站勿高频重复请求'
  }
];

let resources = [];
let defaultDir = '';
let toastTimer = null;

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('exToast');
  t.textContent = msg;
  t.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

const wv = $('exWebview');
const urlInput = $('exUrl');

// 在 webview 区域顶部显示一条可消失的加载/错误条(比一闪而过的 toast 更持久、可读)
let statusTimer = null;
function statusBar(msg, isError) {
  let bar = document.getElementById('exStatus');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'exStatus';
    bar.style.cssText = 'position:absolute;top:0;left:0;right:0;z-index:5;padding:7px 12px;font-size:12px;line-height:1.5;color:#fff;background:rgba(15,23,42,.92);border-bottom:1px solid rgba(255,255,255,.12);display:none;';
    document.querySelector('.ex-main').appendChild(bar);
  }
  bar.style.display = 'block';
  bar.textContent = msg;
  bar.style.background = isError ? 'rgba(190,30,30,.95)' : 'rgba(15,23,42,.92)';
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { bar.style.display = 'none'; }, isError ? 8000 : 4000);
}

function showWebview() { $('exStart').style.display = 'none'; }              // 露出下方已挂载的 webview
function showStart() { try { wv.stop(); } catch (e) {} $('exStart').style.display = 'flex'; urlInput.value = ''; }  // 覆盖层盖回

// 关键修复:webview 必须先挂载并触发 dom-ready 才能 loadURL。
// 否则会抛 "The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called." → 任何页面都白屏。
let wvReadyPromise = null;
function waitForWebviewReady() {
  if (wvReadyPromise) return wvReadyPromise;
  wvReadyPromise = new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    wv.addEventListener('dom-ready', finish);
    // 已就绪则立即放行;最多等 10s,超时也放行(由 did-fail-load 提示)
    setTimeout(finish, 10000);
    try { if (wv.getWebContentsId && wv.getWebContentsId() > 0) finish(); } catch (e) {}
  });
  return wvReadyPromise;
}

async function go(urlOverride) {
  let u = (urlOverride != null ? urlOverride : (urlInput.value || '')).trim();
  if (!u) { toast('请输入网址'); return; }
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  urlInput.value = u;
  showWebview();
  statusBar('正在打开 ' + u);
  // 每次导航前按当前加速器状态刷新代理;等待 webview 就绪再加载,避免静默丢弃
  try { await window.api.syncExtractionProxy(); } catch (e) {}
  await waitForWebviewReady();
  if (wv.isLoading) { try { wv.stop(); } catch (e) {} }
  try { wv.loadURL(u); } catch (e) { statusBar('加载失败: ' + e.message, true); }
}

function renderSites() {
  $('exSites').innerHTML = SITES.map((s, i) => `
    <div class="ex-site" data-i="${i}">
      <div class="ex-site-name"><span>${s.icon}</span><span>${esc(s.name)}</span><span class="ex-site-open">打开 ›</span></div>
      <div class="ex-site-desc">${esc(s.desc)}</div>
      <div class="ex-site-eg">${esc(s.eg)}</div>
    </div>`).join('');
  document.querySelectorAll('.ex-site').forEach((el) => {
    const s = SITES[parseInt(el.dataset.i, 10)];
    el.querySelector('.ex-site-open').onclick = (e) => { e.stopPropagation(); urlInput.value = s.url; go(); };
    el.onclick = () => el.classList.toggle('open');
  });
}

function renderResources() {
  const box = $('exResources');
  const sorted = [...resources].sort((a, b) => (b.important ? 1 : 0) - (a.important ? 1 : 0));
  if (!sorted.length) {
    box.innerHTML = '<div class="ex-empty">浏览网页后，这里会列出可下载资源。<br>重要资源会<b style="color:#ef4444">加粗红字</b>置顶，点击即可下载。</div>';
    return;
  }
  box.innerHTML = sorted.map((r, i) => `
    <div class="ex-res ${r.important ? 'important' : ''}" data-i="${i}">
      <span class="ex-res-name">${esc(r.name)}</span>
      <span class="ex-res-meta">${r.important ? '★ ' : ''}${esc(r.label || r.site)} · ${esc(r.resourceType)}</span>
    </div>`).join('');
  box.querySelectorAll('.ex-res').forEach((el) => {
    const r = sorted[parseInt(el.dataset.i, 10)];
    el.onclick = () => { toast('已加入下载，可在主窗口「传输列表」查看'); window.api.extractionDownload({ url: r.url, name: r.name, saveDir: defaultDir }); };
  });
}

function addResource(r) {
  if (!r || !r.url) return;
  if (resources.some((x) => x.url === r.url)) return;
  resources.push({ url: r.url, name: r.name || r.url, important: !!r.important, site: r.site || 'generic', label: r.label || '', resourceType: r.resourceType || '' });
  if (resources.length > 300) resources.shift();
  renderResources();
}

async function runCode() {
  const code = ($('exCode').value || '').trim();
  if (!code) { toast('请粘贴下载代码'); return; }
  toast('正在解析并启动下载…');
  try {
    const res = await window.api.extractionRunCode(code, defaultDir);
    if (res && res.success) toast(res.mode === 'broad' ? `Broad 批量下载 ${res.count}/${res.total}，见主窗口传输列表` : '下载已启动，见主窗口传输列表');
    else toast((res && res.error) || '执行失败');
  } catch (e) { toast('执行失败: ' + e.message); }
}

window.addEventListener('DOMContentLoaded', async () => {
  try { if (localStorage.getItem('theme') === 'dark') document.body.classList.add('dark-mode'); } catch (e) {}
  try { const s = await window.api.getSettings(); defaultDir = (s && s.defaultDir) || ''; } catch (e) {}

  renderSites();

  window.api.onExtractionEvent((d) => {
    if (!d) return;
    if (d.type === 'resource') addResource(d);
    else if (d.type === 'log') toast(d.message);
    else if (d.type === 'download' && d.status === 'started') toast('拦截到下载: ' + (d.name || '') + ' → 主窗口传输列表');
  });

  wv.addEventListener('did-navigate', (e) => { urlInput.value = e.url; showWebview(); statusBar('已加载 ' + e.url); });
  wv.addEventListener('did-navigate-in-page', (e) => { if (e.isMainFrame) urlInput.value = e.url; });
  wv.addEventListener('did-finish-load', () => { statusBar('加载完成'); });
  wv.addEventListener('did-fail-load', (e) => {
    // -3 = ABORTED(用户主动停止/被新导航打断),不算错误
    if (e.errorCode && e.errorCode !== -3) {
      const desc = e.errorDescription || ('错误码 ' + e.errorCode);
      const hint = (e.errorCode === -105 || e.errorCode === -106 || e.errorCode === -118 || e.errorCode === -102)
        ? ' 境外站点请确认主窗口「加速器」已开启。'
        : '';
      statusBar('加载失败: ' + desc + hint, true);
    }
  });

  $('exGo').onclick = go;
  urlInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('exBack').onclick = () => { try { if (wv.canGoBack()) wv.goBack(); } catch (e) {} };
  $('exFwd').onclick = () => { try { if (wv.canGoForward()) wv.goForward(); } catch (e) {} };
  $('exReload').onclick = () => { try { wv.reload(); } catch (e) {} };
  $('exHome').onclick = showStart;
  $('exClear').onclick = async () => { const r = await window.api.extractionClearSession(); toast(r && r.success ? '已清除会话，请重新登录刷新 Token' : '清除失败'); };
  $('exRun').onclick = runCode;

  // 打开后停在起始页(主页),由用户选择站点/输入网址,不再自动跳转示例页
});
