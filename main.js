const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const os = require('os');
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
let BACKEND_BASE_URL = 'http://localhost:13000';

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
let clashProcess = null;
let currentAxelProcess = null;
const activeAxelProcesses = new Map();

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
      backgroundThrottling: true
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
      console.log('Found pending update.asar, applying now on startup...');
      const backupAsar = path.join(process.resourcesPath, 'app.asar.old');
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
      if (fs.existsSync(targetAsar)) fs.renameSync(targetAsar, backupAsar);
      fs.renameSync(updateAsar, targetAsar);
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
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

async function startClash(token) {
  if (clashProcess) {
    console.log('Clash is already running.');
    return true;
  }

  // 1. 强制清理残留后台 Clash 进程，释放加速端口
  await killExistingClashProcesses();

  // 2. 检测 43289 端口是否被占用
  const isPortBusy = await checkPortBusy(43289);
  if (isPortBusy) {
    throw new Error('下载加速器启动失败：加速端口冲突，请关闭其他代理/加速器软件或重启电脑后重试。');
  }

  try {
    console.log('Fetching clash configuration for token:', token);
    const subUrl = `${BACKEND_BASE_URL}/speedup?token=${token}`;
    const response = await axios.get(subUrl, { timeout: 10000 });
    
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

    // 保存 config.yaml 到用户工作空间
    const configPath = path.join(CLASH_WORK_DIR, 'config.yaml');
    fs.writeFileSync(configPath, yamlContent, 'utf8');

    const binaryPath = getClashBinaryPath();
    ensureExecutable(binaryPath);

    console.log(`Spawning Clash from ${binaryPath} with config at ${CLASH_WORK_DIR}`);
    
    let spawnError = null;
    clashProcess = spawn(binaryPath, ['-d', CLASH_WORK_DIR]);

    clashProcess.on('error', (err) => {
      console.error('Clash spawn error:', err);
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
    throw new Error('下载加速器启动失败: ' + err.message);
  }
}

function stopClash() {
  if (clashProcess) {
    console.log('Terminating Clash process...');
    killProcess(clashProcess);
    clashProcess = null;
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
async function headRequestSize(url) {
  try {
    // 默认通过 Clash 代理进行 HEAD 检测以确保可达并返回准确体积
    const response = await axios.head(url, {
      timeout: 10000,
      proxy: {
        protocol: 'http',
        host: '127.0.0.1',
        port: 43289
      }
    });
    if (response.headers['content-length']) {
      return parseInt(response.headers['content-length']);
    }
  } catch (e) {
    // 如果代理未启动，尝试直连
    try {
      const directRes = await axios.head(url, { timeout: 8000 });
      if (directRes.headers['content-length']) {
        return parseInt(directRes.headers['content-length']);
      }
    } catch (err) {}
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
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/register`, { username, password, email, inviteCode });
  return res.data;
});

ipcMain.handle('api-login', async (event, { username, password }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/login`, { username, password });
  return res.data;
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

// --- Clash 控制 ---
ipcMain.handle('clash-start', async (event, { token }) => {
  return await startClash(token);
});

ipcMain.handle('clash-stop', () => {
  stopClash();
  return true;
});

ipcMain.handle('clash-optimize', async (event, { token }) => {
  return await optimizeClash(token);
});

async function applyHotPatch(patchUrl) {
  if (!patchUrl) {
    throw new Error('未提供有效热更新补丁地址');
  }

  const tempPatchPath = path.join(app.getPath('userData'), 'patch_download.tmp');
  const fullUrl = patchUrl.startsWith('http') ? patchUrl : `${BACKEND_BASE_URL}${patchUrl}`;
  
  console.log('Downloading hot patch from:', fullUrl);
  const response = await axios({
    url: fullUrl,
    method: 'GET',
    responseType: 'stream',
    timeout: 30000
  });

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

  const targetAsar = path.join(process.resourcesPath, 'app.asar');
  let successDirect = false;

  try {
    if (fs.existsSync(targetAsar)) {
      const backupAsar = path.join(process.resourcesPath, 'app.asar.old');
      try { if (fs.existsSync(backupAsar)) fs.unlinkSync(backupAsar); } catch(e){}
      fs.renameSync(targetAsar, backupAsar);
      fs.renameSync(tempPatchPath, targetAsar);
      try { if (fs.unlinkSync(backupAsar)); } catch(e){}
      successDirect = true;
    }
  } catch (err) {
    console.warn('Direct replace app.asar failed, staging update.asar for next launch:', err.message);
    const updateAsar = path.join(process.resourcesPath, 'update.asar');
    fs.copyFileSync(tempPatchPath, updateAsar);
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
ipcMain.handle('check-for-updates', async () => {
  try {
    let res;
    // 优先尝试走 Clash 代理
    if (clashProcess) {
      try {
        console.log('Attempting check-for-updates via Clash proxy...');
        res = await axios.get(`${BACKEND_BASE_URL}/api/client/version`, {
          timeout: 3000,
          proxy: { protocol: 'http', host: '127.0.0.1', port: 43289 }
        });
      } catch (proxyErr) {
        console.warn(`Version check via proxy failed: ${proxyErr.message}, falling back to direct connection`);
      }
    }
    
    // 代理不通或未开启时，走直连
    if (!res) {
      res = await axios.get(`${BACKEND_BASE_URL}/api/client/version`, { timeout: 4000 });
    }
    const currentVersion = app.getVersion();
    const latestVersion = res.data.version;
    
    // 简易版本对比：比较版本字符串
    const hasUpdate = latestVersion !== currentVersion;
    
    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate,
      patchUrl: res.data.patchUrl ? (res.data.patchUrl.startsWith('http') ? res.data.patchUrl : `${BACKEND_BASE_URL}${res.data.patchUrl}`) : null,
      winUrl: `${BACKEND_BASE_URL}${res.data.winUrl}`,
      macUrl: `${BACKEND_BASE_URL}${res.data.macUrl}`,
      releaseNotes: res.data.releaseNotes
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

  // 组装 Axel 代理环境变量 (若 Clash 启动则走代理)
  const env = { ...process.env };
  if (clashProcess) {
    env.http_proxy = 'http://127.0.0.1:43289';
    env.https_proxy = 'http://127.0.0.1:43289';
    env.all_proxy = 'http://127.0.0.1:43289';
  }

  const args = ['-n', '16', '-k', '-o', savePath, url];
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
  } else if (type === 'links') {
    const promises = ids.map(async (link) => {
      const size = await headRequestSize(link);
      const name = link.substring(link.lastIndexOf('/') + 1) || 'file_' + Date.now();
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
    
    let fileDestFolder;
    if (file.isUpdate) {
      fileDestFolder = app.getPath('downloads');
    } else {
      fileDestFolder = file.folder ? path.join(targetDir, file.folder) : targetDir;
    }
    
    if (!fs.existsSync(fileDestFolder)) {
      fs.mkdirSync(fileDestFolder, { recursive: true });
    }

    const savePath = path.join(fileDestFolder, file.name);

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
        }
      }

      const args = ['-n', threads.toString(), '-k', '-o', savePath, file.url];
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
                mainWindow.webContents.send('download-progress', {
                  index: fileIndex,
                  percentage,
                  speed
                });
              }
            }
          });

          proc.stderr.on('data', (data) => {
            const output = data.toString();
            if (logStream) {
              logStream.write(`[STDERR] ${output}`);
            }
          });

          proc.on('close', (code) => {
            activeAxelProcesses.delete(fileIndex);
            if (logStream) {
              logStream.write(`\n=== 进程退出 ===\n状态码: ${code}\n`);
              logStream.end();
            }
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`退出状态码: ${code}`));
            }
          });
        });

        downloadSuccess = true;
      } catch (err) {
        lastErrorMsg = err.message;
        console.warn(`Attempt ${attempt} for ${file.name} failed: ${lastErrorMsg}`);
        if (lastErrorMsg === 'Cancelled') {
          break; // 被取消时立即中断重试循环
        }
      }
    }

    cancelTokens.delete(fileIndex);

    if (downloadSuccess) {
      if (!file.isUpdate) {
        try {
          console.log(`Download success. Reporting consumed bytes: ${file.size}`);
          await axios.post(`${BACKEND_BASE_URL}/api/user/consume`, {
            token,
            bytes: file.size
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
      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: lastErrorMsg === 'Cancelled' ? 'cancelled' : 'failed',
        percentage: 0,
        speed: lastErrorMsg === 'Cancelled' ? '已取消' : '下载失败'
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
    const proc = activeAxelProcesses.get(fileIndex);
    if (proc) {
      console.log(`Cancelling single task at index: ${fileIndex}`);
      killProcess(proc);
      activeAxelProcesses.delete(fileIndex);
      return true;
    }
  } else {
    console.log('Cancelling all active downloads...');
    killAllAxelProcesses();
    return true;
  }
  return false;
});

ipcMain.handle('open-downloads-folder', (event, folderPath) => {
  if (folderPath && fs.existsSync(folderPath)) {
    shell.openPath(folderPath);
    return true;
  }
  return false;
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
