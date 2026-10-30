# BioDownloader 发布契约

公开仓库只含客户端。应用内「检查更新」读的是生产后端清单，**不是** GitHub Releases 页面本身。

## 通道

| 通道 | API | 清单文件 | 用途 |
|------|-----|----------|------|
| 正式 2.x | `/api/client/version?channel=2` | `update_manifest_2x*.json` | 默认正式用户 |
| 预览 P2 | `/api/client/version?channel=P2` | `update_manifest_P2.json` | 高级模式或已是 `*-preview` 客户端 |
| 1.x | `/api/client/version?channel=1` | `update_manifest.json` | 老客户端 |

## 预览版完整步骤（必须全部完成）

1. 客户端工作树改 `package.json` version 为 `x.y.z-preview`，提交。
2. 打 tag `v x.y.z-preview` 并 push，等 GitHub Actions 打出三端安装包并创建 **prerelease**。
3. 本机 `RELEASE_NOTES='…' node build_patch.js` 生成并 **Ed25519 签名** `patch-<version>.asar`，写入本地 `01_backend_server/downloads/update_manifest_P2.json`。
4. 补齐清单中的 `linuxUrl` / `linuxSha256` 与 `?source=github` 下载地址；核对 GitHub 安装包 digest。
5. 上传 `patch-<version>.asar` 到该 GitHub prerelease。
6. 生产服务器（白名单）：
   - 备份 `before/update_manifest_P2.json` 与保护文件摘要
   - 下载并校验四资产（EXE / DMG / Linux tar.gz / patch）
   - 验签补丁
   - 复制新版本文件到 `downloads/`（不覆盖已有同名不同摘要）
   - **仅**原子替换 `downloads/update_manifest_P2.json`
   - 不改正式清单、不重启服务、不改数据库
7. 公网核验：P2=`新版本`，channel=2 / GitHub Latest 仍为正式版；四资产 HEAD 大小一致；补丁全文 SHA256 + Ed25519 通过。

参考证据目录：`.agents/update-reliability-20261025/`、`.agents/release-2.2.3-preview-20261029/`。

## 正式版额外要求

正式发布还需同步 `update_manifest_2x*.json`（含 win32 可能关闭热更补丁）、changelog，并单独授权；不要把预览步骤当成正式发布。

## 客户端可见性

- 正式版未开高级模式：只看 channel=2，看不到 P2。
- 正式版开启高级模式，或当前版本含 `-preview`：会请求 P2。

## 推送 Tag 前强制预检防线（防范 GitHub Actions Linux / Mac 构建失败）

经统计近期 GitHub Actions 失败与重跑记录，Mac / Linux 构建报错集中在以下 5 类原因。**每次打 `v*` Tag 推送前，必须在本机逐条核对通过，严禁盲推 Tag 试错：**

1. **Linux 桥接与 HTML 同步断层（高频必挂项）**
   - 凡修改 `index.html`、`speedtest.html`，必须先运行 `node scripts/sync-linux-web.js` 同步生成 `packages/web/`。
   - 凡在 `preload.js` 或 `main.js` 新增 IPC 方法/事件，必须同步补齐 `packages/web/web-bridge.js` 与 `packages/cli/server.js`（`forwardEvents`），并运行 `node scripts/check-web-bridge-contract.js` 验证。
2. **Linux 独立包与 `2.0.41` 原地升级依赖缺失（Linux 专属必挂项）**
   - 桌面端由 `electron-builder` 自动收集 `node_modules`，但 Linux 版由 `scripts/build-linux.js` 手工拷贝白名单，且 CI 会实测从 `2.0.41` 老目录原地升级（`scripts/check-linux-upgrade.js`）。
   - 凡新增任何第三方 `require('xxx')` 依赖，必须同时：① 加入 `scripts/build-linux.js` 打包列表；② 确保 `linux-self-update` 原地升级后旧目录可解析该模块（内置 vendor 或随升级包写入），并在本机执行 `npm run build:linux` 校验。
3. **Mac / Linux 本地回环速度过快引发的测试竞态（改动并发/节流必测）**
   - GitHub 的 Linux 与 Apple Silicon Mac Runner 本地 `127.0.0.1` 吞吐极快，若初始并发连接数过高（如直接 16 并发起跳），测试小文件会在首个 `250ms` IPC 进度回调触发前传完，导致 `check-native-app.js --stress` 的强杀恢复或取消窗口断言失败。
   - 凡调整 `native-transfer` 连接数、分块大小或进度节流间隔，推送前必须在本机实跑通过：
     ```bash
     node scripts/check-native-transfer.js && node scripts/check-native-app.js --stress && rm -rf .evidence
     ```
4. **`renderer.js` 孤立 VM 上下文全局变量未兜底**
   - `check-transfer-persistence.js`、`check-installer-download.js` 等回归脚本会用 `vm.runInContext` 单独截取 `renderer.js` 内的渲染函数（如 `renderCompletedList`、`downloadUpdate`）在空白上下文执行。
   - 在此类函数内引用任何新增顶层 `const/let` 状态（如集合、配置项）时，必须加 `typeof xxx !== 'undefined'` 保护，并在本机跑完完整 `npm test`。
5. **公网 EBI 源站对 GitHub Runner 共享 IP 偶发限流（HTTP 403）与 Windows 冷启动超时**
   - `check-live-ebi-download.js` 直连 `ftp.sra.ebi.ac.uk` 下载 101 MB 真实生信文件；GitHub Mac / Ubuntu 共享出口 IP 偶发触发源站防火墙限流返回 `HTTP 403`（非代码回归）。
   - Windows `check-packaged-update.js` 偶发受 Runner 上 Windows Defender 首次扫描未签名 EXE 影响超出 90s 启动确认窗口。
   - **处置准则**：先查看 `gh run view <id> --log-failed` 区分代码断言错误与外部环境抖动；确认为 EBI `HTTP 403` 或成品冷启动超时后，使用 `gh run rerun <id> --failed` 仅重跑失败 Job，切勿盲目改业务代码或重复打新 Tag。
