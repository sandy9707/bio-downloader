<p align="center">
  <img src="logo.png" alt="BioDownloader Logo" width="120"/>
</p>

<h1 align="center">生信原始数据下载器 · BioDownloader</h1>

<p align="center">
  <strong>一款专为生物信息学研究设计的原始数据极速下载工具</strong><br/>
  支持 SRA / EBI / GEO / 直链，多线程加速，跨平台桌面客户端
</p>

<p align="center">
  <a href="https://github.com/sandy9707/bio-downloader/releases/latest">
    <img src="https://img.shields.io/github/v/release/sandy9707/bio-downloader?style=for-the-badge&label=最新版本&color=4f46e5" alt="Latest Release"/>
  </a>
  <img src="https://img.shields.io/badge/平台-Windows%20%7C%20macOS-blue?style=for-the-badge" alt="Platform"/>
  <img src="https://img.shields.io/badge/协议-16线程加速-green?style=for-the-badge" alt="Threads"/>
</p>

---

## ⬇️ 下载客户端

| 平台 | 下载地址 | 说明 |
|------|----------|------|
| 🍎 **macOS** (Apple Silicon / Intel) | [下载 .dmg](http://107.175.142.245:13000/downloads/BioDownloader-1.2.5-arm64.dmg) | 双击打开后拖入「应用程序」文件夹 |
| 🪟 **Windows** 64位 | [下载 .exe](http://107.175.142.245:13000/downloads/BioDownloader-1.2.5.exe) | 单文件免安装，双击直接运行 |

> 也可以在 [GitHub Releases](https://github.com/sandy9707/bio-downloader/releases/latest) 页面下载最新版本。

---

## ✨ 核心功能

- 🧬 **多数据源支持** — SRA (NCBI)、EBI、GEO、HTTP/FTP 直链，一站式覆盖主流数据库
- ⚡ **16 线程极速下载** — 内置 Axel 多线程加速，相比单线程提速数倍
- 📊 **下载前预估大小** — 点击"检验下载大小"可在下载前获取文件总大小
- 🔄 **智能代理加速** — 内置 Clash 内核，一键连接国际加速节点（订阅制）
- 👤 **账户系统** — 支持注册/登录，绑定邮箱，订阅套餐管理
- 🔔 **客户端内更新检测** — 设置页面一键检查并跳转下载最新版本
- 🖥️ **跨平台** — 支持 macOS（Apple Silicon M1-M4 + Intel）和 Windows 10/11 64位

---

## 🚀 使用方法

1. **下载并安装**客户端（见上方下载链接）
2. 启动软件，进入「**我的**」页面注册并登录账户
3. 进入「**下载中心**」，选择数据类型：
   - **SRA** — 输入 SRR/SRX/SRP 编号
   - **EBI** — 输入 ENA 数据编号
   - **GEO** — 输入 GSE/GSM 编号
   - **直链** — 粘贴任意 HTTP/FTP 下载链接
4. 点击「**检验下载大小**」确认后，点击「**开始下载**」

---

## 🍎 macOS 提示「已损坏，打不开」解决方法

由于本软件未购买 Apple 开发者证书，macOS 首次打开可能会提示「已损坏」或「来自未识别的开发者」。请按以下步骤解锁：

1. 打开系统自带的 **终端（Terminal）**
2. 输入以下命令并回车（需要输入您的 Mac 开机密码）：

```bash
sudo xattr -cr /Applications/BioDownloader.app
```

3. 再次双击软件即可正常打开。

---

## 🏗️ 构建说明

本仓库为客户端自动构建仓库，推送 `v*` 格式 tag 即可触发 GitHub Actions 自动打包 macOS DMG 和 Windows EXE。

```bash
git tag -a v1.2.5 -m "release: v1.2.5"
git push origin v1.2.5
```
