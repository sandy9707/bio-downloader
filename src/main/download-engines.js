const fs = require('fs');
const redact = text => text.replace(/(\w+:\/\/)[^\s/]*@/g, '$1[redacted]@').replace(/([?&](?:token|password|key|signature)=)[^&\s]+/gi, '$1[redacted]');
const { spawn } = require('child_process');
const { bioSource } = require('./bio-transfer-guard');
const defaults = { http: 'aria2', bio: 'inherit', ftp: 'aria2', sftp: 'aria2', ftps: 'curl' };
function selectEngine(file, settings = {}, filename) {
  if (filename && fs.existsSync(filename + '.st') && fs.existsSync(filename + '.aria2')) throw new Error('同时存在两种下载器断点，已保留文件，请先核对断点来源');
  // Never interpret another engine's sparse file/control file as sequential data.
  if (filename && fs.existsSync(filename + '.st')) return 'axel';
  if (filename && fs.existsSync(filename + '.aria2')) return 'aria2';
  if (filename) try {
    const record = filename + '.biodl.json';
    if (fs.existsSync(filename) && fs.statSync(record).size < 1024 * 1024) {
      const state = JSON.parse(fs.readFileSync(record, 'utf8'));
      if (!state.completed && state.resume) return state.engine === 'aria2' ? 'aria2' : 'axel';
    }
  } catch (_) {}
  const config = { ...defaults, ...settings.downloadEngines };
  const protocol = new URL(file.url).protocol;
  const group = bioSource(file.url) ? 'bio' : ({ 'ftp:': 'ftp', 'sftp:': 'sftp', 'ftps:': 'ftps' }[protocol] || 'http');
  const engine = config[group] === 'inherit' ? config.http : config[group];
  const choices = ['ftp', 'sftp'].includes(group) ? ['aria2', 'curl'] : group === 'ftps' ? ['curl'] : ['aria2', 'axel'];
  if (!choices.includes(engine)) throw new Error('该协议不支持所选下载器，请在设置中调整下载引擎');
  return engine;
}
function ariaArgs({ url, filename, threads = 16, proxy = '' }) {
  const path = require('path');
  return ['--no-conf=true', '--no-netrc=true', '--enable-color=false', '--human-readable=false',
    '--continue=true', '--always-resume=true', '--auto-save-interval=1',
    '--auto-file-renaming=false', '--allow-overwrite=false', '--file-allocation=none',
    '--follow-torrent=false', '--follow-metalink=false', '--check-integrity=false', '--summary-interval=1', '--console-log-level=warn',
    '--download-result=hide', '--max-tries=3', '--retry-wait=2', '--connect-timeout=20', '--timeout=30',
    '--max-connection-per-server=' + Math.min(16, threads), '--split=' + Math.min(16, threads), '--min-split-size=1M',
    '--all-proxy=' + proxy, '--http-proxy=' + proxy, '--https-proxy=' + proxy, '--ftp-proxy=' + proxy,
    '--no-proxy=', '--dir=' + path.dirname(filename), '--out=' + path.basename(filename), url];
}
function runAria({ binary, url, filename, threads, env, proxy = '', onProcess = () => {}, onProgress = () => {}, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const cleanEnv = { ...env };
    for (const key of Object.keys(cleanEnv)) if (/^(http|https|ftp|all|no)_proxy$/i.test(key)) delete cleanEnv[key];
    const proc = spawn(binary, ariaArgs({ url, filename, threads, proxy }), { env: cleanEnv, windowsHide: true });
    let tail = '', fragment = '';
    onProcess(proc);
    const output = data => {
      const text = redact(data.toString()); tail = (tail + text).slice(-3000); fragment += text;
      const lines = fragment.split(/[\r\n]/); fragment = lines.pop().slice(-2000);
      for (const line of lines) {
        // Completed bytes are aria2's piece count, never the sparse file length.
        const match = /\s(\d+)B\/(\d+)B\((\d+)%\).*?DL:(\d+)B/.exec(line);
        if (match) onProgress({ receivedBytes: +match[1], totalBytes: +match[2], percentage: Math.min(99, +match[3]), speed: (+match[4] / 1024).toFixed(1) + ' KB/s' });
        else if (/error|failed|exception/i.test(line)) log(line + '\n');
      }
    };
    proc.stdout.on('data', output); proc.stderr.on('data', output);
    proc.once('error', reject);
    proc.once('close', code => code === 0 ? resolve() : reject(new Error('aria2c 退出码 ' + code + ': ' + tail.trim().slice(-400))));
  });
}
module.exports = { defaults, selectEngine, ariaArgs, runAria };
