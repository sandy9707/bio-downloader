const fs = require('fs');
const vm = require('vm');
const assert = require('node:assert/strict');
const path = require('path');
const root = path.resolve(__dirname, '..');
const production = process.argv.includes('--production');
const htmlPath = path.join(root, '01_backend_server/views/', production ? 'user.html' : 'user-cloud-preview.html');
if (!fs.existsSync(htmlPath)) { console.log('私有网站模板在发布工作区单独检查；公开仓库跳过网站模板测试'); process.exit(0); }
const html = fs.readFileSync(htmlPath, 'utf8');
for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(match[1]);
const shareCode = html.slice(html.indexOf('    const cdRefreshingShares'), html.indexOf('    // ===== 初始化'));
const fixture = () => ({ id:'one', status:'completed', accessKey:'test-key', shareLink:'https://example.invalid/old', files:[] });
function harness(api) {
  const buttons = [{dataset:{cdRefresh:'one'}, disabled:false}];
  const elements = {cdShareDialog:{open:false, dataset:{}, showModal(){this.open=true;}},cdShareUrl:{},cdShareOpen:{}};
  const calls = [];
  const context = vm.createContext({ URL, Set, TOKEN:'test-only', cdTaskId:'one', cdAccessKey:'test-key', cdTasks:[fixture()],
    api, escapeHtml:s=>String(s), toast:(...x)=>calls.push(['toast',...x]),
    cdRenderHistory:()=>calls.push(['list']), cdRenderTask:t=>calls.push(['detail',t.id]),
    document:{querySelectorAll:()=>buttons,getElementById:id=>elements[id]}
  });
  vm.runInContext(shareCode, context);
  return {context, calls, buttons, elements};
}
(async () => {
  let resolve, requests=0;
  const h=harness(()=>{requests++;return new Promise(r=>resolve=r);});
  const pending=h.context.cdRefreshShare('one','test-key');
  assert.equal(h.buttons[0].disabled,true);
  await h.context.cdRefreshShare('one','test-key');
  assert.equal(requests,1,'duplicate clicks must not generate multiple shares');
  h.context.cdTaskId='another';
  resolve({ok:true,link:'https://example.invalid/new'});
  await pending;
  assert.equal(h.context.cdTasks[0].shareLink,'https://example.invalid/new');
  assert.ok(h.calls.some(c=>c[0]==='list'));
  assert.ok(!h.calls.some(c=>c[0]==='detail'),'late response must not replace a different selected task');
  assert.equal(h.buttons[0].disabled,false);
  h.context.cdShowShare('one');
  assert.equal(h.elements.cdShareUrl.value,'https://example.invalid/new');
  assert.equal(h.elements.cdShareDialog.open,true);
  h.context.cdTasks[0].shareLink='javascript:alert(1)';
  h.context.cdShowShare('one');
  assert.equal(h.elements.cdShareUrl.value,'https://example.invalid/new','invalid URL must not enter the dialog');
  const failed=harness(async()=>{throw Error('fixture network failure');});
  await failed.context.cdRefreshShare('one','test-key');
  assert.equal(failed.context.cdTasks[0].shareLink,'https://example.invalid/old');
  assert.equal(failed.buttons[0].disabled,false);
  assert.ok(!failed.calls.some(c=>c[0]==='list'||c[0]==='detail'));
  const selected=harness(async()=>({ok:true,link:'https://example.invalid/new'}));
  await selected.context.cdRefreshShare('one','test-key');
  assert.ok(selected.calls.some(c=>c[0]==='detail'));

  const dashCode=html.slice(html.indexOf('    async function loadDash()'),html.indexOf('    // ===== 登录记录'));
  const dashEvents=[];
  const dash=vm.createContext({TOKEN:'test-only',URLSearchParams,Promise,
    location:{search:'?embed=cloud',pathname:'/user/cloud'},document:{getElementById:()=>({}),body:{classList:{add(){}}}},
    loadUserInfo:async()=>({username:'fixture'}),showAuth:v=>dashEvents.push(['auth',v]),
    cloudWorkspaceNotify:s=>dashEvents.push(['state',s]),switchView:v=>dashEvents.push(['view',v]),
    localStorage:{removeItem:()=>dashEvents.push(['clear-token'])},toast(){},console:{warn(){}},
  });
  for(const fn of ['renderStats','renderCheckin','renderSubLink','renderDevices','renderAccount','renderWallet',
    'renderInvite','renderPlans','renderRecharge','loadOrders','loadLoginLog','switchOrders']) {
    dash[fn]=()=>{throw Error('unrelated module unavailable');};
  }
  vm.runInContext(dashCode,dash);
  await dash.loadDash();
  await Promise.resolve();
  assert.ok(dashEvents.some(e=>e[0]==='view'&&e[1]==='cloud'));
  assert.ok(dashEvents.some(e=>e[0]==='state'&&e[1]==='ready'));
  if (production) {
    dashEvents.length=0;
    dash.location={search:'',pathname:'/user'};
    await dash.loadDash();
    assert.ok(dashEvents.some(e=>e[0]==='view'&&e[1]==='home'),'user homepage must retain its original default view');
    assert.ok(!html.includes('cdn.jsdelivr.net'),'critical assets must be served from this site');
    for (const [, asset] of html.matchAll(/(?:href|src)="(\/theme\/vendor\/[^"]+)"/g)) {
      assert.ok(fs.existsSync(path.join(root,'01_backend_server/views',asset)),asset);
    }
  }
  dashEvents.length=0;
  dash.loadUserInfo=async()=>{throw Error('network offline');};
  await dash.loadDash();
  assert.equal(dash.TOKEN,'test-only','network failure must preserve login');
  assert.ok(dashEvents.some(e=>e[0]==='state'&&e[1]==='error'));
  dash.loadUserInfo=async()=>{throw Object.assign(Error('unauthorized'),{status:401});};
  await dash.loadDash();
  assert.equal(dash.TOKEN,'');
  assert.ok(dashEvents.some(e=>e[0]==='auth'&&e[1]===true));

  const listeners={}, sent=[];
  vm.runInNewContext(fs.readFileSync(path.join(root,'cloud-preload.js'),'utf8'), {
    require:()=>({ipcRenderer:{sendToHost:(...x)=>sent.push(x)}}), URL,
    location:{origin:'https://biodown.ye.aimeals.cn'},
    document:{addEventListener:(name,fn)=>listeners[name]=fn},window:{addEventListener:()=>{}}
  });
  for(const href of ['javascript:alert(1)','file:///etc/passwd','https://user:password@example.invalid/']) {
    listeners.click({isTrusted:true,target:{closest:()=>({href})},preventDefault(){}});
  }
  assert.equal(sent.length,0);
  listeners.click({isTrusted:false,target:{closest:()=>({href:'https://example.invalid/'})},preventDefault(){}});
  assert.equal(sent.length,0,'synthetic clicks must not open external apps');
  listeners.click({isTrusted:true,target:{closest:()=>({href:'https://example.invalid/'})},preventDefault(){}});
  assert.equal(sent.length,1);
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  assert.ok(pkg.build.files.includes('src/**/*'));
  assert.ok(pkg.build.files.includes('cloud-preload.js'));
  assert.equal(html.includes("document.getElementById('cdTaskCard').classList.remove('hidden')"), !production);
  console.log((production ? '正式网页' : '预览网页') + '回归通过：分享显示、刷新列表/详情、重复点击、任务切换、失败保留、外部链接边界、打包清单');
})().catch(e=>{console.error(e);process.exitCode=1;});
