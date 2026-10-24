#!/usr/bin/env node
const { program } = require('commander');
const { BiodlServer } = require('./server');
const os = require('os');
const path = require('path');
const https = require('https');
const readline = require('readline');

const SERVER_VERSION = require('../../package.json').version;
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
    throw new Error('暂时无法连接账号服务，已保留原登录凭证');
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

      const port = options.port;
      const localUrls = privateIps.map((ip) => `http://${ip}:${port}`);
      console.log(`
============================================================
🧬 BioDownloader Linux Server 启动成功！
------------------------------------------------------------
请在 Windows / macOS / Linux 电脑的 Chrome 或 Edge 地址栏中打开：
🏠 内网访问 : ${localUrls.length ? localUrls.join('\n             ') : '未检测到内网 IPv4，请执行 hostname -I 查看'}
🌍 外网访问 : 请使用服务器提供商提供的地址，并确认安全组/防火墙放行端口（不自动查询公网 IP）
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
        console.error('❌ 无法验证已保存的登录凭证（已保留）:', e.message);
        process.exitCode = 1;
      }
    } else {
      try {
        const info = await validateAndSaveToken(token);
        console.log(`✅ 登录验证成功\n${formatAccountInfo(info)}`);
      } catch (e) {
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
    if (s.usageChoice !== 'accepted') {
      console.error('请先阅读使用声明：./biodl consent；确认后执行 ./biodl consent --accept。');
      process.exitCode = 1; return;
    }
    if (!s.token) {
      console.error('❌ 尚未登录，请先执行 ./biodl login -u 用户名 -p 密码，或 ./biodl auth TOKEN');
      process.exit(1);
    }

    try {
      const info = await validateAndSaveToken(s.token);
      if (!info.isActive) throw new Error('账号套餐已过期或剩余流量不足');
    } catch (e) {
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
  .description('检查并更新 Linux Server / CLI；更新前请暂停任务并停止后台服务')
  .option('--preview', '明确选择预览通道（默认保持当前通道）')
  .option('--check', '只检查版本，不安装')
  .action(async (options) => {
    console.log(`🔍 正在检查最新版本 (当前: v${SERVER_VERSION})...`);
    try {
      let checkRes = await main.callIpcHandler('check-for-updates', { advancedMode: !!options.preview });
      if (options.preview && checkRes?.success) {
        if (!checkRes.preview) throw new Error('未能读取预览通道，请稍后重试；未切换或安装其他版本');
        const p = checkRes.preview;
        checkRes = { ...checkRes, ...p, latestVersion: p.version };
      }
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

      if (options.check) return;
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
        console.log('   请重新启动已停止的服务：nohup ./biodl start </dev/null > biodl.log 2>&1 &，然后在同一终端执行 disown。使用 PM2/systemd 的请通过原进程管理器重启，勿重复启动。\n');
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

program.command('consent').description('查看使用声明并保存本机选择')
  .option('--accept', '已知悉并确认使用').option('--decline', '不使用下载与加速')
  .action(async options => {
    console.log('不推荐在任何校园网环境下使用本软件。校园网使用属于高风险行为；因此产生的账号封禁等后果，目前无法提供相应售后处理。建议使用家用宽带、手机流量或热点，或允许使用本软件的网吧网络。本声明不检测网络环境。');
    if (options.accept && options.decline) { console.error('请只选择一个选项'); process.exitCode = 1; return; }
    if (options.accept || options.decline) {
      await main.callIpcHandler('set-usage-choice', options.accept ? 'accepted' : 'declined');
      console.log(options.accept ? '已保存确认，以后不再提示。' : '已选择不使用；后续下载将等待您的确认。');
    } else console.log('确认使用：./biodl consent --accept；不使用：./biodl consent --decline');
  });
program.command('paths').description('显示程序、配置及默认下载目录（不显示凭据）')
  .action(async () => {
    const settings = await main.callIpcHandler('get-settings');
    const data = path.resolve(process.env.BIODL_DATA_DIR || path.join(os.homedir(), '.bio-downloader'));
    const appDir = path.resolve(__dirname, '../..');
    console.log('程序目录: ' + appDir);
    console.log('配置、历史与会话目录: ' + data);
    console.log('默认下载目录: ' + (settings.defaultDir || path.join(os.homedir(), 'Downloads')));
    console.log('下载文件和断点保存在各任务的目标目录，请一起保留。');
    if (data === appDir || data.startsWith(appDir + path.sep)) console.log('注意：当前 BIODL_DATA_DIR 位于程序目录内。删除程序前请先备份并迁移此目录，然后更新环境变量。');
  });
program.command('doctor').description('检查官方服务连通性；不读取账号密码，不检测网络类型')
  .action(async () => {
    console.log('检查版本服务，最多等待约 30 秒...');
    const result = await main.callIpcHandler('check-for-updates');
    if (result?.success) console.log('官方服务连接正常。若 Web 登录仍失败，请记录页面的具体报错；不要发送密码或 Token。');
    else { console.error(result?.message || '连接失败'); process.exitCode = 1; }
  });

program.parseAsync(process.argv).catch(error => { console.error('操作失败:', error.message); process.exitCode = 1; });
