const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const main = require('../../main');

const PUBLIC_CHANNELS = new Set([
  'get-app-version',
  'get-settings',
  'api-login',
  'api-register',
  'api-get-user-info',
  'api-request-password-reset',
  'api-confirm-password-reset',
  'api-get-packages'
]);

const SESSIONS_FILE = path.join(process.env.BIODL_DATA_DIR || path.join(os.homedir(), '.bio-downloader'), 'web_sessions.json');

class BiodlServer {
  constructor(options = {}) {
    this.host = options.host || '0.0.0.0';
    this.port = options.port || 43280;
    this.webDir = options.webDir || path.join(__dirname, '../web');
    this.sseClients = new Set();
    this.sessions = new Map();
    this.server = null;
    this.loadSessions();

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

  async start() {
    const settings = await main.callIpcHandler('get-settings');
    if (!settings.defaultDir || /^\/tmp\/biodl(?:-|\/|$)/.test(settings.defaultDir)) {
      const downloadsDir = path.join(os.homedir(), 'Downloads');
      fs.mkdirSync(downloadsDir, { recursive: true });
      await main.callIpcHandler('save-settings', { defaultDir: downloadsDir });
    }

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

  loadSessions() {
    try {
      if (fs.existsSync(SESSIONS_FILE)) {
        const data = JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'));
        if (Array.isArray(data)) {
          const now = Date.now();
          for (const s of data) {
            if (s && s.id && s.expiresAt > now) {
              this.sessions.set(s.id, s);
            }
          }
        }
      }
    } catch (e) {
      console.warn('[BiodlServer] 读取持久化会话异常:', e.message);
    }
  }

  saveSessions() {
    try {
      const arr = [];
      const now = Date.now();
      for (const [id, s] of this.sessions.entries()) {
        if (s && s.expiresAt > now) {
          arr.push({ id, token: s.token, expiresAt: s.expiresAt });
        }
      }
      const dir = path.dirname(SESSIONS_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(arr, null, 2), 'utf8');
    } catch (e) {
      console.warn('[BiodlServer] 保存持久化会话异常:', e.message);
    }
  }

  getSessionId(req) {
    const cookie = String(req.headers.cookie || '');
    const match = cookie.match(/(?:^|;\s*)biodl_session=([^;]+)/);
    if (match) return match[1];
    const hdr = String(req.headers['x-biodl-session'] || req.headers['authorization'] || '');
    if (hdr.startsWith('Bearer ')) return hdr.slice(7).trim();
    if (hdr) return hdr.trim();
    return '';
  }

  getSession(req) {
    const sid = this.getSessionId(req);
    if (!sid) return null;
    const session = this.sessions.get(sid);
    if (!session || session.expiresAt < Date.now()) {
      if (this.sessions.has(sid)) {
        this.sessions.delete(sid);
        this.saveSessions();
      }
      return null;
    }
    session.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    return session;
  }

  createSession(res, token) {
    const id = crypto.randomBytes(32).toString('hex');
    const session = { id, token, expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000 };
    this.sessions.set(id, session);
    this.saveSessions();
    if (res && typeof res.setHeader === 'function') {
      res.setHeader('Set-Cookie', `biodl_session=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000`);
    }
    return id;
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
      const querySid = parsedUrl.searchParams.get('sid');
      let session = this.getSession(req);
      if (!session && querySid) {
        session = this.sessions.get(querySid);
      }
      if (!session) {
        try {
          const settings = (typeof main.getSettings === 'function') ? main.getSettings() : {};
          if (settings && settings.token) {
            const sid = this.createSession(res, settings.token);
            session = this.sessions.get(sid);
          }
        } catch (e) {}
      }
      if (!session || session.expiresAt < Date.now()) {
        return this.sendJson(res, 401, { error: '请先登录' });
      }
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
        let session = this.getSession(req);

        if (channel === 'get-settings') {
          const settings = await main.callIpcHandler(channel, payload);
          if (!session && settings && settings.token) {
            const newSid = this.createSession(res, settings.token);
            session = this.sessions.get(newSid);
          }
          const activeSession = session;
          return this.sendJson(res, 200, {
            success: true,
            result: activeSession ? settings : { ...settings, token: null },
            sessionId: activeSession ? activeSession.id : null
          });
        }

        if (!PUBLIC_CHANNELS.has(channel) && !session) {
          try {
            const settings = await main.callIpcHandler('get-settings');
            if (settings && settings.token) {
              const newSid = this.createSession(res, settings.token);
              session = this.sessions.get(newSid);
            }
          } catch (e) {}
          if (!session) {
            return this.sendJson(res, 401, { success: false, error: '请先登录后再执行该操作' });
          }
        }

        // 主动注销支持: 用户在 Web 页面点击注销退出
        if (channel === 'save-settings' && payload && payload.token === null) {
          const sid = this.getSessionId(req);
          if (sid) {
            this.sessions.delete(sid);
            this.saveSessions();
          }
          res.setHeader('Set-Cookie', 'biodl_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
        }

        const result = await main.callIpcHandler(channel, payload);
        let createdSid = null;
        if ((channel === 'api-login' || channel === 'api-register' || channel === 'api-get-user-info') && result && result.success && result.token) {
          createdSid = this.createSession(res, result.token);
        }
        return this.sendJson(res, 200, { success: true, result, sessionId: createdSid || (session ? session.id : null) });
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
    } else if (safePath.startsWith('/img/')) {
      filePath = path.join(__dirname, '../../img', safePath.replace('/img/', ''));
    } else if (safePath === '/renderer.js') {
      filePath = path.join(__dirname, '../../renderer.js');
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
