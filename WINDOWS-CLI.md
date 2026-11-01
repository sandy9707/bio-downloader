# Windows SSH 命令行（首次发布）

安装后，SSH 登录 Windows，在安装目录执行 `biodl.cmd`。无需额外安装 Node.js。
PowerShell 可使用：

```powershell
& "$env:LOCALAPPDATA\Programs\BioDownloader\biodl.cmd" --help
& "$env:LOCALAPPDATA\Programs\BioDownloader\biodl.cmd" consent --accept
& "$env:LOCALAPPDATA\Programs\BioDownloader\biodl.cmd" login -u 用户名
& "$env:LOCALAPPDATA\Programs\BioDownloader\biodl.cmd" get ebi ERR164407 -o D:\数据 -c 3
& "$env:LOCALAPPDATA\Programs\BioDownloader\biodl.cmd" paths
```

自定义安装位置请使用该目录的 `biodl.cmd`。密码按交互提示输入；不建议写入命令行历史。

- CLI 配置默认 `%APPDATA%\bio-downloader-cli`，与桌面客户端分离；可用 `BIODL_DATA_DIR` 指定持久目录。
- 使用前关闭同机桌面 BioDownloader；不能同时启动多个 CLI 下载进程共用代理端口。
- 默认下载到桌面。重新执行相同命令、保持相同源地址及输出目录可恢复兼容断点。
- 当前为前台命令：SSH 断开后进程可能结束。需要后台执行时使用 Windows 任务计划程序运行同一命令，并自行保存输出日志；本版不承诺 SSH 断开后继续运行。
- 软件不负责在网吧电脑安装或开放 SSH。仅在有权限使用的电脑上运行。
- `start` 提供 Web 服务，默认会监听所有地址；仅需本地访问时明确使用 `start --host 127.0.0.1`，通过 SSH 本地转发访问。
- Windows 自更新请使用完整安装包；不要使用 Linux 原地更新命令替换 Windows 程序。

下载核心与桌面相同，保持 Range、ETag、断点完整性检查。性能受本地出口、源站和节点影响，不能保证任何网络下快于 Clash + aria2。
