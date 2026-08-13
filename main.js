const { app, BrowserWindow, BrowserView, ipcMain, dialog, shell, session, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const os = require('os');
const crypto = require('crypto');

// ===== 热更新签名验签 =====
// 内嵌的热更新补丁验签公钥(Ed25519)。私钥离线保管,仅在发布补丁时签名。
// 任何补丁必须 sha256 匹配、且签名通过该公钥验证,才会被应用;否则中止并保留当前版本。
const HOT_UPDATE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAdmJCuvTeFDhaU9DPSEP3yfSmf8OCCxnrt206d4L6VWY=
-----END PUBLIC KEY-----`;

// 计算文件 sha256(hex,小写)
function fileSha256(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 校验补丁:sha256 必须匹配,且签名(对 sha256 十六进制串的 Ed25519 签名, base64)必须通过公钥验证
function verifyPatchFile(filePath, expectedSha256, signatureB64) {
  if (!expectedSha256 || !signatureB64) return false;
  const actual = fileSha256(filePath);
  if (actual !== String(expectedSha256).toLowerCase()) {
    console.error(`[HotPatch] sha256 不匹配: 期望 ${expectedSha256}, 实际 ${actual}`);
    return false;
  }
  try {
    const ok = crypto.verify(null, Buffer.from(actual), HOT_UPDATE_PUBLIC_KEY, Buffer.from(signatureB64, 'base64'));
    if (!ok) console.error('[HotPatch] 签名验证未通过');
    return ok;
  } catch (e) {
    console.error('[HotPatch] 签名验证异常:', e.message);
    return false;
  }
}

// 简易 semver 比较: a>b 返回 1, a<b 返回 -1, 相等 0(按数字段比较,用于防降级)
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map((x) => parseInt(x, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0, db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

// 判断 URL 是否与 BACKEND_BASE_URL 同源(热更新补丁只允许来自官方后端)
function isSameOrigin(url) {
  try {
    return new URL(url).origin === new URL(BACKEND_BASE_URL).origin;
  } catch (e) {
    return false;
  }
}

// 加载 .env 配置文件 (兼容开发与打包环境)
function loadEnv() {
  const envPaths = [
    path.join(__dirname, '.env'),
    path.join(app.getAppPath(), '.env'),
    path.join(app.getAppPath(), '../.env') // 支持在主工程目录下本地调试
  ];
  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const lines = fs.readFileSync(envPath, 'utf8').split('\n');
      for (const line of lines) {
        const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
        if (match) {
          const key = match[1];
          let val = match[2].trim();
          if (val.startsWith('"') && val.endsWith('"')) {
            val = val.substring(1, val.length - 1);
          } else if (val.startsWith("'") && val.endsWith("'")) {
            val = val.substring(1, val.length - 1);
          }
          process.env[key] = val;
        }
      }
    }
  }
}

// 综合加载所有配置
let BACKEND_BASE_URL = 'https://biodown.ye.aimeals.cn';

function loadConfiguration() {
  loadEnv();
  if (process.env.BACKEND_BASE_URL) {
    BACKEND_BASE_URL = process.env.BACKEND_BASE_URL;
    return;
  }

  // 尝试从打包后的 config.json 中读取配置 (常用于 GHA 自动构建注入)
  try {
    const configPaths = [
      path.join(__dirname, 'config.json'),
      path.join(app.getAppPath(), 'config.json')
    ];
    for (const configPath of configPaths) {
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (config.BACKEND_BASE_URL) {
          BACKEND_BASE_URL = config.BACKEND_BASE_URL;
          console.log('Loaded BACKEND_BASE_URL from config.json:', BACKEND_BASE_URL);
          return;
        }
      }
    }
  } catch (e) {
    console.error('加载 config.json 失败:', e);
  }
}
loadConfiguration();

let mainWindow;
let extractionWindow = null; // 引导式提取独立弹出窗口
let clashProcess = null;
let currentAxelProcess = null;
const activeAxelProcesses = new Map();
const pausedAxelFiles = new Set(); // 用户手动暂停的 fileIndex:kill 进程但保留 axel 断点(.st),进程退出不自动重试,状态回传 paused
const cancelledFiles = new Set();  // 用户手动取消的 fileIndex:立即中止重试与 Node 保底,状态回传 cancelled

function killProcess(proc) {
  if (!proc) return;
  try {
    if (process.platform === 'win32') {
      exec(`taskkill /pid ${proc.pid} /T /F`, (err) => {
        if (err) {
          console.warn(`taskkill failed for pid ${proc.pid}, falling back to kill():`, err.message);
          proc.kill('SIGKILL');
        }
      });
    } else {
      proc.kill('SIGKILL');
    }
  } catch (e) {
    console.error(`Error killing process:`, e);
  }
}

function killAllAxelProcesses() {
  for (const [index, proc] of activeAxelProcesses.entries()) {
    if (proc) {
      console.log(`Terminating Axel process for index ${index}...`);
      killProcess(proc);
    }
  }
  activeAxelProcesses.clear();
}

function ensureExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    console.log(`Binary is already executable: ${filePath}`);
  } catch (err) {
    try {
      fs.chmodSync(filePath, '755');
      console.log(`Successfully chmod executable: ${filePath}`);
    } catch (chmodErr) {
      console.warn(`Failed to chmod binary inside read-only volume: ${chmodErr.message}`);
    }
  }
}

// ==========================================
// 【文件路径管理】
// ==========================================
// 针对打包和开发环境，获取 bin 资源文件夹的路径
const BIN_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'bin')
  : path.join(__dirname, 'bin');

// 获取 clash 配置存储的工作空间
const CLASH_WORK_DIR = path.join(app.getPath('userData'), 'clash');
if (!fs.existsSync(CLASH_WORK_DIR)) {
  fs.mkdirSync(CLASH_WORK_DIR, { recursive: true });
}

// 获取用户空间中用于存放二进制可执行文件的目录（避免在 Windows Temp 临时目录下由于权限/杀毒软件拦截导致无法执行）
const USER_BIN_DIR = path.join(app.getPath('userData'), 'bin');
if (!fs.existsSync(USER_BIN_DIR)) {
  fs.mkdirSync(USER_BIN_DIR, { recursive: true });
}

// 拷贝 Country.mmdb 和 GeoSite.dat 依赖到工作空间
function ensureClashDataFiles() {
  const mmdbSrc = path.join(BIN_DIR, 'Country.mmdb');
  const mmdbDest = path.join(CLASH_WORK_DIR, 'Country.mmdb');
  const datSrc = path.join(BIN_DIR, 'GeoSite.dat');
  const datDest = path.join(CLASH_WORK_DIR, 'GeoSite.dat');

  if (fs.existsSync(mmdbSrc) && (!fs.existsSync(mmdbDest) || fs.statSync(mmdbSrc).size !== fs.statSync(mmdbDest).size)) {
    fs.copyFileSync(mmdbSrc, mmdbDest);
    console.log('Copied Country.mmdb to user space');
  }
  if (fs.existsSync(datSrc) && (!fs.existsSync(datDest) || fs.statSync(datSrc).size !== fs.statSync(datDest).size)) {
    fs.copyFileSync(datSrc, datDest);
    console.log('Copied GeoSite.dat to user space');
  }
}

// 拷贝加速器及多线程二进制可执行文件到用户空间以保障执行权限
function ensureBinaries() {
  const platform = os.platform();
  const filesToCopy = [];

  if (platform === 'darwin') {
    filesToCopy.push(
      { src: path.join(BIN_DIR, 'darwin', 'axel'), dest: 'axel' },
      { src: path.join(BIN_DIR, 'darwin', 'mihomo_aarch64'), dest: 'mihomo_aarch64' },
      { src: path.join(BIN_DIR, 'darwin', 'mihomo_x86_64'), dest: 'mihomo_x86_64' }
    );
  } else if (platform === 'win32') {
    filesToCopy.push(
      { src: path.join(BIN_DIR, 'win32', 'axel.exe'), dest: 'axel.exe' },
      { src: path.join(BIN_DIR, 'win32', 'mihomo_windows_x86_64.exe'), dest: 'mihomo_windows_x86_64.exe' },
      { src: path.join(BIN_DIR, 'win32', 'msys-2.0.dll'), dest: 'msys-2.0.dll' },
      { src: path.join(BIN_DIR, 'win32', 'msys-crypto-3.dll'), dest: 'msys-crypto-3.dll' },
      { src: path.join(BIN_DIR, 'win32', 'msys-ssl-3.dll'), dest: 'msys-ssl-3.dll' }
    );
  }

  for (const item of filesToCopy) {
    const destPath = path.join(USER_BIN_DIR, item.dest);
    if (fs.existsSync(item.src)) {
      if (!fs.existsSync(destPath) || fs.statSync(item.src).size !== fs.statSync(destPath).size) {
        try {
          fs.copyFileSync(item.src, destPath);
          console.log(`Successfully copied binary ${item.dest} to user space`);
        } catch (copyErr) {
          console.error(`Failed to copy binary ${item.dest}:`, copyErr.message);
        }
      }
      
      // Unix 系统上确保可执行权限
      if (platform !== 'win32') {
        try {
          fs.chmodSync(destPath, '755');
        } catch (chmodErr) {
          console.error(`Failed to chmod binary ${item.dest}:`, chmodErr.message);
        }
      }
    } else {
      console.warn(`Source binary not found at: ${item.src}`);
    }
  }
}

// 获取 Clash 执行路径
function getClashBinaryPath() {
  const platform = os.platform();
  const arch = os.arch();
  
  if (platform === 'darwin') {
    return arch === 'arm64' 
      ? path.join(USER_BIN_DIR, 'mihomo_aarch64')
      : path.join(USER_BIN_DIR, 'mihomo_x86_64');
  } else if (platform === 'win32') {
    return path.join(USER_BIN_DIR, 'mihomo_windows_x86_64.exe');
  }
  throw new Error('不支持的操作系统平台: ' + platform);
}

// 获取 Axel 执行路径
function getAxelBinaryPath() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(USER_BIN_DIR, 'axel');
  } else if (platform === 'win32') {
    return path.join(USER_BIN_DIR, 'axel.exe');
  }
  throw new Error('不支持的操作系统平台: ' + platform);
}

// ==========================================
// 【本地配置管理与日志系统】
// ==========================================
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');
const LOG_DIR = path.join(app.getPath('userData'), 'download_logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// 自动清理 7 天前的日志文件
function cleanOldLogs() {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const now = Date.now();
    const files = fs.readdirSync(LOG_DIR);
    files.forEach(file => {
      if (!file.endsWith('.log')) return;
      const filePath = path.join(LOG_DIR, file);
      const stats = fs.statSync(filePath);
      const ageInDays = (now - stats.mtimeMs) / (1000 * 60 * 60 * 24);
      if (ageInDays > 7) {
        fs.unlinkSync(filePath);
        console.log(`Auto-cleaned old log file: ${file}`);
      }
    });
  } catch (err) {
    console.error('Failed to clean old logs:', err);
  }
}
cleanOldLogs();

function getSettings() {
  if (fs.existsSync(SETTINGS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
    } catch (e) {
      return {};
    }
  }
  return {};
}

function saveSettings(settings) {
  const current = getSettings();
  const updated = { ...current, ...settings };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

// ==========================================
// 【窗口生命周期】
// ==========================================
function createWindow() {
  const iconFile = process.platform === 'win32'
    ? path.join(__dirname, 'icons', 'icon.ico')
    : path.join(__dirname, 'icons', 'icon.icns');

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: '生信数据多线程加速下载器',
    icon: iconFile,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      // 2.0.0 引导式提取:允许渲染进程内嵌 <webview> 内置浏览器(独立分区会话)
      webviewTag: true
    },
    frame: true,
    show: false,
    backgroundColor: '#0f172a'
  });

  mainWindow.loadFile('index.html');
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });



  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function checkPendingAsarUpdates() {
  try {
    const updateAsar = path.join(process.resourcesPath, 'update.asar');
    const targetAsar = path.join(process.resourcesPath, 'app.asar');
    if (fs.existsSync(updateAsar)) {
      const manifestPath = updateAsar + '.manifest';
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch(e){}
      // 安全:无清单或验签不通过的暂存补丁一律丢弃,绝不应用未校验的代码
      if (!manifest || !verifyPatchFile(updateAsar, manifest.sha256, manifest.signature)) {
        console.warn('Pending update.asar 未通过签名校验,已丢弃。');
        try { fs.unlinkSync(updateAsar); } catch(e){}
        try { fs.unlinkSync(manifestPath); } catch(e){}
        return;
      }
      console.log('Found verified pending update.asar, applying now on startup...');
      const backupAsar = path.join(process.resourcesPath, 'app.asar.old');
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
      if (fs.existsSync(targetAsar)) fs.renameSync(targetAsar, backupAsar);
      fs.renameSync(updateAsar, targetAsar);
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
      try { fs.unlinkSync(manifestPath); } catch(e){}
    }
  } catch (e) {
    console.error('Error applying pending asar update on startup:', e);
  }
}

app.whenReady().then(() => {
  checkPendingAsarUpdates();
  ensureBinaries();
  ensureClashDataFiles();
  createWindow();
  setupExtractionBrowser(); // 2.0.0 引导式提取:初始化内置浏览器分区会话/下载拦截/资源嗅探
  buildAppMenu();           // 应用菜单:File 含「添加链接 / 打开引导式提取」

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopClash();
  killAllAxelProcesses();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopClash();
  killAllAxelProcesses();
});

// ==========================================
// 【Clash 运行控制模块与端口占用检测】
// ==========================================
const net = require('net');

function killExistingClashProcesses() {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      exec('taskkill /F /IM mihomo_windows_x86_64.exe', () => {
        resolve();
      });
    } else {
      exec('killall -9 mihomo_aarch64; killall -9 mihomo_x86_64', () => {
        resolve();
      });
    }
  });
}

function checkPortBusy(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
      .once('error', (err) => {
        if (err.code === 'EADDRINUSE') {
          resolve(true);
        } else {
          resolve(false);
        }
      })
      .once('listening', () => {
        server.close();
        resolve(false);
      })
      .listen(port, '127.0.0.1');
  });
}

// 【2.0.3 诊断】加速器日志:写入 LOG_DIR(即 设置→诊断日志 可查看/上传),便于回溯
const CLASH_LOG_FILE = path.join(LOG_DIR, 'clash.log');
function writeClashLog(msg) {
  try {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    fs.appendFileSync(CLASH_LOG_FILE, line, 'utf8');
    console.log(msg);
  } catch (e) {}
}
async function startClash(token) {
  writeClashLog(`[startClash] begin token=${token ? token.slice(0, 8) + '…' : '(空)'}`);
  if (clashProcess) {
    writeClashLog('[startClash] already running, return true');
    return true;
  }

  // 1. 强制清理残留后台 Clash 进程，释放加速端口
  await killExistingClashProcesses();
  writeClashLog('[startClash] killed existing clash processes');

  // 2. 检测 43289 端口是否被占用
  const isPortBusy = await checkPortBusy(43289);
  writeClashLog(`[startClash] port 43289 busy=${isPortBusy}`);
  if (isPortBusy) {
    const e = new Error('下载加速器启动失败：加速端口冲突，请关闭其他代理/加速器软件或重启电脑后重试。');
    writeClashLog('[startClash] FAIL port busy');
    throw e;
  }

  try {
    writeClashLog('[startClash] fetching /speedup subscription...');
    const subUrl = `${BACKEND_BASE_URL}/speedup?token=${token}`;
    let response;
    try {
      response = await axios.get(subUrl, { timeout: 10000, validateStatus: () => true });
    } catch (netErr) {
      writeClashLog('[startClash] /speedup network error: ' + netErr.message);
      throw new Error('下载加速器启动失败：无法连接订阅服务器（' + netErr.message + '），请检查网络。');
    }
    if (response.status >= 400) {
      const body = typeof response.data === 'string' ? response.data.slice(0, 200) : '';
      writeClashLog(`[startClash] /speedup HTTP ${response.status}: ${body}`);
      // 把服务端明文(订阅过期/流量用尽/Token不存在)透传给界面,不再只显示 "Request failed"
      const friendly = body.includes('Token 不存在') ? 'Token 不存在，请退出重新登录。'
        : body.includes('流量已用完') ? '高速流量已用完，请到流量商店购买。'
        : body.includes('已过期') ? '加速服务已过期，请到流量商店续费。'
        : ('订阅服务器返回 ' + response.status);
      throw new Error('下载加速器启动失败：' + friendly);
    }
    writeClashLog('[startClash] /speedup OK (' + String(response.data).length + ' bytes yaml)');
    
    // 动态修改 yaml 配置中的监听端口为 43289 (仅限根节点配置，避免破坏代理节点端口)
    let yamlContent = response.data;
    yamlContent = yamlContent.replace(/^mixed-port:\s*\d+/gm, 'mixed-port: 43289');
    yamlContent = yamlContent.replace(/^port:\s*\d+/gm, 'port: 43289');
    yamlContent = yamlContent.replace(/^socks-port:\s*\d+/gm, 'socks-port: 43290');

    if (!yamlContent.includes('mixed-port: 43289') && !yamlContent.includes('port: 43289')) {
      yamlContent = 'mixed-port: 43289\n' + yamlContent;
    }

    // 设置外部控制端口 43299 (用于连接优化和清除活跃连接)
    yamlContent = yamlContent.replace(/^external-controller:\s*.*/gm, '');
    yamlContent = 'external-controller: 127.0.0.1:43299\n' + yamlContent;

    // 强制设置 log-level 为 warning，减少大量管道日志刷屏降低 CPU/发热
    yamlContent = yamlContent.replace(/^log-level:\s*.*/gm, '');
    yamlContent = 'log-level: warning\n' + yamlContent;

    // 保持 load-balance 轮询负载均衡模式，发挥多节点多账号多线程并发加速能力
    // 优化健康检查参数：interval 设为 15s，max-failed-times 设为 1，快速自动剔除不通的故障节点
    yamlContent = yamlContent.replace(/max-failed-times:\s*\d+/g, 'max-failed-times: 1');
    yamlContent = yamlContent.replace(/interval:\s*\d+/g, 'interval: 15');
    // 健康检查超时 10s→3s + 开启 lazy:死/卡节点秒级懒摘除,不再被轮询喂给 axel(提升多线程下载速度)
    yamlContent = yamlContent.replace(/timeout:\s*10000/g, 'timeout: 3000');
    yamlContent = yamlContent.replace(/(type:\s*(?:load-balance|url-test|fallback))/g, '$1\n    lazy: true');

    // 过滤上游订阅混入的「流量信息假节点」(如 剩余流量/套餐到期/距离下次/官网地址 等伪装成代理的文本节点)
    // 它们会排到 proxies 列表最前,主策略组默认选中它们导致所有下载走假节点 → 502 Bad Gateway
    yamlContent = stripFakeProxyNodes(yamlContent);

    // 主策略组(select 手动组)改为 url-test 自动测速选优:
    // 默认 select 会固定选中列表第一个节点,一旦该节点故障则所有下载 502;改为 url-test 后自动挑选延迟最低的健康节点,
    // 配合已设置的 max-failed-times:1 / interval:15 / timeout:3000 快速剔除故障节点,保证下载始终走可用节点。
    yamlContent = yamlContent.replace(/^(\s*- name: 一分机场\n)(\s*type:)\s*select/gm, '$1$2 url-test');

    // 统计订阅配置中真实的节点数量
    const proxyMatches = yamlContent.match(/^\s*-\s*(?:\{\s*)?name\s*:/gm);
    if (proxyMatches && proxyMatches.length > 0) {
      currentRealNodeCount = proxyMatches.length;
    } else {
      currentRealNodeCount = 80;
    }
    console.log(`[Clash] 成功解析云端真实节点数量: ${currentRealNodeCount}`);

    // 保存 config.yaml 到用户工作空间
    const configPath = path.join(CLASH_WORK_DIR, 'config.yaml');
    fs.writeFileSync(configPath, yamlContent, 'utf8');

    const binaryPath = getClashBinaryPath();
    ensureExecutable(binaryPath);

    console.log(`Spawning Clash from ${binaryPath} with config at ${CLASH_WORK_DIR}`);
    writeClashLog('[startClash] spawning mihomo: ' + binaryPath);

    let spawnError = null;
    clashProcess = spawn(binaryPath, ['-d', CLASH_WORK_DIR]);

    clashProcess.on('error', (err) => {
      console.error('Clash spawn error:', err);
      writeClashLog('[startClash] spawn error: ' + err.message);
      spawnError = err;
    });

    clashProcess.stdout.on('data', (data) => {
      console.log(`[Clash stdout] ${data}`);
    });

    clashProcess.stderr.on('data', (data) => {
      console.error(`[Clash stderr] ${data}`);
    });

    clashProcess.on('close', (code) => {
      console.log(`Clash process exited with code ${code}`);
      writeClashLog(`[Clash] process exited code=${code}`);
      clashProcess = null;
    });

    // 延迟等待启动完成，并在此期间捕获可能发生的启动错误
    await new Promise((resolve, reject) => {
      const startTimeout = setTimeout(() => {
        if (spawnError) {
          reject(spawnError);
        } else {
          resolve();
        }
      }, 2000);

      clashProcess.once('error', (err) => {
        clearTimeout(startTimeout);
        reject(err);
      });
    });
    return true;
  } catch (err) {
    console.error('Failed to start Clash:', err.message);
    writeClashLog('[startClash] FAIL: ' + err.message);
    throw new Error('下载加速器启动失败: ' + err.message);
  }
}

function stopClash() {
  if (clashProcess) {
    console.log('Terminating Clash process...');
    writeClashLog('[stopClash] terminating mihomo');
    killProcess(clashProcess);
    clashProcess = null;
    writeClashLog('[stopClash] done');
  }
}

async function optimizeClash(token) {
  if (!token) {
    throw new Error('未检测到有效账户 Token，请注册登录后再试。');
  }

  try {
    console.log('Optimizing Clash connections for token:', token);
    const subUrl = `${BACKEND_BASE_URL}/speedup?token=${token}`;
    const response = await axios.get(subUrl, { timeout: 10000 });

    let yamlContent = response.data;
    yamlContent = yamlContent.replace(/^mixed-port:\s*\d+/gm, 'mixed-port: 43289');
    yamlContent = yamlContent.replace(/^port:\s*\d+/gm, 'port: 43289');
    yamlContent = yamlContent.replace(/^socks-port:\s*\d+/gm, 'socks-port: 43290');

    if (!yamlContent.includes('mixed-port: 43289') && !yamlContent.includes('port: 43289')) {
      yamlContent = 'mixed-port: 43289\n' + yamlContent;
    }

    yamlContent = yamlContent.replace(/^external-controller:\s*.*/gm, '');
    yamlContent = 'external-controller: 127.0.0.1:43299\n' + yamlContent;

    yamlContent = yamlContent.replace(/^log-level:\s*.*/gm, '');
    yamlContent = 'log-level: warning\n' + yamlContent;

    // 与 startClash 保持一致的健康检查调优(否则"优化网络通道"重载配置后会丢失这些加速设置)
    yamlContent = yamlContent.replace(/max-failed-times:\s*\d+/g, 'max-failed-times: 1');
    yamlContent = yamlContent.replace(/interval:\s*\d+/g, 'interval: 15');
    yamlContent = yamlContent.replace(/timeout:\s*10000/g, 'timeout: 3000');
    yamlContent = yamlContent.replace(/(type:\s*(?:load-balance|url-test|fallback))/g, '$1\n    lazy: true');

    // 过滤流量信息假节点(与 startClash 一致)
    yamlContent = stripFakeProxyNodes(yamlContent);

    // 主策略组改为 url-test 自动测速选优(与 startClash 一致)
    yamlContent = yamlContent.replace(/^(\s*- name: 一分机场\n)(\s*type:)\s*select/gm, '$1$2 url-test');

    const configPath = path.join(CLASH_WORK_DIR, 'config.yaml');
    fs.writeFileSync(configPath, yamlContent, 'utf8');

    // 如果加速器在运行中，关断所有连接池，强制客户端/Axel重设最佳连接流
    if (clashProcess) {
      try {
        await axios.put('http://127.0.0.1:43299/configs', { path: configPath }, { timeout: 3000 });
        await axios.delete('http://127.0.0.1:43299/connections', { timeout: 3000 });
        console.log('Successfully reloaded config and closed all Mihomo connections via REST API.');
      } catch (restErr) {
        console.log('Mihomo REST API call failed, gracefully restarting Clash process:', restErr.message);
        await stopClash();
        await startClash(token);
      }
    } else {
      await startClash(token);
    }

    return { success: true, message: '网络通道优化成功，已重新拉取配置并刷新网络通道！' };
  } catch (err) {
    console.error('Failed to optimize Clash connection:', err);
    throw new Error(err.message || '优化连接失败');
  }
}

// ==========================================
// 【大小校验工具模块】
// ==========================================
// 从直链 URL 提取干净的文件名:去掉查询参数(?...)与片段(#...)、URL 解码、清洗非法字符。
// 修复:此前直链直接用 link.substring(lastIndexOf('/')+1),会把 presigned URL 的 ?X-Amz-Signature=... 一并带入文件名,
// 在 Windows 上因 '?' 为非法字符导致下载失败,在 macOS 上也是脏文件名。
function fileNameFromUrl(url) {
  try {
    const noQuery = String(url).split('?')[0].split('#')[0];
    let name = noQuery.substring(noQuery.lastIndexOf('/') + 1);
    try { name = decodeURIComponent(name); } catch (e) { /* 解码失败则保留原样 */ }
    // 清洗跨平台非法字符,去掉首尾空白与开头的点
    name = name.replace(/[\\/:*?"<>|]/g, '_').trim().replace(/^\.+/, '');
    return name;
  } catch (e) {
    return '';
  }
}

// 清洗路径片段(文件名/目录名):去除各平台非法字符,作为保存路径的纵深防御,杜绝 Windows 下非法名崩溃
function sanitizePathSegment(seg) {
  if (seg === undefined || seg === null) return seg;
  return String(seg)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 200);
}

// 检测本地文件是否为误下的 HTML 错误页(前 512 字节含 <!doctype html / <html)
function looksLikeHtmlError(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(512);
    const n = fs.readSync(fd, buf, 0, 512, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, n).toString('utf8').trimStart().toLowerCase();
    return head.startsWith('<!doctype html') || head.startsWith('<html');
  } catch (e) {
    return false;
  }
}

// 识别"依赖浏览器会话、独立下载器拿不到"的 NCBI 动态导出链接(如 sviewer/viewer.cgi?...&query_key=)
function isSessionBoundNcbiLink(url) {
  return /\/s?viewer\/viewer\.cgi/i.test(String(url)) && /query_key=/i.test(String(url));
}

// 字节格式化(main 进程侧,用于 cURL 下载进度)
function fmtBytes(bytes) {
  bytes = bytes || 0;
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(2) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return bytes + ' B';
}

// ---------- 解析浏览器 "Copy as cURL" 命令(支持 bash 单引号 / cmd 双引号) ----------
function tokenizeCurl(s) {
  const tokens = [];
  let cur = '', quote = null, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === '\\' && s[i + 2] === "'" && s[i + 3] === "'") { cur += "'"; i += 4; continue; } // bash 内嵌单引号 '\''
        quote = null; i++; continue;
      }
      cur += c; i++; continue; // 单引号内其余皆字面(含反斜杠)
    }
    if (quote === '"') {
      if (c === '\\') { const n = s[i + 1]; if (n === undefined) { cur += c; i++; continue; } cur += n; i += 2; continue; }
      if (c === '"') { quote = null; i++; continue; }
      cur += c; i++; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { if (cur) { tokens.push(cur); cur = ''; } i++; continue; }
    if (c === "'" || c === '"') { quote = c; i++; continue; }
    if (c === '\\') { const n = s[i + 1]; if (n !== undefined) { cur += n; i += 2; continue; } }
    cur += c; i++;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parseCurlCommand(text) {
  const tokens = tokenizeCurl(String(text || '').trim());
  if (!tokens.length || !/curl(\.exe)?$/i.test(tokens[0])) {
    throw new Error('不是有效的 curl 命令(应以 curl 开头)');
  }
  let url = null, method = null, cookie = null, data = null;
  const headers = [];
  const addHeader = (h) => { const idx = h.indexOf(':'); if (idx > 0) headers.push({ name: h.slice(0, idx).trim(), value: h.slice(idx + 1).trim() }); };
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    const next = () => tokens[++i];
    if (t === '-H' || t === '--header') { addHeader(next() || ''); }
    else if (t === '-b' || t === '--cookie') { const v = next() || ''; cookie = cookie ? cookie + '; ' + v : v; }
    else if (t === '-X' || t === '--request') { method = (next() || '').toUpperCase(); }
    else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary' || t === '--data-urlencode') { const v = next() || ''; data = data ? data + '&' + v : v; if (!method) method = 'POST'; }
    else if (t === '-A' || t === '--user-agent') { headers.push({ name: 'User-Agent', value: next() || '' }); }
    else if (t === '-e' || t === '--referer') { headers.push({ name: 'Referer', value: next() || '' }); }
    else if (t === '-L' || t === '--location') { /* 跟随重定向(下载时默认开启) */ }
    else if (t === '-o' || t === '--output') { next(); /* 输出名由本工具决定 */ }
    else if (t === '--compressed' || t === '-s' || t === '-S' || t === '-k' || t === '--insecure' || t === '-f' || t === '--fail' || t === '-#' || t === '--progress-bar' || t === '-O' || t === '--remote-name' || t === '-sS') { /* 忽略 */ }
    else if (typeof t === 'string' && t.startsWith('--') && t.includes('=')) { /* --key=val 忽略 */ }
    else if (typeof t === 'string' && !t.startsWith('-') && url === null) { url = t; }
    i++;
  }
  if (!url) throw new Error('未解析到下载 URL');
  try { new URL(url); } catch (e) { throw new Error('URL 格式无效: ' + url); }
  return { url, method: method || 'GET', headers, cookie: cookie || '', data: data || null };
}

async function headRequestSize(url) {
  const tryGetSizeFromHeaders = (headers) => {
    if (!headers) return 0;
    // 优先 content-range(Range 请求会带 /总大小,content-length 此时只是分段长度,如 2B)
    if (headers['content-range']) {
      const match = headers['content-range'].match(/\/(\d+)$/);
      if (match) {
        const len = parseInt(match[1], 10);
        if (!isNaN(len) && len > 0) return len;
      }
    }
    if (headers['content-length']) {
      const len = parseInt(headers['content-length'], 10);
      if (!isNaN(len) && len > 0) return len;
    }
    return 0;
  };

  // 校验大小只需极小的 HEAD / Range 请求, 直连通常远快于绕代理(代理走单节点延迟高,实测 4.7s vs 直连 0.9s)。
  // 因此顺序: 直连优先 → 代理兜底(加速器开启时, 若直连被墙/失败才走代理)。
  const directOptions = { timeout: 10000, maxRedirects: 5 };            // 无 proxy = 直连
  const proxyOptions = { timeout: 10000, maxRedirects: 5,
    proxy: clashProcess ? { protocol: 'http', host: '127.0.0.1', port: 43289 } : false };

  // ---- 直连路径 ----
  // 1. 直连 HEAD
  try {
    const response = await axios.head(url, directOptions);
    const sz = tryGetSizeFromHeaders(response.headers);
    if (sz > 0) return sz;
  } catch (e) {}
  // 2. 直连轻量 Range GET (破除 CDN 重定向 / chunked)
  try {
    const res = await axios.get(url, { ...directOptions, headers: { Range: 'bytes=0-1' }, timeout: 12000 });
    const sz = tryGetSizeFromHeaders(res.headers);
    if (sz > 0) return sz;
  } catch (e) {
    if (e.response && e.response.headers) {
      const sz = tryGetSizeFromHeaders(e.response.headers);
      if (sz > 0) return sz;
    }
  }

  // ---- 代理兜底路径 (直连失败/被墙时) ----
  // 3. 代理 HEAD
  try {
    const response = await axios.head(url, proxyOptions);
    const sz = tryGetSizeFromHeaders(response.headers);
    if (sz > 0) return sz;
  } catch (e) {}
  // 4. 代理轻量 Range GET
  try {
    const res = await axios.get(url, { ...proxyOptions, headers: { Range: 'bytes=0-1' }, timeout: 12000 });
    const sz = tryGetSizeFromHeaders(res.headers);
    if (sz > 0) return sz;
  } catch (e) {
    if (e.response && e.response.headers) {
      const sz = tryGetSizeFromHeaders(e.response.headers);
      if (sz > 0) return sz;
    }
  }

  return 0;
}

// ==========================================
// 【IPC 通信总线】
// ==========================================

// --- 系统设置 ---
ipcMain.handle('get-settings', () => getSettings());
ipcMain.handle('save-settings', (event, data) => saveSettings(data));
ipcMain.handle('get-backend-url', () => BACKEND_BASE_URL);

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// --- 用户与支付 ---
ipcMain.handle('api-register', async (event, { username, password, email, inviteCode }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/register`, { username, password, email, inviteCode, source: 'desktop' });
  return res.data;
});

ipcMain.handle('api-login', async (event, { username, password }) => {
  try {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/login`, { username, password, source: 'desktop' }, { timeout: 10000 });
    return res.data;
  } catch (err) {
    if (err.response && err.response.data) {
      return err.response.data;
    }
    return { error: `连接服务器失败: ${err.message}` };
  }
});

ipcMain.handle('api-get-user-info', async (event, { token }) => {
  const res = await axios.get(`${BACKEND_BASE_URL}/api/user/info?token=${token}&version=${app.getVersion()}`);
  return res.data;
});

ipcMain.handle('api-request-email-bind-code', async (event, { token, email }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/user/email/request-code`, { token, email });
  return res.data;
});

ipcMain.handle('api-confirm-email-bind', async (event, { token, email, code }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/user/email/confirm`, { token, email, code });
  return res.data;
});

ipcMain.handle('api-request-password-reset', async (event, { email }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/password-reset/request`, { email });
  return res.data;
});

ipcMain.handle('api-confirm-password-reset', async (event, { email, code, newPassword }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/password-reset/confirm`, { email, code, newPassword });
  return res.data;
});

ipcMain.handle('api-get-packages', async () => {
  const res = await axios.get(`${BACKEND_BASE_URL}/api/pay/packages`);
  return res.data;
});

ipcMain.handle('api-create-order', async (event, { token, packageId, payType, quantity }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/pay/create`, { token, packageId, payType, quantity });
  return res.data;
});

ipcMain.handle('api-checkin', async (event, { token }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/user/checkin`, { token });
  return res.data;
});

ipcMain.handle('api-balance-recharge', async (event, { token, amount }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/balance/recharge`, { token, amount });
  return res.data;
});

ipcMain.handle('api-get-orders', async (event, { token }) => {
  const res = await axios.get(`${BACKEND_BASE_URL}/api/user/orders?token=${encodeURIComponent(token)}`);
  return res.data;
});

ipcMain.handle('api-get-devices', async (event, { token }) => {
  const res = await axios.get(`${BACKEND_BASE_URL}/api/user/device?token=${encodeURIComponent(token)}`);
  return res.data;
});

ipcMain.handle('api-get-login-log', async (event, { token }) => {
  const res = await axios.get(`${BACKEND_BASE_URL}/api/user/login-log?token=${encodeURIComponent(token)}`);
  return res.data;
});

ipcMain.handle('api-reset-token', async (event, { token }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/user/token/reset`, { token });
  return res.data;
});

ipcMain.handle('api-report-device', async (event, { token, deviceId, deviceName }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/user/device`, { token, deviceId, deviceName });
  return res.data;
});

ipcMain.handle('api-invite-copy', async (event, { token }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/user/invite/copy`, { token });
  return res.data;
});

// --- Clash 控制 ---
ipcMain.handle('clash-start', async (event, { token }) => {
  await startClash(token);
  setExtractionProxy();
  return { success: true, nodeCount: currentRealNodeCount };
});

ipcMain.handle('clash-stop', () => {
  stopClash();
  setExtractionProxy();
  return true;
});

ipcMain.handle('clash-optimize', async (event, { token }) => {
  const res = await optimizeClash(token);
  return { ...res, nodeCount: currentRealNodeCount };
});

ipcMain.handle('clash-get-node-count', () => {
  return currentRealNodeCount || 80;
});

// 过滤上游订阅混入的「流量信息假节点」: 部分机场(如一分机场)会在 proxies 里插入
// name=剩余流量/套餐到期/距离下次重置/官网地址/套餐订阅已过期 等伪装成代理节点的文本,
// 它们排在 proxies 列表最前, 主策略组默认选中 → 所有下载流量走假节点 → 502 Bad Gateway。
// 做法: 用正则删除这些假节点的整个配置块, 并剔除策略组中对它们的引用行。
function stripFakeProxyNodes(yamlContent) {
  const FAKE_NAME_PATTERN = /剩余流量|套餐到期|距离下次|官网地址|套餐订阅已过期|请去官网/;
  const lines = yamlContent.split('\n');
  const out = [];
  let inFakeBlock = false;
  let fakeNames = new Set();

  for (const line of lines) {
    // 检测 proxies 区新节点的开始
    const nodeStart = line.match(/^\s*-\s*(?:\{\s*)?name:\s*(.+?)\s*$/);
    if (nodeStart) {
      const nodeName = nodeStart[1].trim().replace(/^["']|["']$/g, '');
      if (FAKE_NAME_PATTERN.test(nodeName)) {
        inFakeBlock = true;
        fakeNames.add(nodeName);
        continue; // 跳过假节点的 name 行
      } else {
        inFakeBlock = false;
        out.push(line);
        continue;
      }
    }
    if (inFakeBlock) {
      // 遇到 proxy-groups: 说明 proxies 区结束, 退出假节点块状态
      if (/^\s*proxy-groups:\s*$/.test(line)) {
        inFakeBlock = false;
        out.push(line);
        continue;
      }
      continue; // 跳过假节点块的属性行
    }
    // 剔除策略组中引用假节点的行(如 "  - 剩余流量：4.87 TB")
    if (/^\s*-\s*.+$/.test(line)) {
      const refName = line.replace(/^\s*-\s*/, '').trim().replace(/^["']|["']$/g, '');
      if (fakeNames.has(refName) || FAKE_NAME_PATTERN.test(refName)) {
        continue; // 跳过对假节点的引用
      }
    }
    out.push(line);
  }

  return out.join('\n');
}

// 判断某 URL 是否应走 clash 代理:境外(如 github.com、国外数据源)→ true;境内/后端主机 → false(直连)。
// 修复"更新/热更新下载慢":此前对境内后端的请求也绕 clash 代理(甚至可能被路由到境外节点),改为境内直连。
function shouldUseProxy(urlStr) {
  try {
    const host = new URL(urlStr).hostname.toLowerCase();
    // 后端主机(境内)→ 直连
    try {
      if (host === new URL(BACKEND_BASE_URL).hostname.toLowerCase()) return false;
    } catch (e) {}
    // 境内域名后缀 → 直连
    if (/\.(cn|com\.cn|net\.cn|org\.cn|gov\.cn|edu\.cn)$/.test(host)) return false;
    // 常见境内域名 → 直连
    const domestic = ['aliyun.com', 'aliyuncs.com', 'qcloud.com', 'myqcloud.com', 'baidu.com', 'bdstatic.com',
      'qq.com', 'weixin.qq.com', '163.com', '126.com', 'jd.com', 'taobao.com', 'tmall.com', 'bilibili.com',
      'zhihu.com', 'gitee.com', 'yuque.com', 'meituan.com', 'douban.com', 'weibo.com'];
    if (domestic.some((d) => host === d || host.endsWith('.' + d))) return false;
    return true; // 其余(github.com、国外 CDN/数据源等)→ 走代理
  } catch (e) {
    return false; // 解析失败保守直连
  }
}

// 返回某 URL 对应的 axios 代理配置:走代理则返回代理对象;否则返回 false(强制直连,忽略系统代理)
function axiosProxyFor(urlStr) {
  if (clashProcess && shouldUseProxy(urlStr)) {
    return { protocol: 'http', host: '127.0.0.1', port: 43289 };
  }
  return false;
}

async function applyHotPatch(patchUrl) {
  if (!patchUrl) {
    throw new Error('未提供有效热更新补丁地址');
  }

  // 1) 同源校验:补丁只允许来自官方后端,杜绝被指向任意外部主机
  const fullUrl = patchUrl.startsWith('http') ? patchUrl : `${BACKEND_BASE_URL}${patchUrl}`;
  if (!isSameOrigin(fullUrl)) {
    throw new Error('补丁地址不受信任(必须来自官方后端),已拒绝。');
  }

  // 2) 从官方后端拉取可信清单(sha256 + 签名),不信任渲染进程传入的任何校验值
  let manifest = null;
  try {
    // 通道隔离:预览补丁(含 -preview)取 P2 清单校验;2.x 补丁取 2.x 清单;否则取 1.x
    const pm = String(patchUrl).match(/patch-(\d+)\./);
    let verifyChannel = pm && parseInt(pm[1], 10) >= 2 ? 2 : 1;
    if (/preview/i.test(patchUrl)) verifyChannel = 'P2';
    const mres = await axios.get(`${BACKEND_BASE_URL}/api/client/version?channel=${verifyChannel}`, { timeout: 8000, proxy: axiosProxyFor(`${BACKEND_BASE_URL}/api/client/version`) });
    manifest = mres.data || null;
  } catch (e) {
    throw new Error('无法获取更新清单,热更新中止:' + e.message);
  }
  if (!manifest || !manifest.sha256 || !manifest.signature) {
    throw new Error('更新清单缺少签名信息,为安全起见中止热更新。');
  }

  // 3) 下载补丁
  const tempPatchPath = path.join(app.getPath('userData'), 'patch_download.tmp');
  console.log('Downloading hot patch from:', fullUrl);
  const response = await axios({ url: fullUrl, method: 'GET', responseType: 'stream', timeout: 30000, proxy: axiosProxyFor(fullUrl) });
  const writer = fs.createWriteStream(tempPatchPath);
  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const stat = fs.statSync(tempPatchPath);
  if (stat.size < 500) {
    try { fs.unlinkSync(tempPatchPath); } catch(e){}
    throw new Error('下载的热更新补丁损坏或无效 (文件过小)');
  }

  // 4) 验签:sha256 + Ed25519 签名都必须通过,否则中止(保留当前版本)
  if (!verifyPatchFile(tempPatchPath, manifest.sha256, manifest.signature)) {
    try { fs.unlinkSync(tempPatchPath); } catch(e){}
    throw new Error('热更新补丁未通过签名校验,可能已被篡改,已拒绝应用。');
  }
  console.log('[HotPatch] 补丁签名校验通过');

  // 5) 替换 app.asar(失败则连清单一起暂存 update.asar,下次启动二次校验后应用)
  const targetAsar = path.join(process.resourcesPath, 'app.asar');
  let successDirect = false;

  try {
    if (fs.existsSync(targetAsar)) {
      const backupAsar = path.join(process.resourcesPath, 'app.asar.old');
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
      fs.renameSync(targetAsar, backupAsar);
      fs.renameSync(tempPatchPath, targetAsar);
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
      successDirect = true;
    }
  } catch (err) {
    console.warn('Direct replace app.asar failed, staging update.asar for next launch:', err.message);
    const updateAsar = path.join(process.resourcesPath, 'update.asar');
    fs.copyFileSync(tempPatchPath, updateAsar);
    try {
      fs.writeFileSync(updateAsar + '.manifest', JSON.stringify({ sha256: manifest.sha256, signature: manifest.signature }));
    } catch(e){}
    try { fs.unlinkSync(tempPatchPath); } catch(e){}
  }

  return { success: true, direct: successDirect, message: '代码热更新补丁已就绪！应用即将重启...' };
}

ipcMain.handle('apply-hot-patch', async (event, { patchUrl }) => {
  const res = await applyHotPatch(patchUrl);
  setTimeout(() => {
    app.relaunch();
    app.exit(0);
  }, 1200);
  return res;
});

// --- 自动更新与外部链接 ---
ipcMain.handle('check-for-updates', async (event, { advancedMode } = {}) => {
  try {
    const currentVersion = app.getVersion();
    // 【通道隔离】按主版本号请求各自通道:1.x → channel=1,2.x → channel=2。
    // 高级模式(advancedMode)额外请求 channel=P2(Preview 预览版独立通道),用于"稳定版 + 预览版"双选。
    const major = parseInt(String(currentVersion).split('.')[0], 10) || 1;
    const versionUrl = `${BACKEND_BASE_URL}/api/client/version?channel=${major}`;
    // 后端是境内服务 → 直连(axiosProxyFor 对境内返回 false,强制直连并忽略系统代理),避免绕代理变慢
    const res = await axios.get(versionUrl, { timeout: 6000, proxy: axiosProxyFor(versionUrl) });
    const latestVersion = res.data.version || currentVersion;

    // semver 比较:仅当服务端版本严格高于本地时才提示更新(防止被回滚/降级覆盖)
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;

    // 最低支持版本开关:用于未来"集中弃用旧版本"(当前设得很低,不强制任何旧版本)
    const minClientVersion = res.data.minClientVersion || '1.0.0';
    const forceUpdate = compareVersions(currentVersion, minClientVersion) < 0;

    // 2.x 升级桥接(可选):1.x 清单若含 upgrade2x 且可热更新,则在常规更新之后额外展示"升级到 2.x"卡片
    let upgrade2x = null;
    const u = res.data.upgrade2x;
    if (major === 1 && u && u.version && u.patchUrl && u.hotUpdatable !== false) {
      upgrade2x = {
        version: u.version,
        releaseNotes: u.releaseNotes || '',
        patchUrl: String(u.patchUrl).startsWith('http') ? u.patchUrl : `${BACKEND_BASE_URL}${u.patchUrl}`
      };
    }

    // 【Preview 预览版】请求 P2 独立清单的条件:
    //   - 高级模式(advancedMode)开启:正式版用户也能看到预览版(双选)
    //   - 当前客户端本身是预览版(版本含 -preview):自动跟随预览版通道(无需手动开高级模式)
    // 正式版客户端未开高级模式 → 不请求 P2,预览版更新对其完全不可见(不污染正式版)
    const isPreviewClient = /preview/i.test(String(currentVersion));
    let preview = null;
    if (advancedMode || isPreviewClient) {
      try {
        const pUrl = `${BACKEND_BASE_URL}/api/client/version?channel=P2`;
        const pRes = await axios.get(pUrl, { timeout: 6000, proxy: axiosProxyFor(pUrl) });
        const pv = pRes.data && pRes.data.version;
        if (pv) {
          preview = {
            version: pv,
            releaseNotes: pRes.data.releaseNotes || '',
            patchUrl: pRes.data.patchUrl ? (pRes.data.patchUrl.startsWith('http') ? pRes.data.patchUrl : `${BACKEND_BASE_URL}${pRes.data.patchUrl}`) : null,
            winUrl: pRes.data.winUrl ? `${BACKEND_BASE_URL}${pRes.data.winUrl}` : null,
            macUrl: pRes.data.macUrl ? `${BACKEND_BASE_URL}${pRes.data.macUrl}` : null,
            // 预览版有更新(版本高于当前)则提示
            hasUpdate: compareVersions(pv, currentVersion) > 0
          };
        }
      } catch (e) {
        console.error('Check preview updates failed:', e.message);
      }
    }

    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      forceUpdate,
      minClientVersion,
      isPreviewClient,
      patchUrl: res.data.patchUrl ? (res.data.patchUrl.startsWith('http') ? res.data.patchUrl : `${BACKEND_BASE_URL}${res.data.patchUrl}`) : null,
      winUrl: res.data.winUrl ? `${BACKEND_BASE_URL}${res.data.winUrl}` : null,
      macUrl: res.data.macUrl ? `${BACKEND_BASE_URL}${res.data.macUrl}` : null,
      releaseNotes: res.data.releaseNotes,
      upgrade2x,
      preview
    };
  } catch (err) {
    console.error('Check for updates failed:', err.message);
    return {
      success: false,
      message: err.message,
      currentVersion: app.getVersion()
    };
  }
});

ipcMain.handle('open-external-url', async (event, { url }) => {
  try {
    await shell.openExternal(url);
    return { success: true };
  } catch (err) {
    console.error('Failed to open external url:', err.message);
    return { success: false, message: err.message };
  }
});

ipcMain.handle('open-speedtest-page', async () => {
  const speedtestWindow = new BrowserWindow({
    width: 900,
    height: 620,
    title: 'Speed Test - BioDownloader',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true
    }
  });
  speedtestWindow.loadFile('speedtest.html');
  return { success: true };
});

ipcMain.handle('speedtest-network', async (event, { url, timeoutMs = 10000 }) => {
  console.log('[Speedtest] 开始网络基准测速:', { url, timeoutMs });
  return new Promise((resolve) => {
    const https = require('https');
    const http = require('http');
    const client = url.startsWith('https') ? https : http;
    const sender = event.sender || mainWindow;

    const startTime = Date.now();
    let receivedBytes = 0;

    const req = client.get(url, { timeout: timeoutMs }, (res) => {
      const contentLength = parseInt(res.headers['content-length'] || '0', 10);
      const totalBytes = contentLength > 0 ? contentLength : 10 * 1024 * 1024;

      res.on('data', (chunk) => {
        receivedBytes += chunk.length;
        const elapsed = (Date.now() - startTime) / 1000;
        if (elapsed > 0 && sender && !sender.isDestroyed()) {
          sender.send('speedtest-progress', {
            bytesPerSecond: receivedBytes / elapsed,
            bytesReceived: receivedBytes,
            elapsedSeconds: elapsed,
            totalBytes: totalBytes
          });
        }
      });

      res.on('end', () => {
        const elapsed = (Date.now() - startTime) / 1000;
        if (receivedBytes > 0 && elapsed > 0) {
          resolve({
            success: true,
            bytesPerSecond: receivedBytes / elapsed,
            elapsedSeconds: elapsed,
            bytesReceived: receivedBytes
          });
        } else {
          resolve({ success: false, error: '未收到数据' });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ success: false, error: '下载失败: ' + err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      const elapsed = (Date.now() - startTime) / 1000;
      if (receivedBytes > 0 && elapsed > 0) {
        resolve({
          success: true,
          bytesPerSecond: receivedBytes / elapsed,
          elapsedSeconds: elapsed,
          bytesReceived: receivedBytes
        });
      } else {
        resolve({ success: false, error: '测速超时' });
      }
    });
  });
});

ipcMain.handle('speedtest-downloader', async (event, { url, expectedSizeMB = 50, timeoutMs = 10000 }) => {
  console.log('[Speedtest] 开始下载器测速:', { url, expectedSizeMB, timeoutMs });
  return new Promise((resolve) => {
    const axelBin = getAxelBinaryPath();
    const tmpDir = path.join(app.getPath('temp'), 'biodl-speedtest');
    const timestamp = Date.now();
    const savePath = path.join(tmpDir, 'speedtest_' + timestamp + '.bin');

    try {
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    } catch (e) {
      return resolve({ success: false, error: '无法创建临时目录: ' + e.message });
    }

    // 与正式下载一致:境外目标走 clash 代理,境内目标直连
    const env = { ...process.env };
    if (clashProcess && shouldUseProxy(url)) {
      env.http_proxy = 'http://127.0.0.1:43289';
      env.https_proxy = 'http://127.0.0.1:43289';
      env.all_proxy = 'http://127.0.0.1:43289';
    } else {
      delete env.http_proxy; delete env.https_proxy; delete env.all_proxy;
      delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.ALL_PROXY;
    }

    const args = ['-n', '16', '-k', '-o', savePath, url];
    const proc = spawn(axelBin, args, { env });
    let lastBytesReceived = 0;
    let startTime = Date.now();
    const maxBytes = expectedSizeMB * 1024 * 1024;
    let resolved = false;
    let stderrText = '';
    proc.stderr.on('data', (d) => { try { stderrText += d.toString(); } catch (e) {} });

    const timer = setTimeout(() => {
      killProcess(proc);
      const elapsed = (Date.now() - startTime) / 1000;
      if (!resolved) {
        resolved = true;
        if (lastBytesReceived > 0 && elapsed > 0) {
          resolve({ success: true, bytesPerSecond: lastBytesReceived / elapsed, elapsedSeconds: elapsed, bytesReceived: lastBytesReceived });
        } else {
          resolve({ success: false, error: '测速超时，未收到数据' });
        }
      }
      cleanup();
    }, timeoutMs);

    // 基于文件实际大小的定时采样: 不依赖 axel stdout 正则(其输出常被拆成不含百分比的小块, 正则匹配不到)
    let lastSampleTime = startTime;
    let lastSampleBytes = 0;
    const sampleTimer = setInterval(() => {
      try {
        if (!fs.existsSync(savePath)) return;
        const st = fs.statSync(savePath);
        if (st.size > 0) lastBytesReceived = st.size;
        const now = Date.now();
        const dt = (now - lastSampleTime) / 1000;
        const db = st.size - lastSampleBytes;
        if (dt > 0) {
          lastSampleTime = now;
          lastSampleBytes = st.size;
          const instBps = db / dt;
          const sender = event.sender || mainWindow;
          if (sender && !sender.isDestroyed()) {
            sender.send('speedtest-progress', {
              bytesPerSecond: instBps,
              bytesReceived: st.size,
              elapsedSeconds: (now - startTime) / 1000,
              totalBytes: maxBytes
            });
          }
          if (st.size >= maxBytes) {
            clearTimeout(timer);
            clearInterval(sampleTimer);
            killProcess(proc);
            const elapsed = (now - startTime) / 1000;
            if (!resolved) {
              resolved = true;
              resolve({ success: true, bytesPerSecond: st.size / elapsed, elapsedSeconds: elapsed, bytesReceived: st.size });
            }
            cleanup();
          }
        }
      } catch (e) {}
    }, 500);

    function cleanup() {
      clearTimeout(timer);
      clearInterval(sampleTimer);
      try { if (fs.existsSync(savePath)) fs.unlinkSync(savePath); } catch (e) {}
      try { if (fs.existsSync(tmpDir) && fs.readdirSync(tmpDir).length === 0) fs.rmdirSync(tmpDir); } catch (e) {}
    }

    proc.on('error', (err) => {
      clearTimeout(timer);
      cleanup();
      resolve({ success: false, error: '进程启动失败: ' + err.message });
    });

    proc.stdout.on('data', (data) => {
      const output = data.toString();
      const speedMatch = output.match(/\[\s*\d+%\][\s]*([\d.]+)\s*(KB|MB|GB|TB|B)\/s/i);
      if (speedMatch) {
        const value = parseFloat(speedMatch[1]);
        const unit = speedMatch[2].toUpperCase();
        const multipliers = { B: 1, KB: 1024, MB: 1024 * 1024, GB: 1024 * 1024 * 1024, TB: 1024 * 1024 * 1024 * 1024 };
        const speedBps = value * (multipliers[unit] || 1);
        try {
          if (fs.existsSync(savePath)) {
            const stat = fs.statSync(savePath);
            lastBytesReceived = stat.size;
            const sender = event.sender || mainWindow;
            if (sender && !sender.isDestroyed()) {
              sender.send('speedtest-progress', {
                bytesPerSecond: speedBps,
                bytesReceived: lastBytesReceived,
                elapsedSeconds: (Date.now() - startTime) / 1000,
                totalBytes: maxBytes
              });
            }
            if (lastBytesReceived >= maxBytes) {
              clearTimeout(timer);
              killProcess(proc);
              const elapsed = (Date.now() - startTime) / 1000;
              if (!resolved) {
                resolved = true;
                resolve({ success: true, bytesPerSecond: lastBytesReceived / elapsed, elapsedSeconds: elapsed, bytesReceived: lastBytesReceived });
              }
              cleanup();
            }
          }
        } catch (e) {}
      }
    });

    proc.on('close', (code) => {
      const elapsed = (Date.now() - startTime) / 1000;
      // 若 close 时 lastBytesReceived 仍为 0(文件下载过快,stdout 事件尚未触发),直接从磁盘读取实际大小
      let actualBytes = lastBytesReceived;
      if (actualBytes <= 0) {
        try {
          if (fs.existsSync(savePath)) {
            const st = fs.statSync(savePath);
            if (st.size > 0) actualBytes = st.size;
          }
        } catch (e) {}
      }
      if (!resolved) {
        resolved = true;
        if (actualBytes > 0 && elapsed > 0) {
          resolve({ success: true, bytesPerSecond: actualBytes / elapsed, elapsedSeconds: elapsed, bytesReceived: actualBytes });
        } else {
          // 提取 axel 的真实报错(如 ERROR 502/403/连接失败),并提示加速器可能未开启或节点不可用
          let detail = stderrText.trim().split('\n').slice(0, 2).join(' ');
          const proxyHint = '（请确认加速器已开启且节点可用）';
          if (!detail) detail = '未知错误';
          resolve({ success: false, error: '下载失败: ' + detail + proxyHint });
        }
      }
      cleanup();
    });
  });
});

ipcMain.handle('download-app-update', async (event, { url, fileName }) => {
  const downloadsDir = app.getPath('downloads');
  const savePath = path.join(downloadsDir, fileName);

  // 清除旧文件或残余断点信息
  if (fs.existsSync(savePath)) {
    try { fs.unlinkSync(savePath); } catch(e) {}
  }
  if (fs.existsSync(savePath + '.st')) {
    try { fs.unlinkSync(savePath + '.st'); } catch(e) {}
  }

  // 区分平台二进制路径
  let axelBin = path.join(BIN_DIR, 'darwin', 'axel');
  if (process.platform === 'win32') {
    axelBin = path.join(BIN_DIR, 'win32', 'axel.exe');
  }

  // 按目标主机决定代理:境内后端 → 直连(清除代理变量);境外(如 github)→ 走 clash 代理
  const env = { ...process.env };
  if (clashProcess && shouldUseProxy(url)) {
    env.http_proxy = 'http://127.0.0.1:43289';
    env.https_proxy = 'http://127.0.0.1:43289';
    env.all_proxy = 'http://127.0.0.1:43289';
  } else {
    delete env.http_proxy; delete env.https_proxy; delete env.all_proxy;
    delete env.HTTP_PROXY; delete env.HTTPS_PROXY; delete env.ALL_PROXY;
  }

  const args = ['-n', '16', '-T', '20', '-U', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', '-k', '-o', savePath, url];
  console.log(`Running Axel for Update: ${axelBin} ${args.join(' ')}`);

  return new Promise((resolve, reject) => {
    const updateAxel = spawn(axelBin, args, { env });

    updateAxel.stdout.on('data', (data) => {
      const output = data.toString();
      const pctMatch = output.match(/\[\s*(\d+)%\]/);
      const speedMatch = output.match(/\[\s*([\d\.]+\s*[KMGT]*B\/s)\]/);

      let percentage = pctMatch ? parseInt(pctMatch[1]) : null;
      let speed = speedMatch ? speedMatch[1] : null;

      if (percentage !== null || speed !== null) {
        mainWindow.webContents.send('update-progress', { percentage, speed });
      }
    });

    updateAxel.on('error', (err) => {
      reject(err);
    });

    updateAxel.on('close', (code) => {
      if (code === 0) {
        // 打开下载目录并选中该文件
        shell.showItemInFolder(savePath);
        resolve({ success: true, savePath });
      } else {
        reject(new Error(`退出状态码: ${code}`));
      }
    });
  });
});

ipcMain.handle('clash-status', () => {
  return clashProcess !== null;
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// --- 文件大小检验 ---
ipcMain.handle('check-download-size', async (event, { type, inputVal }) => {
  const ids = inputVal.split(/[\s,\n;]+/).map(x => x.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('请输入正确的编号或链接');
  }

  const files = [];
  
  if (type === 'sra_raw') {
    const promises = ids.map(async (acc) => {
      const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
      const size = await headRequestSize(url);
      return { name: acc, url, size };
    });
    const results = await Promise.all(promises);
    files.push(...results);
  } else if (type === 'ebi_raw') {
    const promises = ids.map(async (acc) => {
      try {
        const enaUrl = `https://www.ebi.ac.uk/ena/portal/api/filereport?accession=${acc}&result=read_run&fields=fastq_ftp&format=json`;
        let res;
        try {
          res = await axios.get(enaUrl, {
            timeout: 15000,
            proxy: { protocol: 'http', host: '127.0.0.1', port: 43289 }
          });
        } catch (proxyErr) {
          console.warn(`Failed to fetch EBI via proxy: ${proxyErr.message}, falling back to direct connection`);
          res = await axios.get(enaUrl, { timeout: 10000 });
        }
        if (res.data && res.data[0] && res.data[0].fastq_ftp) {
          const urls = res.data[0].fastq_ftp.split(';');
          const subPromises = urls.map(async (u) => {
            const cleanUrl = u.startsWith('http') ? u : 'https://' + u;
            const size = await headRequestSize(cleanUrl);
            const fname = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1);
            return { name: fname, url: cleanUrl, size, folder: acc };
          });
          return await Promise.all(subPromises);
        } else {
          // 回退 AWS SRA
          const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
          const size = await headRequestSize(url);
          return [{ name: acc, url, size }];
        }
      } catch (e) {
        // 回退 AWS SRA
        const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
        const size = await headRequestSize(url);
        return [{ name: acc, url, size }];
      }
    });
    const results = await Promise.all(promises);
    results.forEach(subList => files.push(...subList));
  } else if (type === 'geo_suppl') {
    for (const acc of ids) {
      try {
        const match = acc.match(/(\d+)/);
        if (!match) continue;
        const numPart = match[1];
        const stubNum = numPart.length <= 3 ? 'nnn' : numPart.slice(0, -3) + 'nnn';
        const stub = acc.replace(numPart, stubNum);
        const geoUrl = `https://ftp.ncbi.nlm.nih.gov/geo/series/${stub}/${acc}/suppl/`;

        // 请求页面并解析链接 (优先走加速代理，失败则回退直连)
        let res;
        try {
          res = await axios.get(geoUrl, {
            timeout: 15000,
            proxy: { protocol: 'http', host: '127.0.0.1', port: 43289 }
          });
        } catch (proxyErr) {
          console.warn(`Failed to fetch GEO page via proxy: ${proxyErr.message}, falling back to direct connection`);
          res = await axios.get(geoUrl, { timeout: 12000 });
        }
        const $ = cheerio.load(res.data);
        const links = $('a');
        const candidateLinks = [];

        for (let i = 0; i < links.length; i++) {
          const href = $(links[i]).attr('href');
          if (href && !href.startsWith('/') && !href.startsWith('?') && href.toLowerCase() !== 'filelist.txt') {
            // 过滤外链与协议前缀，只解析该目录下的相对路径文件
            if (href.includes('://') || href.startsWith('http') || href.startsWith('ftp') || href.startsWith('mailto')) {
              continue;
            }
            const fileUrl = new URL(href, geoUrl).href;
            candidateLinks.push({ name: href, url: fileUrl });
          }
        }

        if (candidateLinks.length === 0) {
          throw new Error(`[${acc}] 页面上未发现可下载的补充文件`);
        }

        // 并行校验该系列号下的全部补充文件体积
        const sizePromises = candidateLinks.map(async (link) => {
          const size = await headRequestSize(link.url);
          return { name: link.name, url: link.url, size, folder: acc };
        });
        const resolvedFiles = await Promise.all(sizePromises);
        files.push(...resolvedFiles);
      } catch (err) {
        throw new Error(`获取 GEO ${acc} 页面失败: ` + err.message);
      }
    }
  } else if (type === 'zenodo') {
    for (const rawId of ids) {
      try {
        const match = rawId.match(/(?:records?\/|zenodo\.|\b)(\d+)\b/i);
        if (!match) {
          throw new Error(`无法识别 Zenodo 记录编号: ${rawId}`);
        }
        const recordId = match[1];
        const apiUrl = `https://zenodo.org/api/records/${recordId}`;

        let res;
        try {
          res = await axios.get(apiUrl, {
            timeout: 15000,
            proxy: { protocol: 'http', host: '127.0.0.1', port: 43289 }
          });
        } catch (proxyErr) {
          console.warn(`Failed to fetch Zenodo API via proxy: ${proxyErr.message}, falling back to direct connection`);
          res = await axios.get(apiUrl, { timeout: 12000 });
        }

        if (!res.data || !Array.isArray(res.data.files) || res.data.files.length === 0) {
          throw new Error(`[Zenodo ${recordId}] 未找到任何附件数据`);
        }

        const resolvedFiles = await Promise.all(res.data.files.map(async (fileItem) => {
          const fileUrl = fileItem.links?.content || fileItem.links?.self || `https://zenodo.org/records/${recordId}/files/${fileItem.key}/content`;
          const fileName = fileItem.key || fileItem.filename || fileUrl.substring(fileUrl.lastIndexOf('/') + 1);
          let size = typeof fileItem.size === 'number' ? fileItem.size : 0;
          if (size === 0) {
            size = await headRequestSize(fileUrl);
          }
          return { name: fileName, url: fileUrl, size, folder: 'zenodo_' + recordId };
        }));

        files.push(...resolvedFiles);
      } catch (err) {
        throw new Error(`获取 Zenodo 记录 [${rawId}] 失败: ` + err.message);
      }
    }
  } else if (type === 'huggingface') {
    for (const item of ids) {
      try {
        if (item.startsWith('http://') || item.startsWith('https://')) {
          const url = item;
          const fileName = url.substring(url.lastIndexOf('/') + 1) || 'hf_file_' + Date.now();
          const size = await headRequestSize(url);
          files.push({ name: fileName, url, size, folder: 'huggingface' });
          continue;
        }

        let repoId = item.trim().replace(/^https?:\/\/huggingface\.co\//i, '').replace(/^(datasets|models)\//i, '');
        let isDataset = item.toLowerCase().includes('/datasets/') || item.startsWith('datasets/');
        let finalRepoType = isDataset ? 'datasets' : 'models';

        // 递归请求树节点列表，过滤排除目录 tree 节点，仅保留真实的 file/blob 节点
        const fetchTreeFiles = async (rId, repoType, subPath = '') => {
          const treeUrl = subPath
            ? `https://huggingface.co/api/${repoType}/${rId}/tree/main/${subPath}`
            : `https://huggingface.co/api/${repoType}/${rId}/tree/main`;
          
          let res;
          try {
            res = await axios.get(treeUrl, {
              timeout: 15000,
              proxy: clashProcess ? { protocol: 'http', host: '127.0.0.1', port: 43289 } : false
            });
          } catch (proxyErr) {
            res = await axios.get(treeUrl, { timeout: 12000 });
          }

          if (!res.data || !Array.isArray(res.data)) return [];

          const fileList = [];
          for (const node of res.data) {
            if (node.type === 'file' || node.type === 'blob') {
              fileList.push(node);
            } else if (node.type === 'directory' || node.type === 'tree') {
              const subFiles = await fetchTreeFiles(rId, repoType, node.path);
              fileList.push(...subFiles);
            }
          }
          return fileList;
        };

        let fileNodes = [];
        try {
          fileNodes = await fetchTreeFiles(repoId, finalRepoType);
        } catch (e1) {
          finalRepoType = finalRepoType === 'datasets' ? 'models' : 'datasets';
          fileNodes = await fetchTreeFiles(repoId, finalRepoType);
        }

        if (fileNodes.length === 0) {
          throw new Error(`[HF ${item}] 未找到任何可下载的数据文件`);
        }

        const resolvedFiles = await Promise.all(fileNodes.map(async (node) => {
          const rpath = node.path;
          const fileName = rpath.substring(rpath.lastIndexOf('/') + 1);
          const fileUrl = finalRepoType === 'datasets'
            ? `https://huggingface.co/datasets/${repoId}/resolve/main/${rpath}`
            : `https://huggingface.co/${repoId}/resolve/main/${rpath}`;
          
          let size = typeof node.size === 'number' && node.size > 0 ? node.size : 0;
          if (size === 0) {
            size = await headRequestSize(fileUrl);
          }
          const folderName = 'hf_' + repoId.replace(/\//g, '_');
          return { name: fileName, url: fileUrl, size, folder: folderName };
        }));

        files.push(...resolvedFiles);
      } catch (err) {
        throw new Error(`获取 Hugging Face 存储库 [${item}] 失败: ` + err.message);
      }
    }
  } else if (type === 'links') {
    const promises = ids.map(async (link) => {
      // NCBI 动态导出链接依赖浏览器会话(Cookie),独立下载器拿不到,标记 blocked 交由前端弹窗说明,不入队
      if (isSessionBoundNcbiLink(link)) {
        return {
          name: fileNameFromUrl(link) || 'viewer.cgi',
          url: link,
          size: 0,
          blocked: true
        };
      }
      const size = await headRequestSize(link);
      const name = fileNameFromUrl(link) || ('file_' + Date.now());
      return { name, url: link, size };
    });
    const results = await Promise.all(promises);
    files.push(...results);
  }

  return files;
});

// --- 下载调度引擎 (支持多任务并行调度) ---
ipcMain.handle('start-download', async (event, { files, targetDir, token, maxConcurrent }) => {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. 验证目标磁盘可用空间
  try {
    const totalRequiredSpace = files.reduce((acc, f) => acc + (f.size || 0), 0);
    const stats = await fs.promises.statfs(targetDir);
    const freeSpace = stats.bavail * stats.bsize;
    if (freeSpace < totalRequiredSpace) {
      throw new Error(`磁盘可用空间不足！所需空间: ${(totalRequiredSpace / (1024 * 1024 * 1024)).toFixed(2)} GB, 可用空间: ${(freeSpace / (1024 * 1024 * 1024)).toFixed(2)} GB`);
    }
  } catch (err) {
    console.error('Disk space verification message:', err.message);
    if (err.message.includes('磁盘可用空间不足')) {
      throw err;
    } else {
      console.warn('statfs not fully supported on this volume, bypassing disk space limit check.');
    }
  }

  const axelBin = getAxelBinaryPath();
  ensureExecutable(axelBin);

  const MAX_RETRIES = 3;
  const maxConcurrentCount = parseInt(maxConcurrent, 10) || 3;

  let activeCount = 0;
  let fileIndexInQueue = 0;
  let cancelled = false;

  // 保存每个正在下载的文件的取消控制器函数（防止中途取消）
  const cancelTokens = new Map();

  async function downloadSingleFile(file, fileIndex) {
    if (cancelled) return;
    if (cancelledFiles.has(fileIndex)) {
      // 任务在排队期间已被用户取消:直接回传取消状态,不再起下载进程
      cancelledFiles.delete(fileIndex);
      mainWindow.webContents.send('download-status', { index: fileIndex, fileName: file.name, status: 'cancelled', percentage: 0, speed: '已取消' });
      return;
    }
    
    let fileDestFolder;
    if (file.isUpdate) {
      fileDestFolder = app.getPath('downloads');
    } else {
      const safeFolder = sanitizePathSegment(file.folder);
      fileDestFolder = safeFolder ? path.join(targetDir, safeFolder) : targetDir;
    }

    if (!fs.existsSync(fileDestFolder)) {
      try { fs.mkdirSync(fileDestFolder, { recursive: true }); } catch (e) {}
    }

    // 纵深防御:保存前再清洗一次文件名,杜绝任何来源的非法字符导致 Windows 建文件崩溃
    const safeName = sanitizePathSegment(file.name) || (`download_${Date.now()}`);
    const savePath = path.join(fileDestFolder, safeName);

    // 1. 去重与文件完整性大小核验
    if (fs.existsSync(savePath)) {
      try {
        const localStats = fs.statSync(savePath);
        const hasStateFile = fs.existsSync(savePath + '.st');
        let shouldSkip = false;
        let skipReason = '已校验(跳过)';

        if (file.size && file.size > 0) {
          if (localStats.size === file.size) {
            shouldSkip = true;
          }
        } else {
          // 如果远程大小校验失败返回 0 或未定义 (常见于网络拥堵/NCBI FTP 握手失败)，但本地已存在该文件且无 Axel 临时 st 分片文件，则判定为已完整下载
          if (localStats.size > 0 && !hasStateFile) {
            shouldSkip = true;
            skipReason = '已存在(跳过)';
          }
        }

        if (shouldSkip) {
          console.log(`File ${file.name} already exists. Skipping download (${skipReason}).`);
          mainWindow.webContents.send('download-status', {
            index: fileIndex,
            fileName: file.name,
            status: 'completed',
            percentage: 100,
            speed: skipReason,
            savePath
          });
          return;
        }
      } catch (err) {
        console.warn(`Failed to verify file integrity for ${file.name}, proceeding with download:`, err.message);
      }
    }

    let attempt = 0;
    let downloadSuccess = false;
    let lastErrorMsg = '';

    while (attempt < MAX_RETRIES && !downloadSuccess && !cancelled) {
      if (pausedAxelFiles.has(fileIndex)) break; // 重试间隙收到暂停请求:不再起新尝试,等待用户恢复
      attempt++;

      if (attempt > 1) {
        const backoffTime = Math.pow(2, attempt) * 1000;
        console.log(`Retrying download for ${file.name} in ${backoffTime}ms (Attempt ${attempt}/${MAX_RETRIES})`);
        mainWindow.webContents.send('download-status', {
          index: fileIndex,
          fileName: file.name,
          status: 'downloading',
          percentage: null,
          speed: `网络波动重试中 (${attempt}/${MAX_RETRIES})...`
        });
        
        // 等待重试或被取消
        let sleepFinished = false;
        await Promise.race([
          new Promise(resolve => setTimeout(() => { sleepFinished = true; resolve(); }, backoffTime)),
          new Promise((resolve, reject) => {
            cancelTokens.set(fileIndex, () => {
              reject(new Error('Cancelled'));
            });
          })
        ]).catch(() => {
          lastErrorMsg = '任务已取消';
        });

        if (!sleepFinished) {
          break; // 已经被取消
        }
      }

      if (attempt === 1 && fs.existsSync(savePath) && !fs.existsSync(savePath + '.st')) {
        try {
          fs.unlinkSync(savePath);
        } catch (e) {
          console.warn(`Failed to clean initial broken file ${savePath}:`, e.message);
        }
      }

async function downloadFileWithNodeStream(fileUrl, savePath, env, fileIndex, totalSize, logStream) {
  const targetDir = path.dirname(savePath);
  if (!fs.existsSync(targetDir)) {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch (e) {
      throw new Error(`无法创建保存目录 ${targetDir}: ${e.message}`);
    }
  }

  let downloadedBytes = 0;
  let lastEmitTime = Date.now();
  let lastBytes = 0;
  let speedTimer = null;

  const axiosOptions = {
    url: fileUrl,
    method: 'GET',
    responseType: 'stream',
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: (s) => (s >= 200 && s < 400), // 4xx/5xx 走 catch,给出明确失败原因
    proxy: (env && env.http_proxy) ? { protocol: 'http', host: '127.0.0.1', port: 43289 } : false
  };

  if (logStream) {
    logStream.write(`\n=== 触发 Node.js 纯内置极速回退引擎下载 ===\nURL: ${fileUrl}\nSavePath: ${savePath}\n`);
  }

  const response = await axios(axiosOptions);
  // 误下 HTML 错误页检测(如 NCBI 会话型链接无浏览器会话时返回网页而非文件)
  const ct = String(response.headers['content-type'] || '').toLowerCase();
  if (ct.includes('text/html') && !/\.(html?|xhtml)$/i.test(path.basename(savePath))) {
    throw new Error('服务器返回网页(错误页/需登录会话),非可下载文件');
  }
  const headerLen = parseInt(response.headers['content-length'] || '0', 10);
  const finalTotalSize = totalSize || headerLen || 0;

  // 关键:拿到响应后再创建写流,并在 Promise 执行器内"立即同步"绑定错误处理,
  // 杜绝此前 createWriteStream 与错误处理之间存在 await 空窗而导致的未捕获异常崩溃。
  const writer = fs.createWriteStream(savePath);
  return new Promise((resolve, reject) => {
    const fail = (err) => {
      if (speedTimer) clearInterval(speedTimer);
      if (logStream) {
        logStream.write(`\n=== Node.js 回退引擎错误: ${err.message} ===\n`);
        logStream.end();
      }
      reject(err);
    };
    writer.on('error', fail);        // 最先绑定,覆盖任何异步空窗
    response.data.on('error', fail);

    speedTimer = setInterval(() => {
      const now = Date.now();
      const bytesDiff = downloadedBytes - lastBytes;
      lastBytes = downloadedBytes;
      const speedBps = (bytesDiff / ((now - lastEmitTime || 1000) / 1000));
      lastEmitTime = now;

      let speedStr = '0 B/s';
      if (speedBps > 1024 * 1024) {
        speedStr = (speedBps / (1024 * 1024)).toFixed(2) + ' MB/s';
      } else if (speedBps > 1024) {
        speedStr = (speedBps / 1024).toFixed(1) + ' KB/s';
      } else {
        speedStr = Math.round(speedBps) + ' B/s';
      }

      let percentage = finalTotalSize > 0 ? Math.min(99, Math.floor((downloadedBytes / finalTotalSize) * 100)) : 50;

      mainWindow.webContents.send('download-progress', {
        index: fileIndex,
        percentage,
        speed: speedStr,
        receivedBytes: downloadedBytes,
        totalBytes: finalTotalSize || null
      });
    }, 500);

    response.data.on('data', (chunk) => {
      downloadedBytes += chunk.length;
    });

    response.data.pipe(writer);

    writer.on('finish', () => {
      if (speedTimer) clearInterval(speedTimer);
      // 完整性校验:防止流被中途截断却误报成功(会留下坏文件)
      if (finalTotalSize > 0 && downloadedBytes !== finalTotalSize) {
        if (logStream) {
          logStream.write(`\n=== Node.js 回退引擎下载不完整 (${downloadedBytes}/${finalTotalSize} 字节),判定失败 ===\n`);
          logStream.end();
        }
        return reject(new Error(`下载不完整: ${downloadedBytes}/${finalTotalSize} 字节`));
      }
      mainWindow.webContents.send('download-progress', {
        index: fileIndex,
        percentage: 100,
        speed: '0 B/s'
      });
      if (logStream) {
        logStream.write(`\n=== Node.js 回退引擎下载成功 ===\n`);
        logStream.end();
      }
      resolve();
    });
  });
}

      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: 'downloading',
        percentage: 0,
        speed: '正在高速下载...'
      });

      const env = { ...process.env };
      if (clashProcess !== null) {
        env.http_proxy = 'http://127.0.0.1:43289';
        env.https_proxy = 'http://127.0.0.1:43289';
        env.all_proxy = 'http://127.0.0.1:43289';
        env.HTTP_PROXY = 'http://127.0.0.1:43289';
        env.HTTPS_PROXY = 'http://127.0.0.1:43289';
        env.ALL_PROXY = 'http://127.0.0.1:43289';
      } else {
        delete env.http_proxy;
        delete env.https_proxy;
        delete env.all_proxy;
        delete env.HTTP_PROXY;
        delete env.HTTPS_PROXY;
        delete env.ALL_PROXY;
      }

      let threads = 16;
      if (file.size) {
        if (file.size < 500 * 1024) {
          threads = 1;
        } else if (file.size < 5 * 1024 * 1024) {
          threads = 4;
        } else if (file.size < 50 * 1024 * 1024) {
          threads = 8;
        } else if (file.size < 500 * 1024 * 1024) {
          threads = 16;
        } else if (file.size < 2 * 1024 * 1024 * 1024) {
          threads = 24;
        } else {
          threads = 32; // 超大文件用更多连接,尽量跑满多个快节点
        }
      }
      // 总连接封顶:避免 并发文件数 × 单文件线程数 压垮 mihomo 与节点池
      threads = Math.max(1, Math.min(threads, Math.floor(64 / Math.max(1, maxConcurrentCount))));

      const args = ['-n', threads.toString(), '-T', '20', '-U', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', '-k', '-o', savePath, file.url];
      console.log(`Running Axel (Attempt ${attempt}): ${axelBin} ${args.join(' ')}`);

      let logStream = null;
      const settings = getSettings();
      if (settings.loggingEnabled) {
        try {
          const logFileName = `download_${file.name.replace(/[^a-zA-Z0-9\._-]/g, '_')}_${Date.now()}.log`;
          const logFilePath = path.join(LOG_DIR, logFileName);
          logStream = fs.createWriteStream(logFilePath, { flags: 'a', encoding: 'utf8' });
          logStream.write(`=== 下载任务诊断日志 ===\n`);
          logStream.write(`时间: ${new Date().toISOString()}\n`);
          logStream.write(`文件名: ${file.name}\n`);
          logStream.write(`URL: ${file.url}\n`);
          logStream.write(`目标保存路径: ${savePath}\n`);
          logStream.write(`尝试次数: ${attempt}\n`);
          logStream.write(`线程数: ${threads}\n`);
          logStream.write(`代理环境: ${JSON.stringify(env)}\n`);
          logStream.write(`Axel 命令: ${axelBin} ${args.join(' ')}\n\n`);
        } catch (logErr) {
          console.error('Failed to create download log stream:', logErr);
        }
      }

      try {
        await new Promise((resolve, reject) => {
          if (cancelled) {
            if (logStream) {
              logStream.write(`\n=== 任务启动前已被取消 ===\n`);
              logStream.end();
            }
            return reject(new Error('Cancelled'));
          }

          // 确保本地目标保存文件夹存在，防止 axel 报 Error opening local file
          try {
            const targetDir = path.dirname(savePath);
            if (!fs.existsSync(targetDir)) {
              fs.mkdirSync(targetDir, { recursive: true });
            }
          } catch (dirErr) {
            console.error('Failed to create target directory:', dirErr);
          }

          const proc = spawn(axelBin, args, { env });
          activeAxelProcesses.set(fileIndex, proc);

          // 注册当前文件任务的取消执行逻辑
          cancelTokens.set(fileIndex, () => {
            killProcess(proc);
            activeAxelProcesses.delete(fileIndex);
            if (logStream) {
              logStream.write(`\n=== 任务被用户手动取消 ===\n`);
              logStream.end();
            }
            reject(new Error('Cancelled'));
          });

          proc.on('error', (err) => {
            console.error('Axel spawn error:', err);
            if (logStream) {
              logStream.write(`\n=== 异常错误 ===\n${err.stack || err.message}\n`);
              logStream.end();
            }
            activeAxelProcesses.delete(fileIndex);
            reject(err);
          });

          const lastProgressEmitMap = new Map();

          proc.stdout.on('data', (data) => {
            const output = data.toString();
            if (logStream) {
              logStream.write(`[STDOUT] ${output}`);
            }
            const pctMatch = output.match(/\[\s*(\d+)%\]/);
            const speedMatch = output.match(/\[\s*([\d\.]+\s*[KMGT]*B\/s)\]/);

            let percentage = pctMatch ? parseInt(pctMatch[1]) : null;
            let speed = speedMatch ? speedMatch[1] : null;

            if (percentage !== null || speed !== null) {
              const now = Date.now();
              const lastTime = lastProgressEmitMap.get(fileIndex) || 0;
              // 节流处理: 限制最多 250ms (4Hz) 向渲染进程推送一次进度，降低 Mac CPU 重绘开销与发热
              if (percentage === 100 || (now - lastTime >= 250)) {
                lastProgressEmitMap.set(fileIndex, now);
                 let axelReceivedBytes = null;
                  try { axelReceivedBytes = fs.statSync(savePath).size; } catch (e) { axelReceivedBytes = null; }
                  mainWindow.webContents.send('download-progress', {
                    index: fileIndex,
                    percentage,
                    speed,
                    receivedBytes: axelReceivedBytes,
                    totalBytes: file.size || null
                  });
              }
            }
          });

          let axelHasDyldError = false;

          proc.stderr.on('data', (data) => {
            const output = data.toString();
            if (output.includes('Library not loaded') || output.includes('dyld')) {
              axelHasDyldError = true;
            }
            if (logStream) {
              logStream.write(`[STDERR] ${output}`);
            }
          });

          proc.on('close', (code) => {
            activeAxelProcesses.delete(fileIndex);
            if (logStream) {
              logStream.write(`\n=== 进程退出 ===\n状态码: ${code}\n`);
            }
            if (pausedAxelFiles.has(fileIndex)) {
              // 用户手动暂停:进程已终止,保留已下载部分与 .st 断点文件,恢复时从断点续传
              if (logStream) { logStream.write(`\n=== 任务被用户暂停,断点已保留(可随时恢复) ===\n`); logStream.end(); }
              return reject(new Error('Paused'));
            }
            if (code === 0 && !axelHasDyldError) {
              // 检测是否误下了 HTML 错误页(如 NCBI 会话型链接无浏览器会话时返回网页),避免把网页当文件"成功"
              if (looksLikeHtmlError(savePath)) {
                if (logStream) { logStream.write(`\n=== 检测到下载结果为 HTML 错误页,判定失败 ===\n`); logStream.end(); }
                try { fs.unlinkSync(savePath); } catch (e) {}
                try { fs.unlinkSync(savePath + '.st'); } catch (e) {}
                return reject(new Error('服务器返回网页(错误页/需登录会话),非可下载文件'));
              }
              if (logStream) logStream.end();
              resolve();
            } else if (axelHasDyldError) {
              // axel 二进制/动态库级错误,重试无意义,直接走 Node 保底引擎
              if (logStream) {
                logStream.write(`Axel 动态库缺失,触发纯 Node.js 保底下载引擎...\n`);
              }
              downloadFileWithNodeStream(file.url, savePath, env, fileIndex, file.size, logStream)
                .then(resolve)
                .catch(reject);
            } else {
              // 普通失败:交给外层重试循环重新用 axel(可断点续传),不立即降级到单连接 Node 引擎,避免断崖降速
              if (logStream) {
                logStream.write(`Axel 本次失败(code=${code}),将重试并保留断点...\n`);
              }
              reject(new Error(`Axel exited with code ${code}`));
            }
          });
        });

        downloadSuccess = true;
      } catch (err) {
        lastErrorMsg = err.message;
        console.warn(`Attempt ${attempt} for ${file.name} failed: ${lastErrorMsg}`);
        if (lastErrorMsg === 'Cancelled' || lastErrorMsg === 'Paused' || cancelledFiles.has(fileIndex)) {
          break; // 被取消/暂停时立即中断重试循环(暂停须保留断点,重试会破坏语义)
        }
      }
    }

    cancelTokens.delete(fileIndex);

    // 所有 axel 重试均失败后,最后用 Node 保底引擎兜底一次(清除 axel 断点状态,从头下载)
    // 注意:用户暂停/取消的任务不走保底,否则暂停会被后台偷偷续跑
    if (!downloadSuccess && !cancelled && lastErrorMsg !== 'Paused' && !pausedAxelFiles.has(fileIndex) && !cancelledFiles.has(fileIndex)) {
      try {
        try { fs.unlinkSync(savePath + '.st'); } catch (e) {}
        console.warn(`All axel retries failed for ${file.name}, final fallback to Node engine.`);
        await downloadFileWithNodeStream(file.url, savePath, env, fileIndex, file.size, null);
        downloadSuccess = true;
      } catch (nodeErr) {
        lastErrorMsg = nodeErr.message;
      }
    }

    if (downloadSuccess) {
      pausedAxelFiles.delete(fileIndex); // 任务成功后清理暂停/取消标记,防止残留影响后续同下标任务
      cancelledFiles.delete(fileIndex);
      if (!file.isUpdate) {
        try {
          // 上报【实际下载字节数】(落盘文件大小)而非预估 file.size——直链未知大小时 file.size=0 会漏计;
          // 更新包(isUpdate)与"检验下载大小"均不走此处,故只有真实数据下载计费,与服务端 /speedup 闸门统一。
          let consumedBytes = file.size || 0;
          try {
            const st = fs.statSync(savePath);
            if (st && st.size > 0) consumedBytes = st.size;
          } catch (e) {}
          console.log(`Download success. Reporting consumed bytes: ${consumedBytes} (预估 file.size=${file.size})`);
          await axios.post(`${BACKEND_BASE_URL}/api/user/consume`, {
            token,
            bytes: consumedBytes
          });
        } catch (e) {
          console.error('Failed to report traffic consume:', e.message);
        }
      } else {
        try {
          shell.showItemInFolder(savePath);
        } catch (e) {
          console.error('Failed to show update package in folder:', e.message);
        }
      }

      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: 'completed',
        percentage: 100,
        speed: file.isUpdate ? '已下载(更新包)' : '已保存',
        savePath
      });
    } else {
      const wasPaused = pausedAxelFiles.has(fileIndex) || lastErrorMsg === 'Paused';
      const wasCancelled = cancelledFiles.has(fileIndex) || lastErrorMsg === 'Cancelled';
      pausedAxelFiles.delete(fileIndex);
      cancelledFiles.delete(fileIndex);

      if (wasPaused) {
        // 暂停:保留断点与传输列表卡片,等待用户恢复
        mainWindow.webContents.send('download-status', {
          index: fileIndex,
          fileName: file.name,
          status: 'paused',
          percentage: null,
          speed: '已暂停'
        });
        return;
      }

      // 智能失败提示:识别 NCBI 会话型链接 / HTML 错误页 / HTTP 4xx,给出可操作说明(而非笼统"下载失败")
      let failReason = '下载失败';
      if (lastErrorMsg && !wasCancelled) {
        if (isSessionBoundNcbiLink(file.url)) {
          failReason = '该 NCBI 动态导出链接(viewer.cgi?query_key)依赖浏览器检索会话,独立下载无法获取。建议改用 accession 编号(如 NM_007482.3)经 EFetch 下载,或在浏览器 Network 中 Copy as cURL 提取直链。';
        } else if (/返回网页|错误页|需登录/i.test(lastErrorMsg)) {
          failReason = '服务器返回网页而非文件(链接可能需登录/已失效/为动态地址)。';
        } else if (/status code 4\d\d|Bad Request|Forbidden|Not Found/i.test(lastErrorMsg)) {
          const code = (lastErrorMsg.match(/status code (\d+)/) || [])[1] || '4xx';
          failReason = `服务器拒绝该链接(HTTP ${code}):链接可能已失效、需登录或为动态生成地址。`;
        } else {
          failReason = lastErrorMsg;
        }
      }
      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: wasCancelled ? 'cancelled' : 'failed',
        percentage: 0,
        speed: wasCancelled ? '已取消' : failReason
      });
    }
  }

  // 开始并行执行队列池
  return new Promise((resolve) => {
    let completedCount = 0;

    async function startNext() {
      if (cancelled) return;
      
      if (fileIndexInQueue >= files.length) {
        if (activeCount === 0) {
          resolve({ success: true, completed: completedCount });
        }
        return;
      }

      const fileIdx = fileIndexInQueue++;
      const file = files[fileIdx];
      const fileIndex = file.originalIndex !== undefined ? file.originalIndex : fileIdx;

      activeCount++;
      try {
        await downloadSingleFile(file, fileIndex);
        completedCount++;
      } catch (err) {
        console.error(`Task execution for ${file.name} finished:`, err.message);
      } finally {
        activeCount--;
        startNext();
      }
    }

    // 注册全局取消钩子
    event.sender.on('cancel-all-downloads-signal', () => {
      cancelled = true;
      // 确保被杀进程不再触发重试/保底;清除暂停标记,避免被挂起的任务取消后误报 paused
      for (const idx of activeAxelProcesses.keys()) { cancelledFiles.add(idx); pausedAxelFiles.delete(idx); }
      killAllAxelProcesses();
      resolve({ success: true, cancelled: true });
    });

    for (let w = 0; w < Math.min(maxConcurrentCount, files.length); w++) {
      startNext();
    }
  });
});

ipcMain.handle('cancel-download', (event, fileIndex) => {
  if (fileIndex !== undefined && fileIndex !== null) {
    // 标记取消:无论进程是否正在跑(排队中同样生效),重试循环与保底引擎见到标记立即终止
    pausedAxelFiles.delete(fileIndex);
    cancelledFiles.add(fileIndex);
    const proc = activeAxelProcesses.get(fileIndex);
    if (proc) {
      console.log(`Cancelling single task at index: ${fileIndex}`);
      killProcess(proc);
      activeAxelProcesses.delete(fileIndex);
    }
    return true;
  } else {
    console.log('Cancelling all active downloads...');
    for (const idx of activeAxelProcesses.keys()) cancelledFiles.add(idx);
    killAllAxelProcesses();
    return true;
  }
});

// 挂起/恢复子进程(Unix 用 SIGSTOP/SIGCONT 原地冻结,进度与连接状态零丢失;
// Windows 用系统自带 Suspend-Process/Resume-Process。实测 axel 的 .st 断点在信号终止时
// 记录不完整会触发重复下载甚至卡死,故暂停绝不能杀进程,只能挂起)
function pauseProcess(proc) {
  if (!proc || proc.killed) return false;
  try {
    if (process.platform === 'win32') {
      exec(`powershell -NoProfile -Command "Suspend-Process -Id ${proc.pid}"`, (err) => { if (err) console.warn('Suspend-Process failed:', err.message); });
    } else {
      process.kill(proc.pid, 'SIGSTOP');
    }
    return true;
  } catch (e) { console.error('pauseProcess error:', e.message); return false; }
}

function resumeProcess(proc) {
  if (!proc || proc.killed) return false;
  try {
    if (process.platform === 'win32') {
      exec(`powershell -NoProfile -Command "Resume-Process -Id ${proc.pid}"`, (err) => { if (err) console.warn('Resume-Process failed:', err.message); });
    } else {
      process.kill(proc.pid, 'SIGCONT');
    }
    return true;
  } catch (e) { console.error('resumeProcess error:', e.message); return false; }
}

// 暂停单个下载任务:挂起 axel 进程(原地冻结,断点/连接全保留);排队/重试间隙的任务打标记,由重试循环检查点退出
ipcMain.handle('pause-download', (event, fileIndex) => {
  if (cancelledFiles.has(fileIndex)) return { success: false, error: '该任务正在取消' };
  const proc = activeAxelProcesses.get(fileIndex);
  if (proc && !proc.killed && pauseProcess(proc)) {
    pausedAxelFiles.add(fileIndex);
    return { success: true, suspended: true };
  }
  // 无运行中的进程(排队中或重试退避间隙):标记暂停,重试循环顶部检测到后回传 paused
  pausedAxelFiles.add(fileIndex);
  return { success: true, suspended: false };
});

// 恢复单个下载任务:优先唤醒被挂起的进程(原任务原地继续);无挂起进程时由渲染层重新发起下载走断点续传
ipcMain.handle('resume-download', (event, fileIndex) => {
  const proc = activeAxelProcesses.get(fileIndex);
  if (proc && !proc.killed) {
    pausedAxelFiles.delete(fileIndex);
    resumeProcess(proc);
    return { success: true, resumed: true };
  }
  pausedAxelFiles.delete(fileIndex);
  return { success: true, resumed: false };
});

ipcMain.handle('open-downloads-folder', (event, folderPath) => {
  let target = folderPath;
  if (!target || typeof target !== 'string' || !fs.existsSync(target)) {
    target = app.getPath('downloads');
  }
  if (!fs.existsSync(target)) {
    try { fs.mkdirSync(target, { recursive: true }); } catch (e) {}
  }
  if (fs.existsSync(target)) {
    // 文件 → 在文件夹中定位(避免用默认程序打开几十GB的数据文件);目录 → 直接打开
    try {
      if (fs.statSync(target).isFile()) {
        shell.showItemInFolder(target);
      } else {
        shell.openPath(target);
      }
    } catch (e) {
      shell.openPath(target);
    }
    return true;
  }
  return false;
});

// ---------- 粘贴 cURL 下载:解析 + 带会话(Cookie/请求头)流式下载 ----------
// ---------- NCBI 会话式导出 → efetch 分页下载(把一次性大流拆成可逐页重试的小请求) ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function ncbiReportToRettype(report) {
  const r = String(report || '').toLowerCase();
  return ({ genbank: 'gb', gb: 'gb', gbwithparts: 'gbwithparts', gbc: 'gbc', gff: 'gff3', gff3: 'gff3', fasta: 'fasta', fa: 'fasta', docsum: 'docsum', acc: 'acc', accession: 'acc' })[r] || 'gb';
}
function ncbiRettypeExt(rettype) {
  if (rettype === 'fasta') return 'fa';
  if (rettype === 'docsum') return 'xml';
  if (rettype === 'gff3') return 'gff3';
  return 'gb';
}
function extractCookieValue(cookie, name) {
  for (const p of String(cookie || '').split(/;\s*/)) {
    const eq = p.indexOf('=');
    if (eq > 0 && p.slice(0, eq).trim() === name) return p.slice(eq + 1).trim();
  }
  return '';
}
function queryParam(url, name) {
  try { return new URL(url).searchParams.get(name) || ''; } catch (e) { return ''; }
}
function termFromHeaders(headers) {
  const ref = (headers || []).find((h) => h && h.name && h.name.toLowerCase() === 'referer');
  if (ref) { const m = String(ref.value).match(/[?&]term=([^&]+)/); if (m) { try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; } } }
  return '';
}
function buildEfetchUrl({ db, queryKey, webEnv, rettype, retstart, retmax }) {
  return 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?' + [
    'db=' + encodeURIComponent(db),
    'query_key=' + encodeURIComponent(queryKey),
    'WebEnv=' + webEnv, // 保留 cookie 中的编码形式(如 %40),不二次编码
    'rettype=' + encodeURIComponent(rettype),
    'retmode=text',
    'retstart=' + retstart,
    'retmax=' + retmax
  ].join('&');
}

async function downloadNcbiPaginated(parsed, saveDir, send, shouldCancel) {
  const url = parsed.url;
  const db = queryParam(url, 'db') || 'nuccore';
  const queryKey = queryParam(url, 'query_key') || queryParam(url, 'QueryKey');
  const report = queryParam(url, 'report') || 'genbank';
  const webEnv = extractCookieValue(parsed.cookie, 'WebEnv');
  if (!queryKey || !webEnv) throw new Error('缺少 query_key 或 WebEnv,无法转换。请确认粘贴的 cURL 含完整 Cookie。');
  const rettype = ncbiReportToRettype(report);
  const ext = ncbiRettypeExt(rettype);
  const isGenbankLike = (rettype === 'gb' || rettype === 'gbwithparts' || rettype === 'gbc' || rettype === 'gff3');

  const reqHeaders = {
    'User-Agent': ((parsed.headers || []).find((h) => h && h.name && h.name.toLowerCase() === 'user-agent') || {}).value || 'Mozilla/5.0',
    'Cookie': parsed.cookie || ''
  };
  const PAGE = 100;

  // 1) 总数探针:越界 retstart 让 NCBI 自报总数;失败则改用增量分页(进度不显示总数)
  let total = 0;
  try {
    const probe = await axios.get(buildEfetchUrl({ db, queryKey, webEnv, rettype, retstart: 999999999, retmax: 1 }), { headers: reqHeaders, timeout: 60000, validateStatus: () => true, maxRedirects: 5 });
    const body = typeof probe.data === 'string' ? probe.data : String(probe.data || '');
    const m = body.match(/History\s+includes\s+([\d,]+)/i) || body.match(/(\d[\d,]*)\s*(?:identifiers?|sequences?|records?|IDs?)/i);
    if (m) total = parseInt(m[1].replace(/,/g, ''), 10) || 0;
  } catch (e) {}

  const tmpDir = path.join(saveDir, '.ncbi_chunks_' + Date.now());
  fs.mkdirSync(tmpDir, { recursive: true });
  const chunkFiles = [];
  let cleaned = false;
  const cleanup = () => { if (cleaned) return; cleaned = true; try { for (const f of chunkFiles) fs.unlinkSync(f); fs.rmdirSync(tmpDir); } catch (e) {} };

  const fetchPage = async (retstart) => {
    let lastErr = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        const resp = await axios.get(buildEfetchUrl({ db, queryKey, webEnv, rettype, retstart, retmax: PAGE }), { headers: reqHeaders, timeout: 600000, validateStatus: () => true, maxRedirects: 5 });
        const text = typeof resp.data === 'string' ? resp.data : String(resp.data || '');
        if (resp.status >= 400) {
          if (/error|invalid|out of range|cannot|empty|no items/i.test(text.slice(0, 400))) return null; // 越界/空集 → 正常结束
          lastErr = new Error('HTTP ' + resp.status); await sleep(3000); continue;
        }
        if (!text || text.length < 2) return null;
        if (/^<\?xml|<!doctype|<html/i.test(text.slice(0, 80)) && !/^LOCUS|^>/.test(text)) { lastErr = new Error('返回非数据(会话可能过期)'); await sleep(3000); continue; }
        return text;
      } catch (e) { lastErr = e; await sleep(3000 * attempt); }
    }
    throw lastErr || new Error('分页下载失败 retstart=' + retstart);
  };

  try {
    let retstart = 0, records = 0, pageIdx = 0;
    const totalPages = total > 0 ? Math.ceil(total / PAGE) : null;
    while (true) {
      if (shouldCancel && shouldCancel()) {
        const e = new Error('CANCELLED');
        e.isCancelled = true;
        throw e; // 外层 catch 负责清理临时分片
      }
      const text = await fetchPage(retstart);
      if (!text) break;
      const chunkPath = path.join(tmpDir, 'chunk_' + String(retstart).padStart(9, '0') + '.' + ext);
      fs.writeFileSync(chunkPath, text, 'utf8');
      chunkFiles.push(chunkPath);
      const pageRec = isGenbankLike ? (text.match(/^LOCUS/gm) || []).length : (rettype === 'fasta' ? (text.match(/^>/gm) || []).length : 1);
      records += pageRec;
      pageIdx++;
      send({ status: 'progress', percentage: totalPages ? Math.min(99, Math.floor(pageIdx / totalPages * 100)) : null, speed: `第 ${pageIdx}${totalPages ? '/' + totalPages : ''} 页 · 累计 ${records} 条` });
      if (pageRec < PAGE) break;                 // 本页不满 → 到末尾
      if (total > 0 && retstart + PAGE >= total) break;
      retstart += PAGE;
      await sleep(400);                          // 无 API key 限速约 3 请求/秒
    }
    if (chunkFiles.length === 0) throw new Error('未获取到任何记录:会话可能已过期,或 query_key 与 WebEnv 不匹配。请重新 Copy as cURL。');

    const term = termFromHeaders(parsed.headers);
    const base = sanitizePathSegment(term ? `${term}_qk${queryKey}` : `ncbi_${db}_qk${queryKey}`) || ('ncbi_' + Date.now());
    const finalName = `${base}.${ext}`;
    const finalPath = path.join(saveDir, finalName);
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(finalPath);
      ws.on('error', reject);
      let i = 0;
      const pipeNext = () => {
        if (i >= chunkFiles.length) { ws.end(); return; }
        const rs = fs.createReadStream(chunkFiles[i++]);
        rs.on('error', reject);
        rs.pipe(ws, { end: false });
        rs.on('end', pipeNext);
      };
      ws.on('finish', resolve);
      pipeNext();
    });

    let warn = '';
    if (total > 0 && isGenbankLike && records !== total) warn = ` 警告:记录数 ${records} ≠ 官方总数 ${total},请核查。`;
    cleanup();
    const size = fs.statSync(finalPath).size;
    send({ status: 'completed', name: finalName, savePath: finalPath, downloaded: size, warn });
    return { success: true, savePath: finalPath, name: finalName };
  } catch (e) {
    cleanup();
    throw e;
  }
}

ipcMain.handle('parse-curl', (event, { text }) => {
  try {
    const parsed = parseCurlCommand(text);
    return {
      success: true,
      parsed,
      preview: { url: parsed.url, method: parsed.method, headerCount: parsed.headers.length, hasCookie: !!parsed.cookie, hasData: !!parsed.data }
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('download-curl', async (event, { parsed, saveDir }) => {
  const send = (d) => { try { mainWindow.webContents.send('curl-download-progress', d); } catch (e) {} };
  try {
    if (!parsed || !parsed.url) throw new Error('缺少解析结果');
    const dir = saveDir || app.getPath('downloads');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // NCBI 会话式导出链接:转换为 efetch 分页下载(稳健、可逐页重试),而非直接拉一次性大流
    if (isSessionBoundNcbiLink(parsed.url) && queryParam(parsed.url, 'query_key') && extractCookieValue(parsed.cookie, 'WebEnv')) {
      return await downloadNcbiPaginated(parsed, dir, send);
    }

    const headers = {};
    for (const h of (parsed.headers || [])) { if (h && h.name) headers[h.name] = h.value; }
    if (parsed.cookie) headers['Cookie'] = parsed.cookie;

    const axiosOptions = {
      url: parsed.url,
      method: (parsed.method || 'GET').toUpperCase(),
      headers,
      responseType: 'stream',
      maxRedirects: 8,
      timeout: 30 * 60 * 1000,
      validateStatus: () => true,
      data: parsed.data || undefined
    };

    send({ status: 'progress', percentage: 0, speed: '连接中…' });
    const response = await axios(axiosOptions);
    if (response.status >= 400) throw new Error(`服务器返回 HTTP ${response.status}(会话可能已失效或链接无效)`);

    // 文件名:优先 Content-Disposition,否则从 URL 取,最后清洗非法字符
    let name = '';
    const cd = String(response.headers['content-disposition'] || '');
    const mcd = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i) || cd.match(/filename="?([^";]+)"?/i);
    if (mcd) { try { name = decodeURIComponent(mcd[1].trim()); } catch (e) { name = mcd[1].trim(); } }
    if (!name) name = fileNameFromUrl(parsed.url);
    name = sanitizePathSegment(name) || ('download_' + Date.now());
    const savePath = path.join(dir, name);

    const total = parseInt(response.headers['content-length'] || '0', 10) || 0;
    const writer = fs.createWriteStream(savePath);
    return await new Promise((resolve, reject) => {
      let downloaded = 0, lastB = 0, timer = null, firstChunk = true, done = false;
      const finish = (err) => {
        if (done) return; done = true;
        if (timer) clearInterval(timer);
        try { writer.destroy(); } catch (e) {}
        if (err) {
          try { fs.unlinkSync(savePath); } catch (e) {}
          send({ status: 'failed', message: err.message });
          reject(err);
        } else {
          send({ status: 'completed', name, savePath, downloaded });
          resolve({ success: true, savePath, name });
        }
      };
      writer.on('error', (e) => finish(e));
      response.data.on('error', (e) => finish(e));
      timer = setInterval(() => {
        const diff = downloaded - lastB; lastB = downloaded;
        const bps = diff / 0.5;
        const speedStr = bps > 1048576 ? (bps / 1048576).toFixed(2) + ' MB/s' : bps > 1024 ? (bps / 1024).toFixed(1) + ' KB/s' : Math.round(bps) + ' B/s';
        const pct = total > 0 ? Math.min(99, Math.floor(downloaded / total * 100)) : null;
        send({ status: 'progress', percentage: pct, speed: speedStr + '  ' + fmtBytes(downloaded) + (total > 0 ? '/' + fmtBytes(total) : '') });
      }, 500);
      response.data.on('data', (chunk) => {
        downloaded += chunk.length;
        if (firstChunk) {
          firstChunk = false;
          const head = chunk.slice(0, 1024).toString('utf8').trimStart().toLowerCase();
          if ((head.startsWith('<!doctype html') || head.startsWith('<html')) && !/\.(html?|xhtml)$/i.test(name)) {
            return finish(new Error('服务器返回网页(错误页/会话失效),非可下载文件。请重新 Copy as cURL(会话可能已过期)。'));
          }
        }
      });
      response.data.pipe(writer);
      writer.on('finish', () => {
        if (total > 0 && downloaded !== total) return finish(new Error(`下载不完整 ${downloaded}/${total} 字节`));
        finish(null);
      });
    });
  } catch (e) {
    send({ status: 'failed', message: e.message });
    throw e;
  }
});

// ============================================================================
// 【2.0.0 引导式提取 (User-Guided Extraction)】
// 内置浏览器(webview 独立分区会话) + 下载拦截 + 资源嗅探 + 代码框。
// 拦截/嗅探到的真实下载统一交给本程序下载引擎(带 Cookie、断点续传),
// 并通过 'extraction-event' 回传到渲染进程的「传输列表」与侧边栏。
// ============================================================================
const BROWSER_PARTITION = 'persist:biodl-browser';
let browserSessionReady = false;
let extractionJobSeq = 1;
const extractionAborters = new Map(); // id -> AbortController(支持暂停引导式提取下载)
const extractionNativeDownloads = new Map(); // id -> DownloadItem(原生下载引擎接管,支持原生暂停/恢复)
const extractionCancelled = new Set(); // 用户手动取消的提取任务 id:回传 cancelled 状态并清理未完成文件,不计入失败列表

function getBrowserSession() {
  return session.fromPartition(BROWSER_PARTITION);
}

// 站点适配器:把某类 URL 判定为「重要资源」(侧边栏加粗红色置顶)
function classifyResource(url) {
  const u = String(url || '');
  if (/ncbi\.nlm\.nih\.gov/i.test(u)) {
    if (/efetch\.fcgi|viewer\.cgi|\/sendto|query_key=/i.test(u)) return { site: 'ncbi', important: true, label: 'NCBI 批量导出' };
    return { site: 'ncbi', important: false, label: 'NCBI' };
  }
  if (/singlecell\.broadinstitute\.org/i.test(u)) {
    if (/bulk_download|generate_curl_config|\/download/i.test(u)) return { site: 'broad', important: true, label: 'Broad 单细胞批量下载' };
    return { site: 'broad', important: false, label: 'Broad Single Cell' };
  }
  return { site: 'generic', important: false, label: '' };
}

function sendExtraction(payload) {
  const send = (w) => { try { if (w && !w.isDestroyed()) w.webContents.send('extraction-event', payload); } catch (e) {} };
  send(mainWindow);       // 传输列表(下载事件)
  send(extractionWindow); // 嗅探侧边栏/拦截提示(资源/日志事件)
}

// 内置浏览器代理:加速器开启时走 mihomo,否则直连。Chromium 不读 http_proxy 环境变量,必须对分区会话显式 setProxy,否则境外站点(如 NCBI/Broad)全部打不开
function setExtractionProxy() {
  try {
    // 注意:Chromium 的 proxyRules 是 PAC 风格,不能带 scheme://。
    // 直连必须用 "direct"(不是 "direct://"),否则整个 webview 会话请求会被代理层卡死→任何网站白屏。
    const rules = (clashProcess !== null) ? 'http=127.0.0.1:43289;https=127.0.0.1:43289' : 'direct';
    writeClashLog('[extraction] setExtractionProxy rules=' + rules);
    getBrowserSession().setProxy({ proxyRules: rules }).catch((e) => writeClashLog('[extraction] setProxy error: ' + e.message));
  } catch (e) { writeClashLog('[extraction] setExtractionProxy throw: ' + e.message); }
}

// 【2.0.7】引导式提取改用原生 BrowserView 内嵌网页(替代 <webview> 标签)。
// <webview> 在本窗口始终无法生成 guest 进程(即便无 partition,getWebContentsId 仍抛
// 'must be attached',导致任何网站白屏)。BrowserView 是 Electron 官方受支持的页面嵌入方式,
// 且同样使用 persist:biodl-browser 分区会话,下载拦截/资源嗅探/代理等既有 hook 自动生效。
let extractionBrowserView = null; // 当前弹窗对应的 BrowserView

function openExtractionWindow() {
  if (extractionWindow && !extractionWindow.isDestroyed()) { extractionWindow.focus(); return; }

  // 1. 先创建"壳窗口"(放地址栏/侧边栏/代码框),webPreferences 不再依赖 webviewTag
  extractionWindow = new BrowserWindow({
    width: 1180, height: 800, minWidth: 920, minHeight: 620,
    title: '引导式提取 · User-Guided Extraction',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
    backgroundColor: '#f0f4f8'
  });
  extractionWindow.loadFile('extraction.html');
  extractionWindow.on('closed', () => {
    if (extractionBrowserView) { try { extractionBrowserView.destroy(); } catch (e) {} extractionBrowserView = null; }
    extractionWindow = null;
  });

  // 2. 创建内嵌浏览器视图,使用既有分区会话(下载拦截/嗅探/代理自动生效)
  extractionBrowserView = new BrowserView({
    webPreferences: { partition: 'persist:biodl-browser', contextIsolation: true, nodeIntegration: false, sandbox: false }
  });
  extractionWindow.setBrowserView(extractionBrowserView);

  // 3. 首次显示:先放到壳窗口右下区域(避免遮挡),渲染进程就绪后会通过 IPC 告知精确位置
  const [sw, sh] = extractionWindow.getSize();
  extractionBrowserView.setBounds({ x: 0, y: 0, width: Math.max(100, sw - 320), height: Math.max(100, sh) });

  const bv = extractionBrowserView.webContents;
  bv.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 4. 同步导航/加载状态回壳窗口(渲染进程经 IPC 查询或事件推送)
  const emitNav = () => {
    try { extractionWindow.webContents.send('extraction-nav', { url: bv.getURL(), title: bv.getTitle() }); } catch (e) {}
  };
  bv.on('did-navigate', emitNav);
  bv.on('did-navigate-in-page', emitNav);
  bv.on('page-title-updated', emitNav);
  bv.on('did-fail-load', (e, code, desc, url) => {
    if (code !== -3) {
      const hint = (code === -105 || code === -106 || code === -118 || code === -102) ? ' 境外站点请确认主窗口「加速器」已开启。' : '';
      try { extractionWindow.webContents.send('extraction-nav', { url, failed: true, desc: desc + hint, code }); } catch (err) {}
    }
  });

  // 5. 默认加载起始页(about:blank),用户点击站点/输入网址后由渲染进程经 IPC 导航
  bv.loadURL('about:blank');
}

// 渲染进程 → 主进程:导航请求 / 尺寸更新 / 前进后退刷新
ipcMain.handle('extraction-browser-nav', (event, { url }) => {
  const bv = extractionBrowserView;
  if (!bv) return { success: false, error: 'no browser view' };
  try { bv.webContents.loadURL(url); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('extraction-browser-resize', (event, { width, height, x, y }) => {
  const bv = extractionBrowserView;
  if (!bv) return false;
  try { bv.setBounds({ x: Math.max(0, x || 0), y: Math.max(0, y || 0), width: Math.max(80, width || 100), height: Math.max(80, height || 100) }); return true; } catch (e) { return false; }
});
ipcMain.handle('extraction-browser-control', (event, { action }) => {
  const bv = extractionBrowserView;
  if (!bv) return false;
  try {
    if (action === 'back') { if (bv.webContents.canGoBack()) bv.webContents.goBack(); }
    else if (action === 'forward') { if (bv.webContents.canGoForward()) bv.webContents.goForward(); }
    else if (action === 'reload') bv.webContents.reload();
    else if (action === 'stop') bv.webContents.stop();
    else if (action === 'home') bv.webContents.loadURL('about:blank');
    return true;
  } catch (e) { return false; }
});

// 应用菜单:File 提供「添加链接 / 打开引导式提取」;保留标准 Edit(否则输入框 Cmd+C/V 失效)
function buildAppMenu() {
  const tpl = [
    { label: app.name, submenu: [ { role: 'about' }, { type: 'separator' }, { role: 'services' }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' } ] },
    { label: 'File', submenu: [
      { label: '添加链接…', accelerator: 'CmdOrCtrl+N', click: () => { if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); mainWindow.webContents.send('menu-add-link'); } } },
      { label: '打开引导式提取', accelerator: 'CmdOrCtrl+E', click: () => openExtractionWindow() },
      { type: 'separator' },
      { role: 'close' }
    ] },
    { label: 'Edit', submenu: [ { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' } ] },
    { label: 'View', submenu: [ { role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' } ] },
    { label: 'Window', submenu: [ { role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' } ] },
    { label: 'Help', submenu: [ { label: '官方网站', click: () => shell.openExternal('https://biodown.ye.aimeals.cn/') } ] }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

// 取内置浏览器分区会话里某 URL 的 Cookie 串
async function cookiesForUrl(url) {
  try {
    const list = await getBrowserSession().cookies.get({ url });
    return (list || []).map((c) => `${c.name}=${c.value}`).join('; ');
  } catch (e) { return ''; }
}

// 通用流式下载(带 Cookie/请求头 + 断点续传),进度经 extraction-event 回传
async function streamDownloadToDisk({ id, url, name, headers, cookie, saveDir, sizeHint }) {
  const dir = saveDir || app.getPath('downloads');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const reqHeaders = Object.assign({}, headers || {});
  if (cookie) reqHeaders['Cookie'] = cookie;
  if (!reqHeaders['User-Agent']) reqHeaders['User-Agent'] = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

  let finalName = sanitizePathSegment(name || fileNameFromUrl(url)) || ('download_' + Date.now());
  let savePath = path.join(dir, finalName);
  // 断点续传:已有部分文件则从断点续传
  let start = 0;
  try { const st = fs.statSync(savePath); if (st && st.size > 0) start = st.size; } catch (e) {}
  if (start > 0) reqHeaders['Range'] = 'bytes=' + start + '-';

  sendExtraction({ type: 'download', id, status: 'progress', percentage: 0, speed: '连接中…' });
  // 与主下载器一致:加速器开启且目标为境外站时走 mihomo 代理(否则直连,境外数据会被限速到几十 KB/s)
  const proxy = shouldUseProxy(url) && clashProcess
    ? { protocol: 'http', host: '127.0.0.1', port: 43289 }
    : false;
  // 暂停支持:注册中止控制器,暂停时中断流但保留已下载部分(下次经 Range 断点续传)
  const ac = new AbortController();
  extractionAborters.set(id, ac);
  let response;
  try {
    response = await axios({ url, method: 'GET', headers: reqHeaders, responseType: 'stream', maxRedirects: 8, timeout: 30 * 60 * 1000, validateStatus: () => true, proxy, signal: ac.signal });
  } catch (err) {
    extractionAborters.delete(id);
    if (err && err.name === 'CanceledError') {
      if (extractionCancelled.has(id)) {
        // 用户取消:删除未完成的部分文件,抛出取消标记(渲染层移除卡片,不进失败列表)
        try { if (fs.existsSync(savePath)) fs.unlinkSync(savePath); } catch (e) {}
        const e = new Error('CANCELLED');
        e.isCancelled = true;
        throw e;
      }
      // 用户暂停:保留已下载部分,抛出明确标记(渲染层把状态置为"已暂停")
      const e = new Error('PAUSED');
      e.isPaused = true;
      throw e;
    }
    throw err;
  }
  if (response.status >= 400) { extractionAborters.delete(id); throw new Error(`服务器返回 HTTP ${response.status}(链接无效或会话已失效)`); }

  const resumed = (start > 0 && response.status === 206); // 服务器支持断点
  if (!resumed) start = 0;                                // 否则从头覆盖

  // 文件名:Content-Disposition 优先(仅当调用方未显式命名)
  if (!name) {
    const cd = String(response.headers['content-disposition'] || '');
    const mcd = cd.match(/filename\*?=(?:UTF-8''|")?([^";]+)"?/i) || cd.match(/filename="?([^";]+)"?/i);
    if (mcd) { try { finalName = sanitizePathSegment(decodeURIComponent(mcd[1].trim())) || finalName; } catch (e) {} savePath = path.join(dir, finalName); }
  }

  const contentRange = String(response.headers['content-range'] || '');
  const crTotal = contentRange.match(/\/(\d+)\s*$/);
  const total = (crTotal ? parseInt(crTotal[1], 10) : (parseInt(response.headers['content-length'] || '0', 10) + start)) || (sizeHint || 0);

  const writer = fs.createWriteStream(savePath, { flags: resumed ? 'a' : 'w' });
  return await new Promise((resolve, reject) => {
    let downloaded = start, lastB = start, timer = null, firstChunk = true, done = false;
    const finish = (err) => {
      if (done) return; done = true;
      if (timer) clearInterval(timer);
      extractionAborters.delete(id); // 结束即注销,避免内存泄漏
      try { writer.destroy(); } catch (e) {}
      if (err) {
        sendExtraction({ type: 'download', id, status: 'failed', message: err.message });
        reject(err);
      } else {
        sendExtraction({ type: 'download', id, status: 'completed', name: finalName, savePath, size: downloaded });
        resolve({ success: true, savePath, name: finalName, size: downloaded });
      }
    };
    writer.on('error', finish);
    response.data.on('error', finish);
    timer = setInterval(() => {
      const diff = downloaded - lastB; lastB = downloaded;
      const bps = diff / 0.5;
      const speedStr = bps > 1048576 ? (bps / 1048576).toFixed(2) + ' MB/s' : bps > 1024 ? (bps / 1024).toFixed(1) + ' KB/s' : Math.round(bps) + ' B/s';
      const pct = total > 0 ? Math.min(99, Math.floor(downloaded / total * 100)) : null;
      // received/total/speedBps 为数值字段,供渲染层计算剩余时间(ETA)
      sendExtraction({ type: 'download', id, status: 'progress', percentage: pct, received: downloaded, total, speedBps: Math.round(bps), speed: speedStr });
    }, 500);
    response.data.on('data', (chunk) => {
      downloaded += chunk.length;
      if (firstChunk) {
        firstChunk = false;
        const head = chunk.slice(0, 1024).toString('utf8').trimStart().toLowerCase();
        if ((head.startsWith('<!doctype html') || head.startsWith('<html')) && !/\.(html?|xhtml)$/i.test(finalName)) {
          return finish(new Error('服务器返回网页(错误页/会话失效),非可下载文件。请刷新页面或重新获取链接。'));
        }
      }
    });
    response.data.pipe(writer);
    writer.on('finish', () => {
      if (total > 0 && downloaded < total) return finish(new Error(`下载不完整 ${downloaded}/${total} 字节,请重试(支持断点续传)`));
      finish(null);
    });
  });
}

// 统一入口:把一个资源(拦截/嗅探点击/代码框解析)交给下载引擎,并回传传输列表
async function runExtractionDownload({ url, name, headers, cookie, saveDir, size }, jobTitle) {
  const id = 'ex' + (extractionJobSeq++);
  const dir = saveDir || app.getPath('downloads');
  const cookieStr = cookie || (await cookiesForUrl(url));
  sendExtraction({ type: 'download', id, status: 'started', url, name: name || fileNameFromUrl(url), size: size || 0, title: jobTitle || '' });
  try {
    // NCBI 会话式链接 → efetch 分页下载(逐页重试 + 记录数完整性校验)
    if (isSessionBoundNcbiLink(url) && queryParam(url, 'query_key') && extractCookieValue(cookieStr, 'WebEnv')) {
      const parsed = { url, method: 'GET', headers: headers || [], cookie: cookieStr, data: null };
      const send2 = (d) => sendExtraction(Object.assign({ type: 'download', id }, d));
      return await downloadNcbiPaginated(parsed, dir, send2, () => extractionCancelled.has(id));
    }
    return await streamDownloadToDisk({ id, url, name, headers: headers || {}, cookie: cookieStr, saveDir: dir, sizeHint: size || 0 });
  } catch (e) {
    if (e && e.isCancelled) {
      extractionCancelled.delete(id);
      sendExtraction({ type: 'download', id, status: 'cancelled' });
      return { success: false, cancelled: true };
    }
    sendExtraction({ type: 'download', id, status: 'failed', message: e.message });
    return { success: false, error: e.message };
  }
}

// Broad singlecell「curl -K 配置」批量下载(含断点续传)
async function downloadBroadConfig(code, saveDir) {
  const dir = saveDir || app.getPath('downloads');
  // 1) 取出 generate_curl_config 链接
  const m = String(code).match(/https?:\/\/[^\s"']+generate_curl_config[^\s"']*/i);
  if (!m) throw new Error('未识别到 generate_curl_config 链接,请粘贴完整的 Broad 下载代码。');
  const configUrl = m[0].replace(/["']+$/, '');
  const cookie = await cookiesForUrl(configUrl);
  sendExtraction({ type: 'log', message: '正在获取 Broad 下载配置…' });
  const cfgResp = await axios.get(configUrl, { headers: cookie ? { Cookie: cookie } : {}, timeout: 60000, validateStatus: () => true, maxRedirects: 5 });
  if (cfgResp.status === 401 || cfgResp.status === 403) throw new Error('auth_code 已过期或无效:请回到网页重新点 Download,重新复制代码。');
  if (cfgResp.status >= 400) throw new Error('获取配置失败 HTTP ' + cfgResp.status);
  const cfgText = typeof cfgResp.data === 'string' ? cfgResp.data : String(cfgResp.data || '');
  // 2) 解析 curl -K 配置:成对的 url="..." 与 output/-o "..."
  const lines = cfgText.split(/\r?\n/);
  const jobs = [];
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const mu = line.match(/^(?:-{1,2}url|url)\s*=?\s*"?([^"\s]+)"?/i) || (/^https?:\/\//i.test(line) ? [null, line.replace(/^"?|"?$/g, '')] : null);
    if (mu) { if (cur) jobs.push(cur); cur = { url: mu[1].trim(), name: '' }; continue; }
    const mo = line.match(/^(?:-{1,2}output|output|-o)\s*=?\s*"?([^"\s]+)"?/i);
    if (mo && cur) cur.name = mo[1].trim();
  }
  if (cur) jobs.push(cur);
  if (!jobs.length) throw new Error('配置里未解析到任何下载条目。');
  sendExtraction({ type: 'log', message: `Broad 配置解析到 ${jobs.length} 个文件,开始下载…` });
  // 3) 逐个下载(各自断点续传);单个失败不中断整批,auth 过期则提前终止
  const results = [];
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    const id = 'ex' + (extractionJobSeq++);
    const nm = j.name || fileNameFromUrl(j.url);
    sendExtraction({ type: 'download', id, status: 'started', url: j.url, name: nm, size: 0, title: `Broad ${i + 1}/${jobs.length}` });
    try {
      results.push(await streamDownloadToDisk({ id, url: j.url, name: nm, headers: {}, cookie, saveDir: dir, sizeHint: 0 }));
    } catch (e) {
      results.push({ success: false, name: nm, error: e.message });
      if (/HTTP (401|403)/.test(e.message)) throw new Error('auth_code 已过期:请回到网页重新点 Download 并重新复制代码。');
    }
  }
  return { success: true, count: results.filter((r) => r && r.success).length, total: jobs.length, results };
}

// 初始化:分区会话 + 下载拦截 + 资源嗅探
function setupExtractionBrowser() {
  if (browserSessionReady) return;
  browserSessionReady = true;
  const bs = getBrowserSession();

  bs.setPermissionRequestHandler((wc, permission, callback) => callback(true));

  // 初始化内置浏览器代理(随加速器状态在 clash-start/stop 中刷新)
  setExtractionProxy();

  // 下载拦截:取消 Electron 原生保存,改用本程序下载引擎(多线程/断点/进传输列表)
  // 下载拦截(2.0.10):不再取消+重放,而是用 Electron 原生下载引擎接管同一请求。
  // 关键:网页里的签名直链(如 Box zip_download)是一次性 token,若 cancel 后用 axios 重放会失效 → 必失败。
  // 原生 item 继续用浏览器那次有效请求,天然带上 cookie/签名;进度/暂停/恢复走原生 API。
  bs.on('will-download', (event, item) => {
    const url = item.getURL();
    const name = item.getFilename() || fileNameFromUrl(url);
    const size = (item.getTotalBytes && item.getTotalBytes()) || 0;
    // 不 preventDefault —— 让原生下载继续,但我们接管保存路径与状态上报
    const id = 'ex' + (extractionJobSeq++);
    const saved = getSettings() || {};
    const saveDir = saved.defaultDir || app.getPath('downloads');
    const savePath = path.join(saveDir, sanitizePathSegment(name) || ('download_' + Date.now()));
    try { item.setSavePath(savePath); } catch (e) { writeClashLog('[will-download] setSavePath err: ' + e.message); }
    sendExtraction({ type: 'download', id, status: 'started', url, name, size, title: '网页拦截' });

    item.on('updated', () => {
      try {
        const recv = item.getReceivedBytes();
        const total = item.getTotalBytes() || size || 0;
        const pct = total > 0 ? Math.min(99, Math.floor(recv / total * 100)) : null;
        const speed = (item.getCurrentSpeed && item.getCurrentSpeed()) || 0;
        const speedStr = speed > 1048576 ? (speed / 1048576).toFixed(2) + ' MB/s' : speed > 1024 ? (speed / 1024).toFixed(1) + ' KB/s' : Math.round(speed) + ' B/s';
        // received/total/speedBps 为数值字段,供渲染层计算剩余时间(ETA)
        sendExtraction({ type: 'download', id, status: 'progress', percentage: pct, received: recv, total, speedBps: Math.round(speed), speed: speedStr });
      } catch (e) {}
    });
    item.once('done', (e, state) => {
      try {
        if (state === 'completed') {
          sendExtraction({ type: 'download', id, status: 'completed', name: item.getFilename() || name, savePath, size: item.getReceivedBytes() });
        } else if (state === 'cancelled' || extractionCancelled.has(id)) {
          // 用户主动取消:回传 cancelled,渲染层直接移除卡片(不进失败列表)
          extractionCancelled.delete(id);
          sendExtraction({ type: 'download', id, status: 'cancelled' });
        } else {
          sendExtraction({ type: 'download', id, status: 'failed', message: state === 'interrupted' ? '下载中断(可重试续传)' : '下载失败' });
        }
      } catch (err) {}
    });
    extractionNativeDownloads.set(id, item);
    item.once('done', () => extractionNativeDownloads.delete(id));
  });

  // 资源嗅探:按类型/站点分类后回传侧边栏(重要资源加粗红字置顶)
  const seen = new Set();
  bs.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    try {
      const rt = details.resourceType;
      const url = details.url;
      const cls = classifyResource(url);
      const isMedia = (rt === 'image' || rt === 'media');
      // 通用"文件样"URL(带扩展名)
      const looksFile = /\.(gz|zip|tar|fastq|fq|fasta|fa|gb|gff|csv|tsv|txt|h5|h5ad|loom|bam|cram|sra|pdf|mp4|png|jpe?g)(\?|$)/i.test(url);
      // 常见网盘/分享站的"直链/签名下载"导航(如 Box zip_download、带 download/authcode/hmac 的链接)
      const looksDownloadNav = /zip_download|dl\.boxcloud|\/download|authcode|hmac|auth_code|download=1|response-content-disposition|alt=media|download\.box/i.test(url);
      // 子资源一律按原有规则;mainFrame/subFrame 仅当它是"文件样/下载样"导航才收录(否则是普通网页跳转,不嗅探)
      const isNav = (rt === 'mainFrame' || rt === 'subFrame');
      if (!isNav && (isMedia || cls.important || looksFile)) {
        const key = url.slice(0, 300);
        if (!seen.has(key) && seen.size < 2000) {
          seen.add(key);
          sendExtraction({ type: 'resource', url, resourceType: rt, important: cls.important, site: cls.site, label: cls.label, name: fileNameFromUrl(url) });
        }
      } else if (isNav && (looksFile || looksDownloadNav)) {
        // 文件/直链导航:收进嗅探列表(点击即下),但 webview 仍正常跳转,由用户选择
        const key = url.slice(0, 300);
        if (!seen.has(key) && seen.size < 2000) {
          seen.add(key);
          sendExtraction({ type: 'resource', url, resourceType: 'download-link', important: true, site: cls.site, label: '直链下载', name: fileNameFromUrl(url) });
        }
      }
    } catch (e) {}
    callback({});
  });
}

// ---- 引导式提取 IPC ----
ipcMain.handle('open-extraction', () => { openExtractionWindow(); return true; });
ipcMain.handle('extraction-sync-proxy', () => { setExtractionProxy(); return true; });
ipcMain.handle('extraction-pause', (event, { id }) => {
  // 原生下载引擎拦截的 → 原生暂停/恢复
  const item = extractionNativeDownloads.get(id);
  if (item) {
    try {
      if (item.isPaused()) item.resume();
      else item.pause();
      return { success: true, paused: item.isPaused() };
    } catch (e) { return { success: false, error: e.message }; }
  }
  // axios 流式下载的 → 中断流(保留断点)
  const ac = extractionAborters.get(id);
  if (!ac) return { success: false, error: 'no active download' };
  ac.abort();
  return { success: true };
});
ipcMain.handle('extraction-cancel', (event, { id }) => {
  // 取消提取下载任务:原生下载走 item.cancel();axios/NCBI 走 abort/标记。未完成的部分文件一并删除
  extractionCancelled.add(id);
  const item = extractionNativeDownloads.get(id);
  if (item) {
    let savePath = '';
    try { savePath = item.getSavePath(); } catch (e) {}
    try { item.cancel(); } catch (e) {}
    try { if (savePath && fs.existsSync(savePath)) fs.unlinkSync(savePath); } catch (e) {}
    extractionNativeDownloads.delete(id);
    return { success: true };
  }
  const ac = extractionAborters.get(id);
  if (ac) {
    try { ac.abort(); } catch (e) {}
    return { success: true };
  }
  // NCBI 分页下载无 AbortController:标记位会在每页循环开头被检查;这里不删除标记,由任务结束时清理
  return { success: true };
});
ipcMain.handle('extraction-download', async (event, { url, name, headers, cookie, saveDir, size }) => {
  return await runExtractionDownload({ url, name, headers: headers || {}, cookie, saveDir, size }, '嗅探下载');
});
ipcMain.handle('extraction-run-code', async (event, { code, saveDir }) => {
  const dir = saveDir || app.getPath('downloads');
  try {
    if (/generate_curl_config|bulk_download/i.test(code)) {
      const r = await downloadBroadConfig(code, dir);
      sendExtraction({ type: 'log', message: `Broad 批量下载完成 ${r.count}/${r.total}` });
      return { success: true, mode: 'broad', count: r.count, total: r.total };
    }
    // 否则按 cURL 解析(自动识别 NCBI 会话链接 → efetch 分页)
    const parsed = parseCurlCommand(code);
    const r = await runExtractionDownload({ url: parsed.url, headers: parsed.headers, cookie: parsed.cookie, saveDir: dir }, '代码框');
    return { success: !!(r && r.success), mode: 'curl' };
  } catch (e) {
    sendExtraction({ type: 'log', message: '代码框执行失败:' + e.message });
    return { success: false, error: e.message };
  }
});
ipcMain.handle('extraction-cookies-for', async (event, { url }) => ({ cookie: await cookiesForUrl(url) }));
ipcMain.handle('extraction-clear-session', async () => {
  try { await getBrowserSession().clearStorageData(); return { success: true }; } catch (e) { return { success: false, error: e.message }; }
});

// ==========================================
// 【诊断测速与日志管理 IPC 接口 (v1.4.5)】
// ==========================================

// 测试连通性与节点测速
ipcMain.handle('test-node-connection', async () => {
  const testUrl = 'https://www.ncbi.nlm.nih.gov/';
  
  // 1. 代理诊断
  let proxyOk = false;
  let proxyTime = 0;
  try {
    const start = Date.now();
    await axios.get(testUrl, {
      timeout: 5000,
      proxy: { protocol: 'http', host: '127.0.0.1', port: 43289 }
    });
    proxyTime = Date.now() - start;
    proxyOk = true;
  } catch (e) {
    console.warn('Proxy node diagnostics failed:', e.message);
  }

  // 2. 直连诊断
  let directOk = false;
  let directTime = 0;
  try {
    const start = Date.now();
    await axios.get(testUrl, { timeout: 5000 });
    directTime = Date.now() - start;
    directOk = true;
  } catch (e) {
    console.warn('Direct connection diagnostics failed:', e.message);
  }

  return {
    proxy: { ok: proxyOk, time: proxyTime },
    direct: { ok: directOk, time: directTime }
  };
});

// 获取本地诊断日志列表
ipcMain.handle('get-logs-list', async () => {
  try {
    if (!fs.existsSync(LOG_DIR)) return [];
    const files = fs.readdirSync(LOG_DIR);
    const logs = [];
    files.forEach(file => {
      if (!file.endsWith('.log')) return;
      const filePath = path.join(LOG_DIR, file);
      const stats = fs.statSync(filePath);
      logs.push({
        name: file,
        size: stats.size,
        time: stats.mtimeMs
      });
    });
    // 按修改时间倒序
    logs.sort((a, b) => b.time - a.time);
    return logs;
  } catch (err) {
    console.error('Failed to get logs list:', err);
    return [];
  }
});

// 读取特定的日志内容
ipcMain.handle('read-log-content', async (event, filename) => {
  try {
    const safeName = path.basename(filename);
    const filePath = path.join(LOG_DIR, safeName);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf8');
    }
    return '';
  } catch (err) {
    console.error('Failed to read log content:', err);
    return '';
  }
});

// 删除特定的本地日志
ipcMain.handle('delete-log', async (event, filename) => {
  try {
    const safeName = path.basename(filename);
    const filePath = path.join(LOG_DIR, safeName);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return true;
    }
    return false;
  } catch (err) {
    console.error('Failed to delete log file:', err);
    return false;
  }
});

// 上传日志到数据库
ipcMain.handle('upload-log-content', async (event, { token, filename, content }) => {
  try {
    const res = await axios.post(`${BACKEND_BASE_URL}/api/user/upload-log`, {
      token,
      filename,
      content
    }, { timeout: 10000 });
    return res.data;
  } catch (err) {
    console.error('Failed to upload log to server:', err.message);
    return { success: false, error: err.response?.data?.error || err.message };
  }
});
