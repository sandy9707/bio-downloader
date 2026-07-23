#!/bin/bash
# 01_backend_server/sync_to_baidu.sh
# 作用: 自动将最新构建的客户端安装包同步至百度网盘 /apps/baidupcs/BioDownloader 并清理历史版本。
# 设计思路: 考虑到国外 VPS 连百度云盘 API 时延高、极易超时，此脚本会自动通过本地内网中转机 (10.9.65.32)
#          拉取最新的公网发布包，并直接在内网中转机上执行高速直连上传 (免受代理及防火墙干扰)。

set -e

# 获取本地 03_desktop_app 中的当前发布版本号
VERSION=$(node -e "console.log(require('../package.json').version)")
echo ">> 检测到本地当前版本号: v$VERSION"

SSH_CMD="ssh -o ConnectTimeout=3 tenney@10.9.65.32"
if ! $SSH_CMD "echo ok" >/dev/null 2>&1; then
    echo ">> 局域网 10.9.65.32 无法直连，自动切换至外网映射通道 (123.57.140.88:12322)..."
    SSH_CMD="ssh -p 12322 tenney@123.57.140.88"
else
    SSH_CMD="ssh tenney@10.9.65.32"
fi

$SSH_CMD "
  set -e
  echo '  [2/5] 中转机正在通过代理从公网源高速下载最新包 (v${VERSION})...'
  curl -L -C - -x http://127.0.0.1:7890 -k -o /tmp/BioDownloader-${VERSION}-arm64.dmg https://biodown.ye.aimeals.cn/downloads/BioDownloader-${VERSION}-arm64.dmg
  curl -L -C - -x http://127.0.0.1:7890 -k -o /tmp/BioDownloader-${VERSION}.exe https://biodown.ye.aimeals.cn/downloads/BioDownloader-${VERSION}.exe
  
  echo '  [3/5] 重建百度网盘远程目录以清理历史版本...'
  /home/tenney/tools/baidupcs/BaiduPCS-Go rm /apps/baidupcs/BioDownloader || true
  /home/tenney/tools/baidupcs/BaiduPCS-Go mkdir /apps/baidupcs/BioDownloader
  
  echo '  [4/5] 正在极速直连上传到百度网盘 (/apps/baidupcs/BioDownloader)...'
  cd /tmp
  /home/tenney/tools/baidupcs/BaiduPCS-Go upload BioDownloader-${VERSION}-arm64.dmg BioDownloader-${VERSION}.exe /apps/baidupcs/BioDownloader
  
  echo '  [5/5] 清除临时文件并确认永久分享状态...'
  rm -f BioDownloader-${VERSION}-arm64.dmg BioDownloader-${VERSION}.exe
  /home/tenney/tools/baidupcs/BaiduPCS-Go share set --period 0 -f /apps/baidupcs/BioDownloader || true
  
  echo '>> 中转机网盘同步任务执行完毕！'
"

echo ">> ✅ v$VERSION 版本安装包已成功上传至百度网盘，并已清除旧版。"
echo ">> 📌 百度网盘永久分享链接: https://pan.baidu.com/s/16H50dDHp_t5Z7OtFJQbJTg (提取码: az54)"
