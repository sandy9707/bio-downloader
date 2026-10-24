(function () {
  function start() {
    if (!window.BioUsageNotice) return;
    const auth = document.getElementById('authView');
    const host = document.createElement('div'); host.id = 'bd-network-host';
    function place() {
      const content = document.querySelector('.main-content > .section > .container') || document.querySelector('.main-content') || document.querySelector('body > .container') || document.body;
      const target = auth && getComputedStyle(auth).display !== 'none' ? auth : content;
      if (host.parentElement !== target) target.prepend(host);
    }
    place();
    if (auth) new MutationObserver(place).observe(auth, { attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
    window.BioUsageNotice.mount({ host });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
