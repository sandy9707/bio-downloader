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
