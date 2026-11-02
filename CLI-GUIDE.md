# 三端统一命令行

## 当前已发布 2.2.4

- Windows：完整安装目录下 `biodl.cmd`。
- Linux：解压目录下 `./biodl`，自带 Node 运行时。
- Mac：终端定义（无需另装 Node）：

```sh
biodl() {
  BIODL_HEADLESS=1 ELECTRON_RUN_AS_NODE=1 \
  BIODL_DATA_DIR="$HOME/Library/Application Support/bio-downloader-cli" \
  /Applications/BioDownloader.app/Contents/MacOS/BioDownloader \
  /Applications/BioDownloader.app/Contents/Resources/app.asar/packages/cli/bin.js "$@"
}
```

关闭同机桌面端或服务后依次运行 `biodl consent --accept`、`biodl login`、`biodl get ebi ERR164407 -o 下载目录 -c 3`。Linux 使用 `./biodl`。

SSH 登录后在远端执行，数据位于远端。前台命令不保证 SSH 断开后继续；Mac/Linux 用 tmux，Windows 用任务计划程序保存运行日志。

## 本地开发，尚未发布

- Mac 完整包新增 `Contents/MacOS/biodl` 启动脚本，后续完整包安装后才存在，热更新无法补装。
- 三端 `paths` 增加下载引擎真实路径。
- `get --engine native|aria2|axel` 临时选择 HTTP 引擎，结束恢复原设置；已有断点仍优先原引擎，不跨引擎解释断点。
- 新的端口占用检查覆盖三端，避免 CLI 清理另一个服务的加速器。

不要将未发布参数写作 2.2.4 已有功能。直接执行 aria2 路径不会自动接入应用代理、节点优选、计费和校验流程。
