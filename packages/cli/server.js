const http = require('http');
const fs = require('fs');
const path = require('path');
const { manager } = require('../core/downloader');
const { resolveSources, BACKEND_BASE_URL } = require('../core/resolver');
const { startClash, stopClash, getClashStatus, getNodeCount } = require('../core/proxy');
const { getSettings, saveSettings, getTransfersData, saveTransfersData } = require('../core/storage');
const axios = require('axios');

class BiodlServer {
  constructor(options = {}) {
    this.host = options.host || '0.0.0.0'; // 默认 0.0.0.0
    this.port = options.port || 43280;
    this.webDir = options.webDir || path.join(__dirname, '../web');
    this.sseClients = new Set();
    this.server = null;

    // 绑定下载事件推送给 SSE
    manager.on('task-progress', (task) => this.broadcastSSE('progress', task));
    manager.on('task-updated', (task) => this.broadcastSSE('updated', task));
    manager.on('task-completed', (task) => this.broadcastSSE('completed', task));
    manager.on('task-failed', (task) => this.broadcastSSE('failed', task));
  }

  broadcastSSE(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) {
      try { res.write(payload); } catch (e) { this.sseClients.delete(res); }
    }
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handleRequest(req, res));
      this.server.listen(this.port, this.host, () => {
        console.log(`[BioDownloader Server] 运行中: http://${this.host}:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      stopClash();
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  async handleRequest(req, res) {
    // 允许跨域，方便开发调试
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 1. SSE 实时事件流
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });
      res.write('retry: 3000\n\n');
      this.sseClients.add(res);
      req.on('close', () => this.sseClients.delete(res));
      return;
    }

    // 2. API 路由
    if (pathname.startsWith('/api/')) {
      return this.handleApi(pathname, req, res, parsedUrl);
    }

    // 3. 静态网页服务
    this.serveStatic(pathname, res);
  }

  async parseBody(req) {
    return new Promise((resolve) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { resolve({}); }
      });
    });
  }

  sendJson(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
  }

  async handleApi(pathname, req, res, url) {
    try {
      // 系统/状态信息
      if (pathname === '/api/system' && req.method === 'GET') {
        const settings = getSettings();
        return this.sendJson(res, 200, {
          version: '2.0.37-linux',
          clashRunning: getClashStatus(),
          nodeCount: getNodeCount(),
          defaultDir: manager.defaultDir,
          maxConcurrent: manager.maxConcurrent,
          settings
        });
      }

      // 账户鉴权代理
      if (pathname === '/api/auth/login' && req.method === 'POST') {
        const body = await this.parseBody(req);
        const r = await axios.post(`${BACKEND_BASE_URL}/api/auth/login`, body);
        if (r.data.token) {
          saveSettings({ token: r.data.token });
          manager.setToken(r.data.token);
        }
        return this.sendJson(res, r.status, r.data);
      }

      if (pathname === '/api/user/info' && req.method === 'GET') {
        const token = url.searchParams.get('token') || getSettings().token;
        if (!token) return this.sendJson(res, 401, { error: '未登录' });
        const r = await axios.get(`${BACKEND_BASE_URL}/api/user/info?token=${token}&version=2.0.37-linux`);
        return this.sendJson(res, r.status, r.data);
      }

      // 加速器启停
      if (pathname === '/api/clash/start' && req.method === 'POST') {
        const token = getSettings().token;
        if (!token) return this.sendJson(res, 400, { error: '请先登录' });
        const out = await startClash(token, 43289);
        return this.sendJson(res, 200, out);
      }

      if (pathname === '/api/clash/stop' && req.method === 'POST') {
        stopClash();
        return this.sendJson(res, 200, { success: true });
      }

      // 解析数据源大小与链接
      if (pathname === '/api/resolve' && req.method === 'POST') {
        const body = await this.parseBody(req);
        const files = await resolveSources(body.type, body.input, 43289);
        return this.sendJson(res, 200, { success: true, files });
      }

      // 投递下载任务
      if (pathname === '/api/tasks' && req.method === 'POST') {
        const body = await this.parseBody(req);
        if (!Array.isArray(body.files) || body.files.length === 0) {
          return this.sendJson(res, 400, { error: '缺少 files 任务列表' });
        }
        const added = manager.addTasks(body.files, body.targetDir);
        return this.sendJson(res, 200, { success: true, count: added.length, tasks: added });
      }

      // 任务与历史传输列表
      if (pathname === '/api/transfers' && req.method === 'GET') {
        const diskData = getTransfersData();
        const active = Array.from(manager.activeTasks.values());
        return this.sendJson(res, 200, {
          active,
          completed: diskData.completed,
          failed: diskData.failed
        });
      }

      // 清空或修改历史记录
      if (pathname === '/api/transfers' && req.method === 'POST') {
        const body = await this.parseBody(req);
        const saved = saveTransfersData(body);
        return this.sendJson(res, 200, { success: true, data: saved });
      }

      // 设置读写
      if (pathname === '/api/settings' && req.method === 'GET') {
        return this.sendJson(res, 200, getSettings());
      }
      if (pathname === '/api/settings' && req.method === 'POST') {
        const body = await this.parseBody(req);
        const s = saveSettings(body);
        if (s.defaultDir) manager.setDefaultDir(s.defaultDir);
        if (s.maxConcurrent) manager.setMaxConcurrent(s.maxConcurrent);
        return this.sendJson(res, 200, s);
      }

      return this.sendJson(res, 404, { error: 'API not found' });
    } catch (e) {
      return this.sendJson(res, 500, { error: e.message });
    }
  }

  serveStatic(reqPath, res) {
    let safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '') safePath = '/index.html';
    
    // 如果请求 shared/download-sources.js
    let filePath = path.join(this.webDir, safePath);
    if (safePath.startsWith('/shared/')) {
      filePath = path.join(__dirname, '../../shared', safePath.replace('/shared/', ''));
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(this.webDir, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.ico': 'image/x-icon',
      '.json': 'application/json'
    };

    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  }
}

module.exports = {
  BiodlServer
};
