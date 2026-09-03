const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
const EventEmitter = require('events');
const { BACKEND_BASE_URL } = require('./resolver');
const { DATA_DIR, saveTransfersData, getTransfersData } = require('./storage');

class DownloadManager extends EventEmitter {
  constructor() {
    super();
    this.activeTasks = new Map(); // id -> { task, proc, status, percentage, speed }
    this.queue = [];
    this.maxConcurrent = 3;
    this.token = '';
    this.defaultDir = process.cwd();
    this.proxyPort = 43289;
  }

  setToken(token) {
    this.token = token;
  }

  setDefaultDir(dir) {
    if (dir && fs.existsSync(dir)) {
      this.defaultDir = dir;
    }
  }

  setMaxConcurrent(num) {
    this.maxConcurrent = Math.max(1, parseInt(num, 10) || 3);
    this.scheduleNext();
  }

  addTasks(files, targetDir) {
    const dir = targetDir || this.defaultDir;
    const added = [];
    for (const f of files) {
      const id = 'task_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7);
      const task = {
        id,
        name: f.name,
        url: f.url,
        size: f.size || 0,
        folder: f.folder || '',
        type: f.type || 'direct',
        targetDir: dir,
        savePath: path.join(dir, f.folder || '', f.name),
        status: 'waiting',
        percentage: 0,
        speed: '排队中...',
        receivedBytes: 0,
        createdAt: new Date().toISOString()
      };
      this.activeTasks.set(id, task);
      this.queue.push(id);
      added.push(task);
      this.emit('task-updated', task);
    }
    this.scheduleNext();
    return added;
  }

  scheduleNext() {
    let runningCount = 0;
    for (const t of this.activeTasks.values()) {
      if (t.status === 'downloading') runningCount++;
    }

    while (runningCount < this.maxConcurrent && this.queue.length > 0) {
      const nextId = this.queue.shift();
      const task = this.activeTasks.get(nextId);
      if (task && task.status === 'waiting') {
        runningCount++;
        this.runTask(task);
      }
    }
  }

  async runTask(task) {
    task.status = 'downloading';
    task.speed = '正在启动...';
    this.emit('task-updated', task);

    const dir = path.dirname(task.savePath);
    if (!fs.existsSync(dir)) {
      try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    }

    const isFtp = task.type === 'ftp' || task.url.startsWith('ftp://');
    const isSftp = task.type === 'sftp' || task.url.startsWith('sftp://');

    // 优先尝试 aria2c，如无则降级 Node 流式
    let success = false;
    let errorMsg = '';

    try {
      if (isFtp || isSftp) {
        await this.downloadWithAria2(task);
      } else {
        await this.downloadWithNodeStream(task);
      }
      success = true;
    } catch (err) {
      errorMsg = err.message;
      // 容灾重试: 若因代理 ECONNREFUSED 失败，自动直连重试一次
      if (errorMsg.includes('ECONNREFUSED')) {
        try {
          await this.downloadWithNodeStream(task, true); // direct
          success = true;
        } catch (e2) {
          errorMsg = e2.message;
        }
      }
    }

    if (success) {
      task.status = 'completed';
      task.percentage = 100;
      task.speed = '0 B/s';
      this.emit('task-completed', task);
      this.reportConsume(task);
      this.recordTransferHistory(task, true);
    } else {
      task.status = 'failed';
      task.failedReason = errorMsg;
      task.speed = '下载失败';
      this.emit('task-failed', task);
      this.recordTransferHistory(task, false);
    }

    this.activeTasks.delete(task.id);
    this.scheduleNext();
  }

  async downloadWithNodeStream(task, forceDirect = false) {
    const writer = fs.createWriteStream(task.savePath, { flags: 'a' });
    let downloaded = 0;
    try { downloaded = fs.statSync(task.savePath).size; } catch (e) {}

    const headers = {};
    if (downloaded > 0) {
      headers['Range'] = `bytes=${downloaded}-`;
    }

    const axiosOptions = {
      url: task.url,
      method: 'GET',
      responseType: 'stream',
      timeout: 30000,
      headers,
      maxRedirects: 5,
      validateStatus: (s) => (s >= 200 && s < 400),
      proxy: (!forceDirect && this.proxyPort) ? { protocol: 'http', host: '127.0.0.1', port: this.proxyPort } : false
    };

    const response = await axios(axiosOptions);
    const contentLen = parseInt(response.headers['content-length'] || '0', 10);
    const total = (task.size || 0) > 0 ? task.size : (downloaded + contentLen);

    let lastTime = Date.now();
    let lastBytes = downloaded;

    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        const now = Date.now();
        const diff = downloaded - lastBytes;
        lastBytes = downloaded;
        const bps = diff / ((now - lastTime || 1000) / 1000);
        lastTime = now;

        task.percentage = total > 0 ? Math.min(99, Math.floor((downloaded / total) * 100)) : 50;
        task.receivedBytes = downloaded;
        task.speed = this.formatSpeed(bps);
        this.emit('task-progress', task);
      }, 1000);

      response.data.on('data', (chunk) => {
        downloaded += chunk.length;
      });

      response.data.pipe(writer);

      writer.on('finish', () => {
        clearInterval(timer);
        resolve();
      });

      writer.on('error', (err) => {
        clearInterval(timer);
        reject(err);
      });

      response.data.on('error', (err) => {
        clearInterval(timer);
        reject(err);
      });
    });
  }

  async downloadWithAria2(task) {
    // 检查环境变量中或系统的 aria2c
    const aria2Bin = process.env.ARIA2_PATH || 'aria2c';
    const ariaArgs = [
      '-x', '8',
      '-s', '8',
      '-k', '1M',
      '--file-allocation=none',
      '--summary-interval=1',
      '--console-log-level=warn',
      '-d', path.dirname(task.savePath),
      '-o', path.basename(task.savePath),
      task.url
    ];

    return new Promise((resolve, reject) => {
      const proc = spawn(aria2Bin, ariaArgs);
      let lastBytes = 0;
      let lastTime = Date.now();

      proc.stdout.on('data', (data) => {
        const output = data.toString();
        const pctMatch = output.match(/\((\d+)%\)/);
        const speedMatch = output.match(/DL:([\d.]+[KMGT]?i?B(?:\/s)?)/i);
        let cur = 0;
        try { cur = fs.statSync(task.savePath).size; } catch (e) {}

        if (pctMatch) task.percentage = parseInt(pctMatch[1], 10);
        if (speedMatch) task.speed = speedMatch[1].endsWith('/s') ? speedMatch[1] : speedMatch[1] + '/s';
        task.receivedBytes = cur;
        this.emit('task-progress', task);
      });

      proc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`aria2c exited with code ${code}`));
      });

      proc.on('error', reject);
    });
  }

  formatSpeed(bps) {
    if (bps > 1024 * 1024) return (bps / (1024 * 1024)).toFixed(2) + ' MB/s';
    if (bps > 1024) return (bps / 1024).toFixed(1) + ' KB/s';
    return Math.round(bps) + ' B/s';
  }

  async reportConsume(task) {
    if (!this.token) return;
    try {
      let bytes = task.size || 0;
      try { bytes = fs.statSync(task.savePath).size; } catch (e) {}
      await axios.post(`${BACKEND_BASE_URL}/api/user/consume`, {
        token: this.token,
        bytes
      });
    } catch (e) {}
  }

  recordTransferHistory(task, isSuccess) {
    const data = getTransfersData();
    if (isSuccess) {
      data.completed.unshift({
        name: task.name,
        url: task.url,
        size: task.size,
        savePath: task.savePath,
        completedAt: new Date().toLocaleString()
      });
    } else {
      data.failed.unshift({
        name: task.name,
        url: task.url,
        size: task.size,
        failedReason: task.failedReason || '下载失败',
        failedAt: new Date().toLocaleString()
      });
    }
    saveTransfersData(data);
  }
}

const manager = new DownloadManager();
module.exports = {
  DownloadManager,
  manager
};
