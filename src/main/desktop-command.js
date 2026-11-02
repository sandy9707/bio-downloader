'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

async function startDesktopCommand({ directory, submit, status }) {
  const token = crypto.randomBytes(32).toString('hex');
  const descriptor = path.join(directory, 'desktop-command.json');
  const server = http.createServer(async (req, res) => {
    const reply = (code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (req.headers.origin || req.headers.authorization !== 'Bearer ' + token) return reply(403, { error: 'Forbidden' });
    if (req.method === 'GET' && req.url === '/status') {
      try { return reply(200, await status()); } catch (e) { return reply(409, { error: e.message }); }
    }
    if (req.method !== 'POST' || req.url !== '/submit') return reply(404, { error: 'Not found' });
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 16384) throw new Error('请求过大');
      }
      const body = JSON.parse(raw);
      if (!['ebi', 'sra', 'geo', 'links'].includes(body.type) || typeof body.accession !== 'string' || !body.accession.trim() || body.accession.length > 12000) throw new Error('无效任务类型或编号');
      if (typeof body.output !== 'string' || !path.isAbsolute(body.output)) throw new Error('请指定绝对保存路径');
      return reply(202, await submit({ type: body.type, accession: body.accession, output: body.output }));
    } catch (e) { return reply(409, { error: e.message }); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(descriptor, JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, token }), { mode: 0o600 });
  return { server, close: () => {
    try { if (JSON.parse(fs.readFileSync(descriptor)).token === token) fs.unlinkSync(descriptor); } catch (_) {}
    server.close();
  } };
}
async function callDesktop(directory, method, body) {
  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(directory, 'desktop-command.json'), 'utf8')); }
  catch (_) { throw new Error('未发现运行中的桌面服务；请在同一Windows账户打开支持GUI桥接的新版客户端'); }
  if (info.version !== 1 || !Number.isInteger(info.port) || info.port < 1 || info.port > 65535 || !/^[a-f0-9]{64}$/.test(info.token)) throw new Error('桌面服务信息无效');
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: info.port, method: data ? 'POST' : 'GET', path: '/' + method,
      headers: { Authorization: 'Bearer ' + info.token, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, res => {
      let text = ''; res.on('data', b => text += b);res.on('error', reject);
      res.on('end', () => { try { const value = JSON.parse(text);res.statusCode < 300 ? resolve(value) : reject(new Error(value.error || '桌面请求失败')); } catch (e) { reject(e); } });
    });
    req.setTimeout(10000, () => req.destroy(new Error('桌面响应超时；请先查询状态，勿直接重复提交')));
    req.on('error', reject);req.end(data);
  });
}
module.exports = { startDesktopCommand, callDesktop };
