const fs = require('fs');
const redact = text => text.replace(/(\w+:\/\/)[^\s/]*@/g, '$1[redacted]@').replace(/([?&](?:token|password|key|signature)=)[^&\s]+/gi, '$1[redacted]');
const { spawn } = require('child_process');
const { bioSource } = require('./bio-transfer-guard');
const defaults = { http: 'native', bio: 'inherit', ftp: 'aria2', sftp: 'aria2', ftps: 'curl' };
function migrateEngineSettings(settings = {}) {
  return { ...settings, downloadEngineSchema: 2,
    downloadEngines: settings.nativeDownloadEngines || { ...defaults, ...settings.downloadEngines, http: 'native', bio: 'inherit' } };
}
// Keep old clients' settings readable if the user rolls back from the preview.
function storeEngineSettings(settings) {
  const engines = { ...defaults, ...settings.downloadEngines };
  return { ...settings, nativeDownloadEngines: engines,
    downloadEngines: { ...engines, http: engines.http === 'native' ? 'aria2' : engines.http,
      bio: engines.bio === 'native' ? 'inherit' : engines.bio } };
}
function selectEngine(file, settings = {}, filename) {
  const nativeState = filename && ['.biodl-part', '.biodl-journal'].some(suffix => fs.existsSync(filename + suffix));
  if (nativeState) {
    if (['.st', '.aria2', '.biodl.json'].some(suffix => fs.existsSync(filename + suffix))) throw new Error('同时存在不同内核的断点，已保留文件，请先核对来源');
    return 'native';
  }
  if (filename && fs.existsSync(filename + '.st') && fs.existsSync(filename + '.aria2')) throw new Error('同时存在两种下载器断点，已保留文件，请先核对断点来源');
  // Never interpret another engine's sparse file/control file as sequential data.
  if (filename && fs.existsSync(filename + '.st')) return 'axel';
  if (filename && fs.existsSync(filename + '.aria2')) return 'aria2';
  if (filename) try {
    const record = filename + '.biodl.json';
    if (fs.existsSync(filename) && fs.statSync(record).size < 1024 * 1024) {
      const state = JSON.parse(fs.readFileSync(record, 'utf8'));
      if (state.engine === 'aria2' || state.engine === 'axel') return state.engine;
    }
  } catch (_) {}
  const config = { ...defaults, ...settings.downloadEngines };
  const protocol = new URL(file.url).protocol;
  const group = ({ 'ftp:': 'ftp', 'sftp:': 'sftp', 'ftps:': 'ftps' }[protocol]) || (bioSource(file.url) ? 'bio' : 'http');
  const engine = config[group] === 'inherit' ? config.http : config[group];
  const choices = ['ftp', 'sftp'].includes(group) ? ['aria2', 'curl'] : group === 'ftps' ? ['curl'] : ['native', 'aria2', 'axel'];
  if (!choices.includes(engine)) throw new Error('该协议不支持所选下载器，请在设置中调整下载引擎');
  return engine;
}
// OpenSSL's provider is loaded dynamically and is not listed in PE imports.
// Keep this runtime setting private to the aria2 child process.
function ariaEnvironment(binary, env = process.env) {
  const result = { ...env }, dir = require('path').dirname(binary);
  if (process.platform === 'win32' && fs.existsSync(require('path').join(dir, 'legacy.dll'))) result.OPENSSL_MODULES = '.';
  return result;
}
// The Windows OpenSSL loader rejects non-ASCII absolute provider paths.
// Resolve its bundled provider relative to the child working directory instead;
// Node/Windows can set that directory using the Unicode API.
function ariaWorkingDirectory(binary) {
  const dir = require('path').dirname(binary);
  return process.platform === 'win32' && fs.existsSync(require('path').join(dir, 'legacy.dll')) ? dir : undefined;
}
function ariaArgs({ url, filename, threads = 16, proxy = '', binary }) {
  const path = require('path');
  return ['--no-conf=true', '--no-netrc=true', '--enable-color=false', '--human-readable=false',
    '--continue=true', '--always-resume=true', '--auto-save-interval=1',
    '--auto-file-renaming=false', '--allow-overwrite=false', '--file-allocation=none',
    '--follow-torrent=false', '--follow-metalink=false', '--check-integrity=false', '--summary-interval=1', '--console-log-level=warn',
    '--stderr=true', '--show-console-readout=false', '--truncate-console-readout=false',
    '--download-result=hide', '--max-tries=3', '--retry-wait=2', '--connect-timeout=20', '--timeout=30',
    '--max-connection-per-server=' + Math.min(16, threads), '--split=' + Math.min(16, threads), '--min-split-size=1M',
    '--all-proxy=' + proxy, '--http-proxy=' + proxy, '--https-proxy=' + proxy, '--ftp-proxy=' + proxy,
    '--no-proxy=', ...(binary && fs.existsSync(path.join(path.dirname(binary), 'ca-certificates.crt')) ? ['--ca-certificate=' + path.join(path.dirname(binary), 'ca-certificates.crt')] : []), '--dir=' + path.dirname(filename), '--out=' + path.basename(filename), url];
}
function runAria({ binary, url, filename, threads, env, proxy = '', onProcess = () => {}, onProgress = () => {}, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = ariaEnvironment(binary, env);
    for (const key of Object.keys(cleanEnv)) if (/^(http|https|ftp|all|no)_proxy$/i.test(key)) delete cleanEnv[key];
    const proc = spawn(binary, ariaArgs({ url, filename, threads, proxy, binary }), { env: cleanEnv, cwd: ariaWorkingDirectory(binary), windowsHide: true });
    let tail = '';
    onProcess(proc);
    // stdout and stderr are independent streams; never join their partial lines.
    // Periodic summaries on stderr avoid buffered stdout and stale TTY readouts
    // in Windows GUI applications. Parse the final summary in each chunk.
    const output = () => {
      let fragment = '';
      return data => {
        const text = redact(data.toString()); tail = (tail + text).slice(-3000); fragment += text;
        const lines = fragment.split(/[\r\n]/); fragment = lines.pop().slice(-2000);
        let progress;
        for (const line of lines) {
          const match = /\[#\w+\s+(\d+)B\/(\d+)B\((?:\d+%|--%)\).*?DL:(\d+)B/.exec(line);
          if (match) {
            const receivedBytes = +match[1], totalBytes = +match[2], speedBps = +match[3];
            progress = { receivedBytes, totalBytes, speedBps,
              percentage: totalBytes > 0 ? Math.min(100, Math.floor(receivedBytes * 1000 / totalBytes) / 10) : 0,
              speed: (speedBps / 1024).toFixed(1) + ' KB/s' };
          } else if (/error|failed|exception/i.test(line)) log(line + '\n');
        }
        if (progress) onProgress(progress);
      };
    };
    proc.stdout.on('data', output()); proc.stderr.on('data', output());
    proc.once('error', reject);
    proc.once('close', code => code === 0 ? resolve() : reject(new Error('aria2c 退出码 ' + code + ': ' + tail.trim().slice(-400))));
  });
}
module.exports = { defaults, migrateEngineSettings, storeEngineSettings, selectEngine, ariaArgs, ariaEnvironment, ariaWorkingDirectory, runAria };
