# BioDownloader 发布流程

## 版本号

- 正式版：`x.y.z`（例如 `2.2.2`）
- 预览版：`x.y.z-preview` 或 `x.y.z-preview.N`（例如 `2.2.3-preview`）

改 `package.json` 的 `version` 后提交，再打同名 tag（带 `v` 前缀）。

## 标准发布（正式版与预览版相同）

1. 确认工作树干净，本地测试通过。
2. 更新 `package.json` → `version`。
3. 提交，例如：`chore(release): 2.2.3-preview`。
4. 打 tag 并推送：

```bash
git tag -a "v2.2.3-preview" -m "v2.2.3-preview"
git push origin HEAD
git push origin "v2.2.3-preview"
```

5. GitHub Actions `Build & Release` 在推送 `v*` tag 时自动：
   - 构建 macOS DMG、Windows EXE、Linux tar.gz
   - 跑回归与真实下载验收
   - 创建 GitHub Release；**tag 名含 `preview` 时标记为 prerelease**

6. 在 Actions 与 Releases 页确认三端资产齐全后再通知用户。

## 仅验证、不发版

使用 Actions 的 `workflow_dispatch`（可选 platform=`windows` / `all`）只构建并上传 artifacts，**不会**创建 Release（`release` job 仅在 `refs/tags/` 下运行）。

## 同版本补丁重发

若需在同一 preview 版本上补提交后再发：

```bash
git tag -d "v2.2.3-preview"
git push origin ":refs/tags/v2.2.3-preview"
git tag -a "v2.2.3-preview" -m "v2.2.3-preview"
git push origin "v2.2.3-preview"
```

## 注意

- 公开仓库只含客户端；后端地址、密钥不进仓。
- Windows 旧版热更新若不可靠，预览说明中应提示先装完整 EXE。
