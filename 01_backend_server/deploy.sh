#!/usr/bin/env bash

# ==============================================================================
# Deployment Script for Bio-Downloader Backend Server
# Deploys code to server host configured in environment configs.
# ==============================================================================

set -eo pipefail

# 加载并解析 .env 配置文件以获取远程部署目标
ENV_FILE=""
if [ -f "../.env" ]; then
    ENV_FILE="../.env"
elif [ -f ".env" ]; then
    ENV_FILE=".env"
fi

if [ -n "$ENV_FILE" ]; then
    # 逐行读取并导出环境变量，过滤注释和空行
    while IFS= read -r line || [ -n "$line" ]; do
        # 忽略注释和空行
        if [[ ! "$line" =~ ^# ]] && [[ ! -z "$line" ]]; then
            key=$(echo "$line" | cut -d'=' -f1 | xargs)
            val=$(echo "$line" | cut -d'=' -f2- | xargs)
            export "$key=$val"
        fi
    done < "$ENV_FILE"
fi

if [ -z "$DEPLOY_SERVER" ]; then
    echo "ERROR: DEPLOY_SERVER is not set in .env file (e.g. DEPLOY_SERVER=username@your_server_ip)"
    exit 1
fi

SERVER="$DEPLOY_SERVER"
REMOTE_DIR="/home/tenney/app/bio-downloader-server"
PM2_NAME="bio-downloader-server"

# 使用 127.0.0.1:7897 本地代理加速 ssh 和 scp 上传
SSH_OPTS=(-o ProxyCommand="nc -X 5 -x 127.0.0.1:7897 %h %p")

echo "=== [1/4] Preparing remote directory on $SERVER ==="
ssh "${SSH_OPTS[@]}" "$SERVER" "mkdir -p $REMOTE_DIR"

echo "=== [2/4] Uploading files to remote server (differential sync using rsync with checksum) ==="
# 使用 rsync 增量同步，增加 -c (checksum) 校验对比内容，避免因修改时间不同而重复上传未更改的大体积 DMG/EXE 安装包
rsync -avzc --progress -e "ssh -o ProxyCommand='nc -X 5 -x 127.0.0.1:7897 %h %p'" package.json server.js downloads ../.env "$SERVER:$REMOTE_DIR/"

echo "=== [3/4] Running npm install on remote server ==="
ssh "${SSH_OPTS[@]}" "$SERVER" "cd $REMOTE_DIR && npm install --production"

echo "=== [4/4] Starting/Restarting application with PM2 ==="
ssh "${SSH_OPTS[@]}" "$SERVER" "cd $REMOTE_DIR && (pm2 delete $PM2_NAME || true) && pm2 start server.js --name $PM2_NAME && pm2 save"

echo "=== Deployment successful! ==="
ssh "${SSH_OPTS[@]}" "$SERVER" "pm2 status $PM2_NAME"
