#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const rootDir = path.resolve(__dirname);
const scratchDir = path.join(rootDir, 'scratch', 'app_source');
const backendDownloadsDir = path.join(rootDir, '01_backend_server', 'downloads');

// 获取 package.json 中的当前版本
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const version = pkg.version;

console.log(`=== [1/4] Clean & Prepare App Source Directory (v${version}) ===`);
if (fs.existsSync(scratchDir)) {
  fs.rmSync(scratchDir, { recursive: true, force: true });
}
fs.mkdirSync(scratchDir, { recursive: true });

// 复制客户端源码核心文件
const filesToCopy = ['main.js', 'renderer.js', 'preload.js', 'index.html', 'logo.png'];
for (const file of filesToCopy) {
  const src = path.join(rootDir, file);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(scratchDir, file));
  }
}

// 写入专门用于热更新的 package.json (只保留纯生产依赖)
const patchPkg = {
  name: "bio-downloader",
  version: version,
  main: "main.js",
  dependencies: {
    "axios": "^1.6.8",
    "cheerio": "^1.0.0-rc.12"
  }
};
fs.writeFileSync(path.join(scratchDir, 'package.json'), JSON.stringify(patchPkg, null, 2));

console.log('=== [2/4] Running Clean npm install for Complete Transitive Dependencies ===');
execSync('npm install --omit=dev --no-audit', { cwd: scratchDir, stdio: 'inherit' });

console.log('=== [3/4] Verifying All Production Modules Loading Safely ===');
try {
  require(path.join(scratchDir, 'node_modules', 'axios'));
  require(path.join(scratchDir, 'node_modules', 'form-data'));
  require(path.join(scratchDir, 'node_modules', 'cheerio'));
  require(path.join(scratchDir, 'node_modules', 'es-set-tostringtag'));
  console.log('✅ Verification Passed: All modules including es-set-tostringtag loaded successfully!');
} catch (err) {
  console.error('❌ Verification Failed:', err.message);
  process.exit(1);
}

console.log(`=== [4/4] Packing asar patch: patch-${version}.asar ===`);
if (!fs.existsSync(backendDownloadsDir)) {
  fs.mkdirSync(backendDownloadsDir, { recursive: true });
}
const outAsar = path.join(backendDownloadsDir, `patch-${version}.asar`);
execSync(`npx @electron/asar pack "${scratchDir}" "${outAsar}"`, { stdio: 'inherit' });

const stats = fs.statSync(outAsar);
console.log(`🎉 Patch packaged successfully: ${outAsar} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
