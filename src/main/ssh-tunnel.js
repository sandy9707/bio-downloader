const net = require('net'), crypto = require('crypto');
const { Client } = require('ssh2');
class SshTunnel {
  constructor() { this.connection = null; this.listener = null; this.sockets = new Set(); this.connecting = false; this.info = { connected: false }; }
  status() { return { ...this.info }; }
  stop() {
    for (const socket of this.sockets) socket.destroy(); this.sockets.clear();
    if (this.listener) this.listener.close(); this.listener = null;
    if (this.connection) this.connection.destroy(); this.connection = null;
    this.info = { connected: false }; return this.status();
  }
  async start(options, knownFingerprint) {
    if (this.connecting) throw new Error('SSH 正在连接，请稍候');
    if (this.info.connected) throw new Error('请先断开当前 SSH 连接');
    const host = String(options.host || '').trim(), username = String(options.username || '').trim();
    if (!host || /[\s\x00-\x1f/\\]/.test(host) || !username || /[\x00-\x1f]/.test(username)) throw new Error('请填写有效的服务器地址和 SSH 用户名');
    const port = Number(options.port || 22), remotePort = Number(options.remotePort || 43280), localPort = Number(options.localPort || 0);
    for (const value of [port, remotePort]) if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('端口必须为 1–65535');
    if (!Number.isInteger(localPort) || localPort < 0 || localPort > 65535 || (localPort && localPort < 1024)) throw new Error('本机端口请选择 1024–65535，或填 0 自动分配');
    if (!options.password && !options.privateKey) throw new Error('请输入 SSH 密码或选择私钥文件');
    this.connecting = true;
    const conn = new Client(); this.connection = conn;
    let fingerprint = '', settled = false, timer;
    try {
      return await new Promise((resolve, reject) => {
        const fail = error => {
          if (settled) return; settled = true; this.stop();
          if (fingerprint && !knownFingerprint) resolve({ requiresTrust: true, fingerprint, host, port });
          else if (fingerprint && knownFingerprint !== fingerprint) reject(new Error('服务器指纹与已保存记录不同，已拒绝连接。请先与服务器管理员核实。'));
          else reject(error);
        };
        timer = setTimeout(() => fail(new Error('SSH 连接或远端端口响应超时')), 30000);
        conn.on('error', error => {
          if (settled && this.connection !== conn) return;
          const message = error.level === 'client-authentication' ? 'SSH 认证失败，请检查用户名、密码或私钥' : `SSH 连接失败（${error.code || error.level || '连接中断'}）`;
          if (!settled) fail(new Error(message)); else { this.stop(); this.info.error = message; }
        });
        conn.on('close', () => { if (!settled) fail(new Error('SSH 连接已关闭')); else if (this.connection === conn) this.stop(); });
        conn.on('ready', () => {
          // Check that forwarding is allowed and the remote Web service is alive.
          conn.forwardOut('127.0.0.1', 0, '127.0.0.1', remotePort, (error, probe) => {
            if (error) return fail(new Error('无法访问服务器上的 Web 端口。请确认 biodl 已启动且 SSH 允许端口转发。'));
            probe.on('error', () => {}); probe.destroy();
            if (this.connection !== conn) return fail(new Error('连接已取消'));
            const listener = net.createServer(socket => {
              this.sockets.add(socket); socket.once('close', () => this.sockets.delete(socket)); socket.on('error', () => socket.destroy());
              conn.forwardOut('127.0.0.1', socket.remotePort || 0, '127.0.0.1', remotePort, (error, stream) => {
                if (error) return socket.destroy();
                if (socket.destroyed) return stream.destroy();
                stream.on('error', () => socket.destroy()); socket.on('close', () => stream.destroy());
                stream.pipe(socket); socket.pipe(stream);
              });
            });
            this.listener = listener;
            listener.on('error', error => { if (!settled) fail(new Error(error.code === 'EADDRINUSE' ? '本机端口已被占用，请改填 0 自动分配' : '无法打开本机端口')); else this.stop(); });
            listener.listen(localPort, '127.0.0.1', () => {
              if (this.connection !== conn) return fail(new Error('连接已取消'));
              settled = true;
              this.info = { connected: true, host, port, remotePort, fingerprint, url: `http://127.0.0.1:${listener.address().port}` };
              resolve(this.status());
            });
          });
        });
        conn.connect({ host, port, username, password: options.password || undefined,
          privateKey: options.privateKey || undefined, passphrase: options.passphrase || undefined,
          readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 3,
          hostVerifier: key => { fingerprint = 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, ''); return fingerprint === knownFingerprint; }
        });
      });
    } finally { clearTimeout(timer); this.connecting = false; }
  }
}
module.exports = { SshTunnel };
