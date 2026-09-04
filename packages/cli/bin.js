#!/usr/bin/env node
const { program } = require('commander');
const { BiodlServer } = require('./server');
const main = require('../../main');

program
  .name('biodl')
  .description('生信原始数据下载器 (BioDownloader) Linux 统一服务端与命令行终端')
  .version('2.0.38-preview');

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
      console.log(`
============================================================
🧬 BioDownloader Linux Server 启动成功！
------------------------------------------------------------
🌐 Web 管理界面 : http://${options.host === '0.0.0.0' ? '服务器IP' : options.host}:${options.port}
🚀 下载核心状态 : 100% 原生全特性就绪 (与 Windows/Mac 完全一致)
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
  .description('配置专属 Token 凭证')
  .action(async (token) => {
    if (!token) {
      const s = await main.callIpcHandler('get-settings');
      console.log('当前绑定的 Token:', s.token || '(未设置)');
    } else {
      await main.callIpcHandler('save-settings', { token });
      console.log('✅ Token 配置成功:', token);
    }
  });

// 3. biodl get: 命令行单项或批量下载
program
  .command('get <type> <accession>')
  .description('快速解析并下载生信数据 (SRA / EBI / GEO / 直链)')
  .option('-o, --output <dir>', '保存目录', process.cwd())
  .option('-c, --concurrent <number>', '并发下载数', 3)
  .action(async (type, accession, options) => {
    const s = await main.callIpcHandler('get-settings');
    if (!s.token) {
      console.error('❌ 未检测到 Token，请先执行: biodl auth <YOUR_TOKEN>');
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

// 4. biodl status: 查询下载状态与任务历史
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
