const http = require('http');
const fs = require('fs');
const path = require('path');
const main = require('../../main');

class BiodlServer {
  constructor(options = {}) {
    this.host = options.host || '0.0.0.0';
    this.port = options.port || 43280;
    this.webDir = options.webDir || path.join(__dirname, '../web');
    this.sseClients = new Set();
    this.server = null;

    // 绑定 main.js 的事件总线，通过 SSE 实时推送到浏览器
    const forwardEvents = [
      'download-status',
      'download-progress',
      'curl-download-progress',
      'toast-message',
      'speedtest-progress'
    ];
    for (const ev of forwardEvents) {
      main.eventBus.on(ev, (data) => this.broadcastSSE(ev, data));
    }

    // 自动初始化二进制与依赖（无头模式下替代 Electron app.whenReady）
    try {
      if (typeof main.ensureBinaries === 'function') main.ensureBinaries();
      if (typeof main.ensureClashDataFiles === 'function') main.ensureClashDataFiles();
    } catch (e) {}
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
        console.log(`[BioDownloader Linux Server] 运行中: http://${this.host}:${this.port}`);
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
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

  async handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    const pathname = parsedUrl.pathname;

    // 1. SSE 实时事件长连接
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

    // 2. 核心通用 IPC 网关 (100% 复用 main.js 原生 65 个处理函数)
    if (pathname === '/api/ipc' && req.method === 'POST') {
      try {
        const body = await this.parseBody(req);
        const { channel, payload } = body;
        const result = await main.callIpcHandler(channel, payload);
        return this.sendJson(res, 200, { success: true, result });
      } catch (err) {
        return this.sendJson(res, 200, { success: false, error: err.message });
      }
    }

    // 3. 静态页面与资源托管
    this.serveStatic(pathname, res);
  }

  serveStatic(reqPath, res) {
    let safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
    if (safePath === '/' || safePath === '') safePath = '/index.html';
    
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
