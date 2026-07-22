---
name: bio-downloader-ops
description: >
  操作手册 Skill：专为生信原始数据下载器（bio-downloader）项目量身定制。
  记录了项目开发过程中走过的所有弯路、正确的部署流程、GitHub 仓库管理、
  服务器操作以及版本发布的最佳实践。在处理该项目相关任务时必须读取本文件。
---

# 生信原始数据下载器 · 运维操作手册

## 项目结构速览

```
/Users/yara/docyara/20260712_生信原始数据下载器/   ← 本地工作区（不上传 GitHub）
├── .env                        ← 所有敏感配置（不进 git）
├── .env.example                ← 占位符示例（可进 git）
├── 01_backend_server/          ← 后端服务（不进 git，仅本地部署）
│   ├── server.js               ← Express 主服务，含 /api/client/version
│   ├── deploy.sh               ← 一键部署到 VPS 的脚本
│   ├── sync_to_baidu.sh        ← 百度云盘同步脚本 (v1.4.6)
│   └── views/                  ← 前端静态 HTML 视图解耦文件夹
│       ├── index.html          ← 落地页下载页
│       ├── admin.html          ← 管理后台
│       └── updates.html        ← 更新日志
├── 03_desktop_app/             ← 客户端代码 = GitHub 仓库的根目录
│   ├── .git/                   ← 独立 git 仓库（remote: sandy9707/bio-downloader）
│   ├── .github/workflows/
│   │   └── build.yml           ← GitHub Actions 自动构建
│   ├── main.js / renderer.js / preload.js / index.html
│   ├── package.json
│   ├── logo.png
│   ├── bin/                    ← 内嵌二进制（mihomo v1.19.28, axel, GeoData）
│   └── README.md               ← 面向用户的公开说明
└── 04_password_reset_email_service/  ← 邮件服务（不进 git）
```

---

## 🔐 敏感凭据与管理面板 (Admin Credentials)

以下为本项目核心凭证及服务管理账号，供后续运维接管使用：

### 1. 管理后台管理端
* **后台 URL**：`https://biodown.yeyeziblog.eu.org/admin`
* **管理账号**：`admin`
* **管理密码**：`yaraadmin`
* **管理员密钥 (Token/Secret)**：`biodl_admin_2026`

### 2. 生产数据库 (Redis)
* **宿主机主机**：`127.0.0.1` (仅限本地安全环回，未对外网监听)
* **绑定端口**：`6379`
* **隔离数据库**：`db 5`
* **全局前缀**：`biodl:` (如 `biodl:user:admin`)
* **连接密码**：`redis_Kesx3B`

### 3. 三方接口与秘钥
* **易支付 API 网关**：`https://zpayz.cn` (PID: `2026070118081518` / Key: `G3VCP7yRRKPlvDf3LLx5GGEf2oh64OU8`)
* **发信 API 令牌 (Resend)**：`re_NLMfDa4M_5ZqFMKqMCr9t5uRdJznBvo7S`
* **中转节点订阅源**：`https://subbind.yeyeziblog.eu.org/speedup?token=MyqjIpxrzA8WCUCM`
* **中继机直连 SSH**：`tenney@10.9.65.32` (本地 SSH 免密授权)
* **云端服务器 SSH**：`tenney@107.175.142.245` (本地 SSH 免密授权)

---

## ⚠️ 弯路记录 — 绝对不能再犯

### 1. GitHub Token 认证失败
**弯路**：尝试用用户提供的 PAT（`ghp_xxx`）通过 `-H "Authorization: token ghp_xxx"` 访问私有仓库 releases，返回 `401 Bad credentials`。  
**原因**：Token 可能已过期或权限不足，或仓库设置限制了 fine-grained token 的 repo 访问。  
**正确做法**：**直接把仓库改为 Public**，这样 GitHub Release 资产可以匿名下载，无需任何 Token。

### 2. GitHub 仓库结构 — 不要把整个项目目录暴露
**弯路**：最初整个项目根目录都是 git 仓库，导致 `README.md`、`需求.md`、`01_backend_server/` 等全部暴露在 GitHub 上。  
**正确做法**：
- `03_desktop_app/` 本身就是 GitHub 仓库根（内有独立的 `.git/`）。
- 项目工作区根目录的旧 git 仓库（`/Users/yara/docyara/.../` 下的 `.git/`）只用于本地版本管理，不推送任何敏感内容。

### 3. Windows EXE 文件名问题
**弯路**：`electron-builder` 在打包 Windows 便携版时，会把版本号中的 `-` 替换为 `.`，导致生成文件名为 `BioDownloader.1.4.6.exe`，而服务器配置的链接是 `BioDownloader-1.4.6.exe`（连字符），造成 404。  
**正确做法**：下载时直接用 `-o` 参数重命名为标准命名（连字符版本）：
```bash
curl -L -o "BioDownloader-1.4.6.exe" "https://github.com/.../BioDownloader.1.4.6.exe"
```

### 4. 服务器文件部署 — 不要从本地下载再上传
**弯路**：在本地用 `curl` 下载 GitHub Release 的大包，再通过 `rsync`/`scp` 上传到 VPS，速度极慢（本地宽带限速）。  
**正确做法**：**让 VPS 直接从 GitHub 下载**，VPS 有专线，秒下完。

---

## 🤖 后续 Agent 接管注意事项与开发守则

### A. 网页模板解耦与 server.js 减负
- 后端服务中所有的 HTML、CSS 已经完全从 `server.js` 中抽离，放置在 `01_backend_server/views/` 目录下。
- **后续接管的 Agent 注意**：
  * 修改首页下载样式，请编辑 `views/index.html`；
  * 修改管理员控制面板，请编辑 `views/admin.html`；
  * 修改版本更新日志页面，请编辑 `views/updates.html`。
  * **切勿**重新将 HTML 以模板字符串硬编码形式写回 `server.js` 中，必须保持 `server.js` 为纯净的路由与数据控制逻辑。

### B. 内置 Clash Core 兼容限制
- 本项目目前依赖 VLESS/TLS 搭配最新的 **`XHTTP` 传输协议**。
- 客户端打包内置的 Mihomo（Clash Meta）二进制文件**强制要求内核版本 `>= v1.19.28`**。
- **后续接管的 Agent 注意**：绝不可擅自将内核降级或混用低于此版本的包，否则会导致客户端在运行节点时由于无法识别 `xhttp` 配置而大面积报错、闪退或连接超时（Timeout / EOF）。

### C. 百度云盘同步通道机制
- 由于国外 VPS 访问百度 PCS 接口有严重的网络限制及 geo-block，直接在 VPS 上上传文件极易超时（TLS handshake timeout）。
- **后续接管的 Agent 注意**：每次发布新版后，同步网盘的操作**严禁直接在 VPS 上上传**，应当在本地执行 `./sync_to_baidu.sh`。该脚本会自动利用局域网内拥有直连国内百度网络优势的**国内中继服务器 (10.9.65.32)** 完成：临时拉取公网包 $\rightarrow$ 一键重建网盘 `/apps/baidupcs/BioDownloader` 目录清理历史 $\rightarrow$ 直连上传，通常只需 25 秒即可完工。

### D. 调试接口安全净化
- 本项目目前已进入生产运行状态。所有模拟支付 (`/mock-pay.html`)、模拟确认接口 (`/api/pay/mock-confirm`) 及客户端中的调试测试按钮已全部清理下线。
- **后续接管的 Agent 注意**：严禁在生产版本中暴露任何能够绕过易支付完成额度累加的 mock 接口，若需要测试计费，应通过管理员后台 `/admin` 的“加流量/延期”操作，或使用专门的隔离测试数据库环境。

### E. 严禁试图降级回直连 (Mandatory Constraint: NO Direct Fallback)
- **强制原则**：生信原始数据（SRA/NCBI/EBI）在国内直连极慢或网络不可达。**试图在加速器开启时降级回直连是一种严重浪费时间和精力的行为，没有任何实际意义**。
- **运维与代码要求**：所有生信数据下载在加速器开启时必须 100% 路由走 Mihomo 加速通道（`http://127.0.0.1:43289`）。若出现连接超时或 502 报错，绝不能在代码中引入直连降级；应当优化 Clash `proxy-groups` 配置（如使用 `type: url-test` 自动剔除故障节点），或更新 Mihomo 内核至 `>= v1.19.28`。

---

## ✅ 标准版本发布流程（每次发新版必须按此操作）

```bash
# Step 1: 在 03_desktop_app/ 里修改代码，提交并打 tag
## 🛡️ 零失误发布与更新标准流程 (Zero-Flaw Release Pipeline)

每次发布新版本（例如 `vX.Y.Z`），任何 Agent 或维护者必须 **严格按照顺序** 执行以下 6 个步骤，切勿倒置顺序：

### 阶段一：客户端代码与 Tag 推送
1. 修改 `03_desktop_app/package.json` 中的版本号为 `X.Y.Z`。
2. 提交代码并打 tag `vX.Y.Z` 推送至 GitHub（触发 GitHub Actions 自动打包）：
   ```bash
   cd 03_desktop_app && git add . && git commit -m "release: vX.Y.Z" && git tag -a vX.Y.Z -m "release: vX.Y.Z" && git push origin main && git push origin vX.Y.Z
   ```

### 阶段二：生成 app.asar 增量热更新包
3. 打包 1.5MB 的代码热更新补丁 `patch-X.Y.Z.asar` 并写入 `01_backend_server/downloads/` 目录。

### 阶段三：等待 GitHub Actions 完成并拉取全量包至 VPS
4. 使用 `curl -sI` 验证 GitHub Actions 编译完成（约 3-4 分钟），并拉取最新的全量 DMG/EXE 至 VPS：
   ```bash
   ssh tenney@107.175.142.245 "cd ~/app/bio-downloader-server/downloads && curl -L -o BioDownloader-X.Y.Z-arm64.dmg https://github.com/sandy9707/bio-downloader/releases/download/vX.Y.Z/BioDownloader-X.Y.Z-arm64.dmg && curl -L -o BioDownloader-X.Y.Z.exe https://github.com/sandy9707/bio-downloader/releases/download/vX.Y.Z/BioDownloader.X.Y.Z.exe"
   ```

### 阶段四：百度网盘同步与服务端部署
5. 运行 `01_backend_server/sync_to_baidu.sh` 脚本，将全量包上传至百度网盘目录 `/apps/baidupcs/BioDownloader`。
6. 更新 `server.js` 中的 `/api/client/version` 接口（确保全局唯一，删除旧版本配置），更新 `views/index.html` 落地页，运行 `./deploy.sh` 完成部署。

---

## 版本更新检测机制

客户端 **不走 GitHub API**，走自有后端：

```
客户端"检查更新"按钮
  → IPC: window.electron.checkForUpdates()
  → main.js: GET {BACKEND_BASE_URL}/api/client/version
  → server.js 返回 { version, winUrl, macUrl, releaseNotes }
  → 与当前版本比对，有新版则显示更新卡片和下载链接
```

`server.js` 中版本 API 位置：`app.get('/api/client/version', ...)`。
