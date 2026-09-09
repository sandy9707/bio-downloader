#!/usr/bin/env node
const { program } = require('commander');
const { BiodlServer } = require('./server');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');

const SERVER_VERSION = '2.0.42-preview.1';
process.env.BIODL_SERVER_VERSION = SERVER_VERSION;
const main = require('../../main');

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, n = value;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}

function formatAccountInfo(info) {
  const expiry = info.expireAt ? new Date(info.expireAt) : null;
  const permanent = expiry && expiry.getFullYear() >= new Date().getFullYear() + 50;
  const status = info.isActive ? '可用' : '已过期或流量不足';
  return `账号: ${info.username}\n余额: ¥${Number(info.balance || 0).toFixed(2)}\n剩余流量: ${formatBytes(info.remainingTraffic)}\n到期时间: ${permanent ? '永久' : (expiry ? expiry.toLocaleString() : '永久')}\n账户状态: ${status}`;
}

function extractToken(input) {
  const value = String(input || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    const token = url.searchParams.get('token');
    if (token) return token;
  } catch (e) {}
  return value;
}

async function validateAndSaveToken(input) {
  const token = extractToken(input);
  if (!token) throw new Error('Token 不能为空');
  let info;
  try {
    info = await main.callIpcHandler('api-get-user-info', { token });
  } catch (e) {
    throw new Error('Token 无效或无法连接认证服务器');
  }
  if (!info || !info.success || !info.username) throw new Error((info && info.error) || 'Token 无效');
  await main.callIpcHandler('save-settings', { token });
  return info;
}

function promptInput(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden && process.stdin.isTTY) {
      rl.stdoutMuted = true;
      rl._writeToOutput = function (text) {
        this.output.write(this.stdoutMuted && !text.includes(question) ? '*' : text);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function privateIpv4Addresses() {
  const values = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) values.push(item.address);
    }
  }
  return [...new Set(values)];
}

async function queryPublicIp(timeoutMs = 3000) {
  for (const url of ['https://api.ipify.org', 'https://ipv4.icanhazip.com']) {
    const result = await new Promise((resolve) => {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve(body.trim()));
      });
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.on('error', () => resolve(''));
    });
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(result)) return result;
  }
  return '';
}

program
  .name('biodl')
  .description('BioDownloader Server - Linux Web 管理与命令行下载服务')
  .version(SERVER_VERSION);

// 1. biodl start: 启动 Web 管理面板与下载服务 (默认 0.0.0.0)
program
  .command('start')
  .description('启动后台下载服务与 Web 管理界面')
  .option('-p, --port <port>', 'Web 服务监听端口', 43280)
  .option('-h, --host <host>', '绑定网络地址 (默认 0.0.0.0 允许全网/局域网访问)', '0.0.0.0')
  .action(async (options) => {
    const server = new BiodlServer({
      host: options.host,
      port: parseInt(options.port, 10)
    });

    try {
      await server.start();
      const privateIps = privateIpv4Addresses();
      const publicIp = await queryPublicIp();
      const port = options.port;
      const localUrls = privateIps.map((ip) => `http://${ip}:${port}`);
      console.log(`
============================================================
🧬 BioDownloader Linux Server 启动成功！
------------------------------------------------------------
请在 Windows / macOS / Linux 电脑的 Chrome 或 Edge 地址栏中打开：
🏠 内网访问 : ${localUrls.length ? localUrls.join('\n             ') : '未检测到内网 IPv4，请执行 hostname -I 查看'}
🌍 外网访问 : ${publicIp && options.host === '0.0.0.0' ? `http://${publicIp}:${port}（需云服务器安全组/防火墙放行该端口）` : '未检测到或当前仅限本机访问'}
💻 本机访问 : http://127.0.0.1:${port}

IP 是服务器地址，端口是冒号后的数字 ${port}。请把完整的 http://IP:${port} 输入浏览器地址栏，不要在 Xshell/X-Share 的文件管理器中打开。
============================================================
按 Ctrl+C 可安全停止服务。
`);
    } catch (e) {
      console.error('启动服务失败:', e.message);
      process.exit(1);
    }
  });

// 2. biodl auth: 绑定 Token 鉴权
program
  .command('auth [token]')
  .description('验证并保存 Token；支持直接粘贴订阅链接')
  .action(async (token) => {
    if (!token) {
      const s = await main.callIpcHandler('get-settings');
      if (!s.token) return console.log('当前未登录。请执行 ./biodl login 或 ./biodl auth TOKEN');
      try {
        const info = await validateAndSaveToken(s.token);
        console.log(`✅ 当前登录凭证有效\n${formatAccountInfo(info)}`);
      } catch (e) {
        await main.callIpcHandler('save-settings', { token: null });
        console.error('❌ 已保存的 Token 已失效:', e.message);
        process.exitCode = 1;
      }
    } else {
      try {
        const info = await validateAndSaveToken(token);
        console.log(`✅ 登录验证成功\n${formatAccountInfo(info)}`);
      } catch (e) {
        await main.callIpcHandler('save-settings', { token: null });
        console.error('❌ 登录验证失败:', e.message);
        process.exitCode = 1;
      }
    }
  });

program
  .command('login')
  .description('使用账号密码登录')
  .option('-u, --username <username>', 'BioDownloader 用户名')
  .option('-p, --password <password>', 'BioDownloader 密码（建议省略并交互输入，避免写入命令历史）')
  .action(async (options) => {
    const username = options.username || await promptInput('用户名: ');
    const password = options.password || await promptInput('密码: ', true);
    if (!username || !password) {
      console.error('❌ 用户名和密码不能为空');
      process.exitCode = 1;
      return;
    }
    const result = await main.callIpcHandler('api-login', { username, password });
    if (!result || !result.success || !result.token) {
      console.error('❌ 登录失败:', (result && result.error) || '用户名或密码错误');
      process.exitCode = 1;
      return;
    }
    const info = await validateAndSaveToken(result.token);
    console.log(`✅ 登录成功\n${formatAccountInfo(info)}`);
  });

// 3. biodl get: 命令行单项或批量下载
program
  .command('get <type> <accession>')
  .description('快速解析并下载生信数据 (SRA / EBI / GEO / 直链)')
  .option('-o, --output <dir>', '保存目录', path.join(os.homedir(), 'Downloads'))
  .option('-c, --concurrent <number>', '并发下载数', 3)
  .action(async (type, accession, options) => {
    const s = await main.callIpcHandler('get-settings');
    if (!s.token) {
      console.error('❌ 尚未登录，请先执行 ./biodl login -u 用户名 -p 密码，或 ./biodl auth TOKEN');
      process.exit(1);
    }

    try {
      const info = await validateAndSaveToken(s.token);
      if (!info.isActive) throw new Error('账号套餐已过期或剩余流量不足');
    } catch (e) {
      await main.callIpcHandler('save-settings', { token: null });
      console.error(`❌ ${e.message}，已阻止下载。请重新登录或检查账户状态。`);
      process.exit(1);
    }

    const typeMap = {
      'sra': 'sra_raw',
      'ebi': 'ebi_raw',
      'ena': 'ebi_raw',
      'geo': 'geo_suppl',
      'links': 'links'
    };
    const realType = typeMap[type.toLowerCase()] || type;

    console.log(`🔍 正在解析 ${realType} 编号: ${accession}...`);
    try {
      const files = await main.callIpcHandler('check-download-size', { type: realType, inputVal: accession });
      if (!files.length) {
        console.log('❌ 未找到可下载的文件');
        return;
      }
      console.log(`✅ 解析到 ${files.length} 个任务:`);
      files.forEach(f => console.log(`   - ${f.name} (${(f.size / (1024*1024)).toFixed(2)} MB)`));

      // 启动下载前确保高速加速通道就绪
      try {
        const isClashRunning = await main.callIpcHandler('clash-status');
        if (!isClashRunning) {
          process.stdout.write('⚡ 正在建立商业高速下载加速通道...');
          const startRes = await main.callIpcHandler('clash-start', { token: s.token });
          if (startRes && startRes.success) {
            console.log(` 成功！已连通 ${startRes.nodeCount || '全套'} 个海外学术高速加速节点`);
          } else {
            console.log(' (未能启动)');
          }
        }
      } catch (err) {
        console.warn(` (加速节点启动提示: ${err.message})`);
      }

      // 严格探测本地代理端口 43289 是否真正就绪并可连通
      const net = require('net');
      const isProxyPortActive = await new Promise((resolve) => {
        const sock = new net.Socket();
        sock.setTimeout(1500);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error', () => { sock.destroy(); resolve(false); });
        sock.connect(43289, '127.0.0.1');
      });

      if (!isProxyPortActive) {
        console.warn('\n⚠️  【注意】本地加速代理端口 (127.0.0.1:43289) 未启动或连接不可达！');
        console.warn('   当前未能正确使用高速下载节点，已降级为【直连下载】。');
        console.warn('   由于国际学术数据库直连带宽限制，直连下载速度可能较慢。');
        console.warn('   如需极速下载，请检查 ~/.bio-downloader/clash 日志或运行 ./biodl start 打开 Web 页面点击“优化连接”。\n');
      } else {
        console.log('⚡ 本地加速端口 (127.0.0.1:43289) 已就绪，正在通过商业高速节点加速下载！');
      }

      // 启动下载
      console.log('🚀 正在启动加速下载...');
      main.eventBus.on('download-progress', (data) => {
        process.stdout.write(`\r[进度] ${data.percentage}% | 速度: ${data.speed}      `);
      });
      main.eventBus.on('download-status', (data) => {
        if (data.status === 'completed') console.log(`\n🎉 [已完成] ${data.fileName}`);
        if (data.status === 'failed') console.log(`\n❌ [失败] ${data.fileName}: ${data.speed}`);
      });

      await main.callIpcHandler('start-download', {
        files,
        targetDir: options.output,
        token: s.token,
        maxConcurrent: options.concurrent
      });

    } catch (e) {
      console.error('下载出错:', e.message);
    }
  });

// 4. biodl update: 命令行一键安全自我更新
program
  .command('update')
  .description('检查并一键安全更新到最新的 Linux Server / CLI 版本')
  .action(async () => {
    console.log(`🔍 正在检查最新版本 (当前: v${SERVER_VERSION})...`);
    try {
      const checkRes = await main.callIpcHandler('check-for-updates');
      if (!checkRes || !checkRes.success) {
        console.error('❌ 检查更新失败:', (checkRes && checkRes.message) || '网络连接异常');
        process.exit(1);
      }

      if (!checkRes.hasUpdate) {
        console.log(`✅ 当前已是最新版本 (v${SERVER_VERSION})，无需更新。`);
        return;
      }

      console.log(`🎁 发现新版本: v${checkRes.latestVersion}`);
      if (checkRes.releaseNotes) {
        console.log('--- 更新日志 ---');
        console.log(checkRes.releaseNotes);
        console.log('----------------');
      }

      const linuxUrl = checkRes.linuxUrl;
      if (!linuxUrl) {
        console.error('❌ 官方更新清单中未声明 Linux 安装包地址，请前往官网手动下载。');
        process.exit(1);
      }

      console.log(`📥 正在后台下载并校验更新包 (SHA-256: ${checkRes.sha256 ? checkRes.sha256.slice(0, 12) + '...' : '未提供'})...`);
      const updateRes = await main.callIpcHandler('linux-self-update', {
        url: linuxUrl,
        sha256: checkRes.sha256
      });

      if (updateRes && updateRes.success) {
        console.log(`\n🎉 BioDownloader 已成功更新至 v${checkRes.latestVersion}！`);
        console.log('   核心代码已完成就地升级，您的配置数据与下载历史完好保留。');
        console.log('   如果您正在运行后台服务，请执行 pm2 restart biodl 或重新运行 ./biodl start 即可生效。\n');
      }
    } catch (e) {
      console.error('❌ 更新失败:', e.message);
      process.exit(1);
    }
  });

// 5. biodl status: 查询下载状态与任务历史
program
  .command('status')
  .description('查看当前下载任务与历史完成列表')
  .action(async () => {
    const data = await main.callIpcHandler('get-transfers-history');
    console.log('=== 最近已完成历史 (物理文件持久化) ===');
    if (!data.completed.length) console.log('  (暂无完成记录)');
    else data.completed.slice(0, 5).forEach(c => console.log(`  - ✅ ${c.name} (${c.completedAt})`));
  });

program.parse(process.argv);
