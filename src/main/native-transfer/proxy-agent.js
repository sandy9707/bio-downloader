'use strict';
const http = require('http');
const https = require('https');
const tls = require('tls');

// A native Agent owns the pool of established origin TLS sockets. One CONNECT
// per socket, not per Range request. Never consult environment proxy variables.
class PooledProxyAgent extends https.Agent {
  constructor(proxy, options) { super(options); this.proxy = proxy; }
  createConnection(options, callback) {
    const host = options.hostname || options.host;
    const port = options.port || 443;
    const authority = `${host.includes(':') ? '[' + host + ']' : host}:${port}`;
    let settled = false, secure;
    const done = (error, socket) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(error, socket);
    };
    const request = http.request({ host: this.proxy.host, port: this.proxy.port,
      method: 'CONNECT', path: authority, headers: { Host: authority }, agent: false });
    const timer = setTimeout(() => {
      const error = Object.assign(new Error('Proxy tunnel timed out'), { code: 'ETIMEDOUT' });
      secure?.destroy(); request.destroy(error); done(error);
    }, options.timeout || 60000);
    request.once('error', error => done(error));
    request.once('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        done(Object.assign(new Error(`Proxy CONNECT rejected (${response.statusCode})`), { code: 'PROXY_CONNECT_' + response.statusCode }));
        return;
      }
      if (head.length) socket.unshift(head);
      const { path, host: ignoredHost, hostname, port: ignoredPort, ...tlsOptions } = options;
      secure = tls.connect({ ...tlsOptions, socket, servername: netServername(options.servername || host), ALPNProtocols: ['http/1.1'] });
      secure.once('error', error => { socket.destroy(); done(error); });
      secure.once('secureConnect', () => done(null, secure));
    });
    request.end();
  }
}
function netServername(host) { return require('net').isIP(host) ? undefined : host; }
module.exports = { PooledProxyAgent };
