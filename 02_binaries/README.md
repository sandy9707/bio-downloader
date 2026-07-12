# 步骤 2：内置 Clash 与 Axel 二进制文件说明

本目录保存了跨平台桌面客户端所需的后台执行程序。在构建或打包桌面应用时，这些二进制文件将被整合进应用的资源目录中。

---

## 目录结构

```text
02_binaries/
├── darwin/                      # macOS (Intel & Apple Silicon) 二进制文件
│   ├── axel                     # macOS (Sequoia arm64) 下载加速器
│   ├── mihomo_aarch64           # macOS Apple Silicon 架构 Clash 内核
│   └── mihomo_x86_64            # macOS Intel 架构 Clash 内核
└── win32/                       # Windows (x64) 二进制文件
    ├── mihomo_windows_x86_64.exe # Windows 64位 Clash 内核
    └── (axel.exe)               # Windows 下载加速器 (见下文说明)
```

---

## Windows 环境下 Axel 的准备说明

由于 `Axel` 原生为 POSIX 规范编写，在 Windows 运行必须依赖 **MSYS2** 运行库。

当您在 Windows 平台打包该应用时，请按照以下步骤操作：
1. 下载并安装 [MSYS2](https://www.msys2.org)。
2. 打开 MSYS2 终端，运行 `pacman -S axel` 安装加速器。
3. 从 MSYS2 的安装目录（通常为 `C:\msys64\usr\bin\`）拷贝以下文件，并放入最终打包的 `bin/win32/` 目录下：
   - `axel.exe`
   - `msys-2.0.dll`
   - `msys-crypto-3.dll`
   - `msys-ssl-3.dll`
4. 为支持 HTTPS 链接，需要把 CA 证书（例如从 `https://curl.se/docs/caextract.html` 下载的 `cacert.pem`）配置为系统环境变量或放在同目录。

---

## 应用内的动态路径加载逻辑

在客户端 `03_desktop_app` 运行中，后台主进程（Node.js）会根据用户的操作系统架构动态选择要执行的二进制文件：
```javascript
const os = require('os');
const path = require('path');

function getClashBinaryPath() {
  const platform = os.platform();
  const arch = os.arch();
  
  if (platform === 'darwin') {
    return arch === 'arm64' 
      ? path.join(__dirname, 'bin', 'darwin', 'mihomo_aarch64')
      : path.join(__dirname, 'bin', 'darwin', 'mihomo_x86_64');
  } else if (platform === 'win32') {
    return path.join(__dirname, 'bin', 'win32', 'mihomo_windows_x86_64.exe');
  }
  throw new Error('Unsupported platform: ' + platform);
}

function getAxelBinaryPath() {
  const platform = os.platform();
  if (platform === 'darwin') {
    return path.join(__dirname, 'bin', 'darwin', 'axel');
  } else if (platform === 'win32') {
    return path.join(__dirname, 'bin', 'win32', 'axel.exe');
  }
  throw new Error('Unsupported platform: ' + platform);
}
```
