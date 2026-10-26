'use strict';
const { parentPort, workerData } = require('worker_threads');
const { NativeTransfer } = require('./native-transfer');
const task = new NativeTransfer({ ...workerData, onEvent: event => parentPort.postMessage({ event }) });
parentPort.on('message', message => { if (message === 'pause') task.pause(); });
task.run().then(result => parentPort.postMessage({ result }))
  .catch(error => parentPort.postMessage({ error: { code: error.code || 'NATIVE_ERROR', message: error.name === 'TransferError' ? error.message : '下载连接或文件写入失败；数据和断点已保留', diagnostic: require('./download-diagnostics').errorDetails(error) } }))
  .finally(() => parentPort.close());
