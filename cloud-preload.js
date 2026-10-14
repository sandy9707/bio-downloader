// Only bridge explicit link clicks and load state from the trusted cloud page.
// Remote content never receives a Node/Electron API.
const { ipcRenderer } = require('electron');
const trusted = location.origin === 'https://biodown.ye.aimeals.cn';
if (trusted) {
  document.addEventListener('click', (event) => {
    const link = event.target.closest && event.target.closest('a[data-cloud-external]');
    if (!link || !event.isTrusted) return;
    event.preventDefault();
    try {
      const url = new URL(link.href);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return;
      ipcRenderer.sendToHost('biodl-cloud-open-external', url.href);
    } catch (_) {}
  }, true);
  window.addEventListener('biodl-cloud-state', (event) => {
    const status = event.detail && event.detail.status;
    if (status === 'ready' || status === 'error') ipcRenderer.sendToHost('biodl-cloud-state', status);
  });
  window.addEventListener('error', () => ipcRenderer.sendToHost('biodl-cloud-state', 'error'));
  window.addEventListener('unhandledrejection', () => ipcRenderer.sendToHost('biodl-cloud-state', 'error'));
}
