# Linux：更新、数据目录与 SSH 访问

适用于 2.2.0-preview.2 及后续兼容版本。本版仅为预览版，正式版仍为 2.1.2。

## 数据与更换程序目录

- 默认配置、登录凭证、Web 会话、传输历史和日志：当前 Linux 用户的 `~/.bio-downloader/`。
- 默认下载文件：`~/Downloads/`，或每项任务选择的目标目录。断点文件和原文件在一起，必须一起保留。
- `BIODL_DATA_DIR` 可以覆盖配置目录；所有启动、更新、CLI 命令应使用同一用户和同一环境变量。
- `./biodl paths` 会显示实际目录，不显示密码或 Token。
- 删除解压的软件目录通常不会删除默认用户数据。但如果手动把下载目录或 `BIODL_DATA_DIR` 放进软件目录，必须先备份、迁移并更新路径。不要直接删除旧目录后才检查。
- 切换 Linux 用户、使用 sudo 启动或改动 `BIODL_DATA_DIR`，会读取另一份配置，看起来像“数据丢失”。

更新前先暂停下载，确认断点已保存，再停止后台服务。配置备份包含登录凭证，请私下保存。不要把它上传到公开网盘或提交日志。

## 更新

在软件目录执行：

```bash
./biodl --version
./biodl paths
./biodl update --check
./biodl update
```

`update` 默认保持当前正式/预览通道，正式版不会自动升级到预览版。明确选择预览：

```bash
./biodl update --preview --check
./biodl update --preview
```

`--preview`、`--check`、`paths`、`doctor` 是本预览新增命令。旧版可运行 `./biodl update`；首次进入本预览可从官网的预览发行页下载三端对应包。包内置依赖，保持原配置目录即可。安装后执行 `./biodl --version` 核实。

更新程序文件后，要重新启动服务再刷新浏览器。前台启动的按 Ctrl+C 停止；PM2/systemd 管理的用原管理器停止/启动；nohup 启动的先用 `ps -fu "$USER"` 查出本软件的确切 PID，再 `kill -TERM PID`，勿结束其他任务。重启示例：

```bash
cd ~/BioDownloader-Linux-x64
nohup ./biodl start --host 127.0.0.1 </dev/null > biodl.log 2>&1 &
disown
```

两条后台启动命令在同一个 Bash/Zsh 中执行；不要同时用 nohup 和进程管理器启动两份。SSH 模式只监听本机，不必开放 43280 公网端口。

网络连通性检查：`./biodl doctor`（不检测网络类型、不读取账号密码）。若服务器本身断网，先恢复网络，重装软件不会修复断网。

## 从 Mac / Windows 访问：推荐桌面插件

在本预览桌面客户端打开 **扩展插件 → SSH · 连接 Linux Web → 配置 SSH 连接**。

填写服务器、SSH 用户名/端口，以及密码或私钥。Web 端口默认 43280，本机端口填 0 自动分配。点击“连接并打开网页”，首次核对服务器指纹后确认。无需安装系统 OpenSSH，也无需 root。密码和私钥口令只用于本次认证，不保存到配置或 BioDownloader 服务端。服务器必须允许该账号进行 SSH 端口转发。

关闭桌面客户端会关闭隧道；服务器上的下载服务继续运行。更改服务器后可先断开再连接。指纹变化会拒绝连接，需与管理员核实后处理。

## 不安装桌面版：SSH 命令

Mac 打开“终端”。Windows 10/11 打开 **PowerShell** 或 **Windows Terminal**，先执行 `ssh -V`。若提示找不到命令，在系统“可选功能”安装 **OpenSSH 客户端**（不需要安装 SSH 服务端）；无安装权限时可使用上述桌面插件。

在自己的电脑执行（替换账号、服务器地址和 SSH 端口）：

```bash
ssh -N -L 127.0.0.1:43280:127.0.0.1:43280 -p 22 -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 用户名@服务器地址
```

然后在本机浏览器打开 `http://127.0.0.1:43280`。保持这个终端开启；Ctrl+C 断开。若本机 43280 已被占用，只把第一个 43280 改成 43281，并访问本机 43281。密钥登录可增加 `-i 私钥路径`。

这是 `-L` 本地转发，`-D` 用于 SOCKS 代理，`-R` 是远端转发，不是此处所需。SSH 端口必须能从本机访问；如果服务器明确禁用端口转发，需要管理员按其管理政策允许。

官方参考：[OpenSSH 命令说明](https://man.openbsd.org/ssh)、[Windows OpenSSH 安装](https://learn.microsoft.com/en-us/windows-server/administration/openssh/openssh_install_firstuse)。

## 使用声明

Web 首次使用可选择“我已知悉并确认使用”或“不使用”；只保存选择，不检测网络。CLI 使用 `./biodl consent` 查看，明确确认可执行 `./biodl consent --accept`，拒绝可执行 `./biodl consent --decline`。
