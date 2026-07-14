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
      { src: path.join(BIN_DIR, 'win32', 'cygwin1.dll'), dest: 'cygwin1.dll' },
      { src: path.join(BIN_DIR, 'win32', 'mihomo_windows_x86_64.exe'), dest: 'mihomo_windows_x86_64.exe' }
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
// 【本地配置管理】
// ==========================================
const SETTINGS_FILE = path.join(app.getPath('userData'), 'settings.json');

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
      nodeIntegration: false
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

app.whenReady().then(() => {
  ensureBinaries();
  ensureClashDataFiles();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopClash();
  if (currentAxelProcess) {
    console.log('Terminating Axel process...');
    killProcess(currentAxelProcess);
    currentAxelProcess = null;
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopClash();
  if (currentAxelProcess) {
    console.log('Terminating Axel process...');
    killProcess(currentAxelProcess);
    currentAxelProcess = null;
  }
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
ipcMain.handle('api-register', async (event, { username, password, email }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/register`, { username, password, email });
  return res.data;
});

ipcMain.handle('api-login', async (event, { username, password }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/login`, { username, password });
  return res.data;
});

ipcMain.handle('api-get-user-info', async (event, { token }) => {
  const res = await axios.get(`${BACKEND_BASE_URL}/api/user/info?token=${token}`);
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

ipcMain.handle('api-create-order', async (event, { token, packageId, payType }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/pay/create`, { token, packageId, payType });
  return res.data;
});

ipcMain.handle('api-mock-confirm', async (event, { orderId }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/pay/mock-confirm`, { orderId });
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

// --- 自动更新与外部链接 ---
ipcMain.handle('check-for-updates', async () => {
  try {
    const res = await axios.get(`${BACKEND_BASE_URL}/api/client/version`, { timeout: 5000 });
    const currentVersion = app.getVersion();
    const latestVersion = res.data.version;
    
    // 简易版本对比：比较版本字符串
    const hasUpdate = latestVersion !== currentVersion;
    
    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate,
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

// --- 下载调度引擎 ---
ipcMain.handle('start-download', async (event, { files, targetDir, token }) => {
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // 1. 验证目标磁盘可用空间
  try {
    const totalRequiredSpace = files.reduce((acc, f) => acc + (f.size || 0), 0);
    const stats = await fs.promises.statfs(targetDir);
    const freeSpace = stats.bavail * stats.bsize; // 针对普通用户可用的空闲块字节数
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

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const fileIndex = file.originalIndex !== undefined ? file.originalIndex : i;
    const fileDestFolder = file.folder ? path.join(targetDir, file.folder) : targetDir;
    
    if (!fs.existsSync(fileDestFolder)) {
      fs.mkdirSync(fileDestFolder, { recursive: true });
    }

    const savePath = path.join(fileDestFolder, file.name);

    let attempt = 0;
    let downloadSuccess = false;
    let lastErrorMsg = '';

    while (attempt < MAX_RETRIES && !downloadSuccess) {
      attempt++;

      if (attempt > 1) {
        // 指数退避重试延迟
        const backoffTime = Math.pow(2, attempt) * 1000;
        console.log(`Retrying download for ${file.name} in ${backoffTime}ms (Attempt ${attempt}/${MAX_RETRIES})`);
        mainWindow.webContents.send('download-status', {
          index: fileIndex,
          fileName: file.name,
          status: 'downloading',
          percentage: null,
          speed: `网络波动重试中 (${attempt}/${MAX_RETRIES})...`
        });
        await new Promise(resolve => setTimeout(resolve, backoffTime));
      }

      // 仅在首次尝试且无断点 st 文件时，清理上一次被破坏的废件
      if (attempt === 1 && fs.existsSync(savePath) && !fs.existsSync(savePath + '.st')) {
        fs.unlinkSync(savePath);
      }

      // 告知前端当前正在下载/重试第几个文件
      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: 'downloading',
        percentage: 0,
        speed: '正在高速下载...'
      });

      // 组装 Axel 环境变量 (强制走本地 Clash 代理端口 43289)
      const env = {
        ...process.env,
        http_proxy: 'http://127.0.0.1:43289',
        https_proxy: 'http://127.0.0.1:43289',
        all_proxy: 'http://127.0.0.1:43289'
      };
      // 默认使用 16 线程，小文件限制较低线程数以防触发 NCBI/EBI 速率控制屏蔽
      let threads = 16;
      if (file.size) {
        if (file.size < 500 * 1024) { // < 500 KB
          threads = 1;
        } else if (file.size < 5 * 1024 * 1024) { // < 5 MB
          threads = 4;
        } else if (file.size < 50 * 1024 * 1024) { // < 50 MB
          threads = 8;
        }
      }

      const args = ['-n', threads.toString(), '-k', '-o', savePath, file.url];
      console.log(`Running Axel (Attempt ${attempt}): ${axelBin} ${args.join(' ')}`);

      try {
        await new Promise((resolve, reject) => {
          currentAxelProcess = spawn(axelBin, args, { env });

          currentAxelProcess.on('error', (err) => {
            console.error('Axel spawn error:', err);
            currentAxelProcess = null;
            reject(err);
          });

          currentAxelProcess.stdout.on('data', (data) => {
            const output = data.toString();
            
            // 解析进度百分比
            const pctMatch = output.match(/\[\s*(\d+)%\]/);
            // 解析下载速度
            const speedMatch = output.match(/\[\s*([\d\.]+\s*[KMGT]*B\/s)\]/);

            let percentage = pctMatch ? parseInt(pctMatch[1]) : null;
            let speed = speedMatch ? speedMatch[1] : null;

            if (percentage !== null || speed !== null) {
              mainWindow.webContents.send('download-progress', {
                index: fileIndex,
                percentage,
                speed
              });
            }
          });

          currentAxelProcess.stderr.on('data', (data) => {
            console.error(`[Axel Error] ${data}`);
          });

          currentAxelProcess.on('close', (code) => {
            currentAxelProcess = null;
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
      }
    }

    if (downloadSuccess) {
      // 下载成功，上报流量消耗到后端
      try {
        console.log(`Download success. Reporting consumed bytes: ${file.size}`);
        await axios.post(`${BACKEND_BASE_URL}/api/user/consume`, {
          token,
          bytes: file.size
        });
      } catch (e) {
        console.error('Failed to report traffic consume:', e.message);
      }

      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: 'completed',
        percentage: 100,
        speed: '已保存'
      });
    } else {
      mainWindow.webContents.send('download-status', {
        index: fileIndex,
        fileName: file.name,
        status: 'failed',
        percentage: 0,
        speed: '下载失败'
      });
      throw new Error(`文件 ${file.name} 下载在重试 ${MAX_RETRIES} 次后均失败: ${lastErrorMsg}`);
    }
  }

  return { success: true };
});

ipcMain.handle('cancel-download', () => {
  if (currentAxelProcess) {
    killProcess(currentAxelProcess);
    currentAxelProcess = null;
    return true;
  }
  return false;
});
