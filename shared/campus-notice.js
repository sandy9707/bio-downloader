/* Usage declaration only: no network detection, polling or device fingerprint. */
(function (global) {
  const KEY = 'biodl:usage-choice:v1';
  const TEXT = '不推荐在任何校园网环境下使用本软件。在校园网内使用属于高风险行为；因校园网使用产生的账号封禁等后果，目前无法提供相应售后处理。建议在家用宽带、手机流量或热点，或允许使用本软件的网吧环境下使用。';
  function mount(options = {}) {
    if (global.campusNotice) return global.campusNotice;
    let choice = options.choice;
    if (!['accepted', 'declined'].includes(choice)) {
      try { choice = localStorage.getItem(KEY); } catch (_) {}
    }
    if (!['accepted', 'declined'].includes(choice)) choice = 'unset';
    const host = options.host || document.querySelector('.main-content') || document.body;
    const banner = document.createElement('aside'); banner.className = 'bd-network bd-network--risk';
    banner.innerHTML = '<div class="bd-network__summary"><div><strong data-usage-title></strong><p>下载与加速尚未开启；登录、设置和更新仍可使用。</p></div><button type="button" data-usage-open>查看声明并更改选择</button></div>';
    host.prepend(banner);
    const dialog = document.createElement('dialog'); dialog.className = 'bd-network-dialog';
    dialog.setAttribute('aria-labelledby', 'bd-usage-heading');
    dialog.innerHTML = '<div class="bd-network-dialog__label">使用声明</div><h2 id="bd-usage-heading">使用前请知悉</h2><p data-usage-text></p><p class="bd-network-dialog__limit">本提示不检测网络环境，也不读取 IP、Wi-Fi 名称或其他网络信息；仅在本机保存您的选择。</p><p data-usage-save-error role="alert" hidden></p><div class="bd-network-dialog__actions"><button type="button" data-usage-decline>不使用</button><button type="button" data-usage-accept>我已知悉并确认使用</button></div>';
    dialog.querySelector('[data-usage-text]').textContent = TEXT; document.body.append(dialog);
    function render() {
      document.body.classList.add('bd-usage-enabled');
      document.body.classList.toggle('bd-campus-risk', choice === 'declined');
      banner.hidden = choice === 'accepted';
      banner.querySelector('[data-usage-title]').textContent = choice === 'declined' ? '您已选择不使用下载与加速功能' : '请先阅读使用声明';
      dialog.classList.toggle('bd-usage-declined', choice === 'declined');
      dialog.querySelector('h2').textContent = choice === 'declined' ? '已选择不使用' : '使用前请知悉';
    }
    function open() { render(); if (!dialog.open) dialog.showModal(); }
    async function save(value) {
      const buttons = dialog.querySelectorAll('button'); buttons.forEach(b => b.disabled = true);
      try {
        if (options.onChange) await options.onChange(value);
        // App settings are authoritative when supplied; web-only storage failure is visible.
        try { localStorage.setItem(KEY, value); } catch (e) { if (!options.onChange) throw e; }
        choice = value; render(); dialog.close();
        dialog.querySelector('[data-usage-save-error]').hidden = true;
      } catch (_) {
        const error = dialog.querySelector('[data-usage-save-error]'); error.textContent = '未能保存选择，请允许本机存储后重试。'; error.hidden = false;
      } finally { buttons.forEach(b => b.disabled = false); }
    }
    dialog.querySelector('[data-usage-accept]').onclick = () => save('accepted');
    dialog.querySelector('[data-usage-decline]').onclick = () => save('declined');
    dialog.addEventListener('cancel', event => { event.preventDefault(); save('declined'); });
    banner.querySelector('button').onclick = open;
    global.addEventListener('storage', event => {
      if (event.key === KEY && !options.onChange) { choice = ['accepted','declined'].includes(event.newValue) ? event.newValue : 'unset'; render(); if (choice === 'accepted') dialog.close(); }
    });
    const api = {
      ready: Promise.resolve(),
      getState: () => ({ choice }),
      requiresAcknowledgment: () => choice !== 'accepted',
      show: open,
      beforeUse: async () => { if (choice === 'accepted') return true; open(); return false; }
    };
    global.campusNotice = api; render();
    // A refusal stays visible in the banner; only first use opens automatically.
    if (choice === 'unset') open();
    return api;
  }
  global.BioUsageNotice = { mount, TEXT, KEY };
})(window);
