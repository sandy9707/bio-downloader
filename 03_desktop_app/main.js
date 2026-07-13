const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const cheerio = require('cheerio');
const os = require('os');

const BACKEND_BASE_URL = 'http://107.175.142.245:13000';

let mainWindow;
let clashProcess = null;
let currentAxelProcess = null;

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

// 获取 Clash 执行路径
function getClashBinaryPath() {
  const platform = os.platform();
  const arch = os.arch();
  
  if (platform === 'darwin') {
    return arch === 'arm64' 
      ? path.join(BIN_DIR, 'darwin', 'mihomo_aarch64')
      : path.join(BIN_DIR, 'darwin', 'mihomo_x86_64');
  } else if (platform === 'win32') {
    return path.join(BIN_DIR, 'win32', 'mihomo_windows_x86_64.exe');
  }
  throw new Error('不支持的操作系统平台: ' + platform);
}

// 获取 Axel 执行路径
function getAxelBinaryPath() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(BIN_DIR, 'darwin', 'axel');
  } else if (platform === 'win32') {
    return path.join(BIN_DIR, 'win32', 'axel.exe');
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
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: '生信数据多线程加速下载器',
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
    currentAxelProcess.kill('SIGKILL');
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
    currentAxelProcess.kill('SIGKILL');
    currentAxelProcess = null;
  }
});

// ==========================================
// 【Clash 运行控制模块与端口占用检测】
// ==========================================
const net = require('net');

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

  // 检测 43289 端口是否被占用
  const isPortBusy = await checkPortBusy(43289);
  if (isPortBusy) {
    throw new Error('下载加速器启动失败：加速端口冲突，请关闭其他代理/加速器软件或重启电脑后重试。');
  }

  try {
    console.log('Fetching clash configuration for token:', token);
    const subUrl = `${BACKEND_BASE_URL}/speedup?token=${token}`;
    const response = await axios.get(subUrl, { timeout: 10000 });
    
    // 动态修改 yaml 配置中的监听端口为 43289
    let yamlContent = response.data;
    yamlContent = yamlContent.replace(/mixed-port:\s*\d+/g, 'mixed-port: 43289');
    yamlContent = yamlContent.replace(/port:\s*\d+/g, 'port: 43289');
    yamlContent = yamlContent.replace(/socks-port:\s*\d+/g, 'socks-port: 43290');

    if (!yamlContent.includes('mixed-port: 43289') && !yamlContent.includes('port: 43289')) {
      yamlContent = 'mixed-port: 43289\n' + yamlContent;
    }

    // 保存 config.yaml 到用户工作空间
    const configPath = path.join(CLASH_WORK_DIR, 'config.yaml');
    fs.writeFileSync(configPath, yamlContent, 'utf8');

    const binaryPath = getClashBinaryPath();
    ensureExecutable(binaryPath);

    console.log(`Spawning Clash from ${binaryPath} with config at ${CLASH_WORK_DIR}`);
    
    clashProcess = spawn(binaryPath, ['-d', CLASH_WORK_DIR]);

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

    // 延迟等待启动完成
    await new Promise(resolve => setTimeout(resolve, 2000));
    return true;
  } catch (err) {
    console.error('Failed to start Clash:', err.message);
    throw new Error('下载加速器启动失败: ' + err.message);
  }
}

function stopClash() {
  if (clashProcess) {
    console.log('Terminating Clash process...');
    clashProcess.kill('SIGINT');
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

ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  if (result.canceled) return null;
  return result.filePaths[0];
});

// --- 用户与支付 ---
ipcMain.handle('api-register', async (event, { username, password }) => {
  const res = await axios.post(`${BACKEND_BASE_URL}/api/auth/register`, { username, password });
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

ipcMain.handle('clash-status', () => {
  return clashProcess !== null;
});

// --- 文件大小检验 ---
ipcMain.handle('check-download-size', async (event, { type, inputVal }) => {
  const ids = inputVal.split(/[\s,\n;]+/).map(x => x.trim()).filter(Boolean);
  if (ids.length === 0) {
    throw new Error('请输入正确的编号或链接');
  }

  const files = [];
  
  if (type === 'sra_raw') {
    for (const acc of ids) {
      const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
      const size = await headRequestSize(url);
      files.push({ name: acc, url, size });
    }
  } else if (type === 'ebi_raw') {
    for (const acc of ids) {
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
          for (let u of urls) {
            const cleanUrl = u.startsWith('http') ? u : 'https://' + u;
            const size = await headRequestSize(cleanUrl);
            const fname = cleanUrl.substring(cleanUrl.lastIndexOf('/') + 1);
            files.push({ name: fname, url: cleanUrl, size, folder: acc });
          }
        } else {
          // 回退 AWS SRA
          const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
          const size = await headRequestSize(url);
          files.push({ name: acc, url, size });
        }
      } catch (e) {
        // 回退 AWS SRA
        const url = `https://sra-pub-run-odp.s3.amazonaws.com/sra/${acc}/${acc}`;
        const size = await headRequestSize(url);
        files.push({ name: acc, url, size });
      }
    }
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
        let found = false;

        for (let i = 0; i < links.length; i++) {
          const href = $(links[i]).attr('href');
          if (href && !href.startsWith('/') && !href.startsWith('?') && href.toLowerCase() !== 'filelist.txt') {
            const fileUrl = new URL(href, geoUrl).href;
            const size = await headRequestSize(fileUrl);
            files.push({ name: href, url: fileUrl, size, folder: acc });
            found = true;
          }
        }
        if (!found) {
          throw new Error(`[${acc}] 页面上未发现可下载的补充文件`);
        }
      } catch (err) {
        throw new Error(`获取 GEO ${acc} 页面失败: ` + err.message);
      }
    }
  } else if (type === 'links') {
    for (const link of ids) {
      const size = await headRequestSize(link);
      const name = link.substring(link.lastIndexOf('/') + 1) || 'file_' + Date.now();
      files.push({ name, url: link, size });
    }
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
          index: i,
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
        index: i,
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

      const args = ['-n', '16', '-o', savePath, file.url];
      console.log(`Running Axel (Attempt ${attempt}): ${axelBin} ${args.join(' ')}`);

      try {
        await new Promise((resolve, reject) => {
          currentAxelProcess = spawn(axelBin, args, { env });

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
                index: i,
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
        index: i,
        fileName: file.name,
        status: 'completed',
        percentage: 100,
        speed: '已保存'
      });
    } else {
      mainWindow.webContents.send('download-status', {
        index: i,
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
    currentAxelProcess.kill('SIGKILL');
    currentAxelProcess = null;
    return true;
  }
  return false;
});
