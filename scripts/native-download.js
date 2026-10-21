#!/usr/bin/env node
'use strict';
const { program } = require('commander');
const { NativeTransfer } = require('../src/experimental/native-transfer');
program.name('biodl-native').description('BioDownloader 独立候选内核；不修改正式客户端设置')
  .argument('<url>').requiredOption('-o, --output <path>').option('-j, --connections <n>', '并发连接数', '4')
  .option('--proxy <url>', '明确指定 HTTP 代理（加速模式使用现有 Mihomo）').option('--direct', '明确选择直连')
  .option('--block-mib <n>', '分块大小 MiB', '4').parse();
const options = program.opts();
if (Boolean(options.proxy) === Boolean(options.direct)) program.error('必须且只能选择 --proxy 或 --direct');
let proxy = false;
if (options.proxy) { const u = new URL(options.proxy); if (u.protocol !== 'http:' || u.username || u.password) program.error('代理需为无内嵌凭据的 HTTP 地址'); proxy = { protocol: 'http', host: u.hostname, port: Number(u.port || 80) }; }
let task;
try {
  task = new NativeTransfer({ url: program.args[0], filename: options.output, proxy,
    connections: Number(options.connections), blockSize: Number(options.blockMib) * 1024 * 1024,
    onEvent: event => { if (event.type !== 'progress') process.stdout.write(JSON.stringify(event) + '\n'); } });
  let last = 0; const observer = task.options.onEvent;
  task.options.onEvent = event => { if (event.type === 'progress') { if (Date.now() - last > 1000) { last = Date.now(); process.stdout.write(JSON.stringify(event) + '\n'); } } else observer(event); };
  process.once('SIGINT', () => task.pause()); process.once('SIGTERM', () => task.pause());
  task.run().then(result => { process.exitCode = result.status === 'paused' ? 75 : 0; })
    .catch(e => { console.error(JSON.stringify({ error: e.code || 'UNKNOWN', message: e instanceof require('../src/experimental/native-transfer').TransferError ? e.message : '系统或网络错误；已保留文件和断点' })); process.exitCode = 1; });
} catch (e) { console.error(e.message); process.exitCode = 1; }
