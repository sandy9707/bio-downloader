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
| 🍎 **macOS** (Apple Silicon / Intel) | [下载 .dmg](https://biodown.yeyeziblog.eu.org/downloads/BioDownloader-1.4.6-arm64.dmg) | 双击打开后拖入「应用程序」文件夹 |
| 🪟 **Windows** 64位 | [下载 .exe](https://biodown.yeyeziblog.eu.org/downloads/BioDownloader-1.4.6.exe) | 单文件免安装，双击直接运行 |

> 也可以在 [GitHub Releases](https://github.com/sandy9707/bio-downloader/releases/latest) 页面下载最新版本。

---

## ✨ 核心功能

- 🧬 **多数据源支持** — SRA (NCBI)、EBI、GEO、HTTP/FTP 直链，一站式覆盖主流数据库。
- ⚡ **16 线程极速下载** — 内置 Axel 多线程加速，相比单线程提速数倍。
- 📊 **下载前预估大小** — 点击"检验下载大小"可在下载前获取文件总大小，且在远程大小获取异常时智能容错判定，避免误删本地历史已完成文件。
- 🔄 **智能代理加速 (内核升级)** — 内置 **Mihomo v1.19.28** 代理核心，完美适配并支持 XHTTP 高级传输协议，大幅提升学术节点连接鲁棒性与速度。
- 👥 **推广邀请与返利机制 (新)** — 支持生成专属邀请码与专属分享链接，邀请好友充值后可终身享受其消费额 **50%** 的余额返利。
- 💰 **返利余额全额抵扣** — 支持直接使用返利余额购买流量，免去充值步骤。
- 🛠️ **节点连通性与测速诊断** — 内置中科院网页测速与加速代理节点延迟延迟核验工具。
- 📋 **详细诊断日志系统** — 在重现下载波动时支持一键向管理员后台上报诊断日志，便于排查解决下载报错。

---

## 🚀 使用方法

1. **下载并安装**客户端（见上方下载链接）
2. 启动软件，进入「**我的**」页面注册并登录账户（可填写推荐人的邀请码）
3. 进入「**流量商店**」，选择套餐购买（支持支付宝与余额扣减支付）
4. 进入「**下载中心**」，选择数据类型：
   - **SRA** — 输入 SRR/SRX/SRP 编号
   - **EBI** — 输入 ENA 数据编号
   - **GEO** — 输入 GSE/GSM 编号
   - **直链** — 粘贴任意 HTTP/FTP 下载链接
5. 点击「**检验下载大小**」确认后，点击「**开始下载**」

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

## 🏗️ 构建与部署说明

本仓库为客户端自动构建仓库，推送 `v*` 格式 tag 即可触发 GitHub Actions 自动打包 macOS DMG 和 Windows EXE。

```bash
git tag -a v1.4.6 -m "release: v1.4.6"
git push origin v1.4.6
```
