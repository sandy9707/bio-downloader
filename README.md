# 生信数据加速下载器 - 商业版源码系统

本项目是一个商业级跨平台桌面端应用（支持 macOS 与 Windows），集成了 Clash 代理客户端和 Axel 多线程下载加速引擎，旨在解决国内学者在下载 NCBI SRA、EBI ENA、GEO 等生物原始数据文件时速度慢、极易中断的问题。

---

## 编程与目录规范 (Keep Root Clean)

根据开发守则，本项目根目录保持纯净，所有核心步骤已根据逻辑和开发顺序保存在独立的文件夹中。每一大步均带有对应的 `README.md` 详尽说明文档。

### 目录结构

* [01_backend_server/](file:///Users/yara/docyara/20260712_生信原始数据下载器/01_backend_server) : 云端鉴权与计费后端服务（Express + Redis db 5）。
* [02_binaries/](file:///Users/yara/docyara/20260712_生信原始数据下载器/02_binaries) : 跨平台 Clash (Mihomo) & Axel 二进制可执行文件目录。
* [03_desktop_app/](file:///Users/yara/docyara/20260712_生信原始数据下载器/03_desktop_app) : 基于 Electron + HTML/Vanilla CSS/JS 的跨平台加速下载器客户端。
* [参考/](file:///Users/yara/docyara/20260712_生信原始数据下载器/参考) : 生信数据拉取和老版支付参考文件。

---

## 核心商业运行链路说明

1. **流量充值与账户系统**：
   - 购买套餐（100G / 10元 / 60天）采用易支付（Epay）接口进行集成（同时支持沙箱模拟支付进行测试）。
   - 用户名密码为极速 mock 注册，无需二次邮箱绑定确认（预留接口）。
2. **Clash 机场防盗与动态代理**：
   - 云端鉴权服务器（端口 13000）持有一条开发者持有的高带宽 Clash 机场节点池订阅。
   - 客户端输入用户专属 token，服务器验证其有效期和流量额度充足后，反代返回该配置并直接透传 YAML 格式。**该设计完全对客户端隐藏了真正的节点账号密码与订阅源**。
   - 客户端主进程接收 YAML 后写盘，启动内置的 Clash 守护进程监听 `127.0.0.1:7890` 端口。
3. **Axel 多线程高速安全下载**：
   - 客户端核对待下载的生信编号（SRR/ERR/GSE）总大小，若额度足够，配置代理环境变量启动 `axel -n 16` 多线程下载。
   - 客户端实时监听子进程 stdout 输出，正则解析下载进度百分比和实时速度（KB/MB 每秒），投递至前端展示精美的动态进度条。
   - 下载正常结束后，客户端会自动向服务器发送流量扣除请求（`POST /api/user/consume`），扣除对应下载文件的实际字节大小。

---

## 部署与本地运行快速指引

### 1. 后端部署
后端已自动发布并上线至生产服务器：
* **VPS 地址**：`tenney@107.175.142.245`
* **绑定端口**：`13000` (PM2 进程名为 `bio-downloader-server`)
* **Redis 安全策略**：直接连用本地 Redis 容器，指定隔离的 `db: 5` 和 `biodl:` 前缀，确保不污染其他生产服务。
* **部署脚本**：
  若在本地修改了后端代码，可在 `01_backend_server` 目录下执行 `./deploy.sh` 自动完成云同步、依赖安装以及 PM2 重启。

### 2. 客户端运行
在本地调试客户端：
```bash
cd 03_desktop_app
npm install
npm start
```
登录已注册的账号，选择目标文件夹，输入编号后即可享受 16 线程的住宅代理下载加速服务！

---

## 客户端安装包下载与打包指引

### 1. 自动编译下载（推荐）
本项目配置了 GitHub Actions 持续集成（CI/CD）工作流。每当推送新版本 Git Tag 时，GitHub 会自动为 **Windows** 和 **macOS** 平台编译出最新的生产发布包：
* 📥 **[官方最新发布页 (GitHub Releases)](https://github.com/sandy9707/bio-downloader/releases)**
  * **Windows 客户端**：提供免安装绿色单文件版（直接运行）及标准的 Setup 安装程序。
  * **macOS 客户端**：提供标准 APFS 磁盘映像（DMG）安装包及免安装的 ZIP 压缩包。

### 2. 本地手动编译打包
如果您希望在本地编译生成对应的安装包，可在安装依赖后执行如下构建指令：
```bash
cd 03_desktop_app
npm run dist
```
构建成功后，所有安装程序包将输出在 `03_desktop_app/dist/` 目录下：
* **macOS DMG 安装包**：`dist/BioDownloader-1.2.2-arm64.dmg`
* **macOS 绿色压缩版**：`dist/BioDownloader-1.2.2-arm64-mac.zip`
