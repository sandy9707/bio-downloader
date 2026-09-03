const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const { DATA_DIR } = require('./storage');

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL || 'https://biodown.ye.aimeals.cn';
const CLASH_DIR = path.join(DATA_DIR, 'clash');
if (!fs.existsSync(CLASH_DIR)) {
  try { fs.mkdirSync(CLASH_DIR, { recursive: true }); } catch (e) {}
}

let clashProcess = null;
let currentRealNodeCount = 0;

function checkPortBusy(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', (err) => resolve(err.code === 'EADDRINUSE'))
      .once('listening', () => {
        server.close();
        resolve(false);
      })
      .listen(port, host);
  });
}

function waitForPortReady(port, host = '127.0.0.1', timeoutMs = 4000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      if (Date.now() - start > timeoutMs) {
        return reject(new Error(`加速核心端口 ${port} 启动超时`));
      }
      const sock = new net.Socket();
      sock.setTimeout(400);
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        setTimeout(tryConnect, 100);
      });
      sock.once('timeout', () => {
        sock.destroy();
        setTimeout(tryConnect, 100);
      });
      sock.connect(port, host);
    };
    tryConnect();
  });
}

function getClashBinaryPath() {
  const platform = process.platform;
  const arch = process.arch;
  // 支持环境变量指定，或优先从系统 PATH 查找 mihomo
  if (process.env.MIHOMO_PATH && fs.existsSync(process.env.MIHOMO_PATH)) {
    return process.env.MIHOMO_PATH;
  }
  const binDir = path.join(__dirname, '../../bin', platform === 'win32' ? 'win32' : (platform === 'darwin' ? 'darwin' : 'linux'));
  if (platform === 'darwin') {
    return arch === 'arm64' ? path.join(binDir, 'mihomo_aarch64') : path.join(binDir, 'mihomo_x86_64');
  } else if (platform === 'win32') {
    return path.join(binDir, 'mihomo_windows_x86_64.exe');
  } else {
    return path.join(binDir, arch === 'arm64' ? 'mihomo_linux_arm64' : 'mihomo_linux_amd64');
  }
}

async function killExistingClash() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('taskkill /F /IM mihomo_windows_x86_64.exe /IM mihomo.exe 2>nul', () => resolve());
    } else {
      exec('killall -9 mihomo_aarch64 mihomo_x86_64 mihomo_linux_amd64 mihomo 2>/dev/null', () => resolve());
    }
  });
}

function stripFakeProxyNodes(yamlContent) {
  const FAKE_NAME_PATTERN = /剩余流量|套餐到期|距离下次|官网地址|套餐订阅已过期|请去官网/;
  const lines = yamlContent.split('\n');
  const out = [];
  let inFakeBlock = false;
  let fakeNames = new Set();

  for (const line of lines) {
    const nodeStart = line.match(/^\s*-\s*(?:\{\s*)?name:\s*(.+?)\s*$/);
    if (nodeStart) {
      const rawName = nodeStart[1].replace(/^["']|["'],?$/g, '').trim();
      if (FAKE_NAME_PATTERN.test(rawName)) {
        inFakeBlock = true;
        fakeNames.add(rawName);
        continue;
      } else {
        inFakeBlock = false;
      }
    } else if (inFakeBlock) {
      if (/^\s*-\s+/.test(line) || /^[a-zA-Z]/.test(line)) {
        inFakeBlock = false;
      } else {
        continue;
      }
    }
    out.push(line);
  }

  if (fakeNames.size > 0) {
    const cleanLines = [];
    for (const l of out) {
      let skip = false;
      for (const fn of fakeNames) {
        if (l.includes(fn)) { skip = true; break; }
      }
      if (!skip) cleanLines.push(l);
    }
    return cleanLines.join('\n');
  }
  return yamlContent;
}

async function startClash(token, port = 43289, secret = '') {
  if (clashProcess) return true;
  await killExistingClash();

  const isPortBusy = await checkPortBusy(port);
  if (isPortBusy) throw new Error(`加速器端口 ${port} 冲突，请关闭其他代理后重试`);

  const subUrl = `${BACKEND_BASE_URL}/speedup?token=${token}`;
  const response = await axios.get(subUrl, { timeout: 10000, validateStatus: () => true });
  if (response.status >= 400) {
    throw new Error('拉取加速订阅失败: ' + (typeof response.data === 'string' ? response.data : response.status));
  }

  let yaml = String(response.data);
  yaml = yaml.replace(/^mixed-port:\s*\d+/gm, `mixed-port: ${port}`);
  yaml = yaml.replace(/^port:\s*\d+/gm, `port: ${port}`);
  yaml = yaml.replace(/^external-controller:\s*.*/gm, '');
  yaml = `external-controller: 127.0.0.1:43299\nlog-level: warning\n` + yaml;
  yaml = yaml.replace(/max-failed-times:\s*\d+/g, 'max-failed-times: 1');
  yaml = yaml.replace(/interval:\s*\d+/g, 'interval: 15');
  yaml = yaml.replace(/timeout:\s*10000/g, 'timeout: 3000');
  yaml = yaml.replace(/(type:\s*(?:load-balance|url-test|fallback))/g, '$1\n    lazy: true');
  yaml = stripFakeProxyNodes(yaml);

  const proxyMatches = yaml.match(/^\s*-\s*(?:\{\s*)?name\s*:/gm);
  currentRealNodeCount = proxyMatches ? proxyMatches.length : 60;

  const configFile = path.join(CLASH_DIR, 'config.yaml');
  fs.writeFileSync(configFile, yaml, 'utf8');

  const binaryPath = getClashBinaryPath();
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`找不到 mihomo 二进制可执行文件: ${binaryPath}`);
  }

  clashProcess = spawn(binaryPath, ['-d', CLASH_DIR]);
  clashProcess.on('close', () => { clashProcess = null; });

  await waitForPortReady(port, '127.0.0.1', 4000);
  return { success: true, nodeCount: currentRealNodeCount };
}

function stopClash() {
  if (clashProcess) {
    try { clashProcess.kill('SIGKILL'); } catch (e) {}
    clashProcess = null;
  }
}

module.exports = {
  startClash,
  stopClash,
  checkPortBusy,
  getClashStatus: () => clashProcess !== null,
  getNodeCount: () => currentRealNodeCount
};
