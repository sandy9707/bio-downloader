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

NVM_INIT="export NVM_DIR=\"\$HOME/.nvm\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\";"

echo "=== [1/4] Preparing remote directory on $SERVER ==="
ssh "$SERVER" "mkdir -p $REMOTE_DIR"

echo "=== [2/4] Uploading files to remote server (differential sync using rsync with checksum) ==="
rsync -avzc --progress package.json server.js views downloads ../.env "$SERVER:$REMOTE_DIR/"

echo "=== [3/4] Running npm install on remote server ==="
ssh "$SERVER" "$NVM_INIT cd $REMOTE_DIR && npm install --production"

VERSION=$(node -e "console.log(require('../package.json').version)")
echo "=== [3.5/4] Ensuring full release binaries (v${VERSION}) are present in remote downloads directory ==="
ssh "$SERVER" "cd $REMOTE_DIR/downloads && (wget -c -O BioDownloader-${VERSION}-arm64.dmg https://gh-proxy.org/https://github.com/sandy9707/bio-downloader/releases/download/v${VERSION}/BioDownloader-${VERSION}-arm64.dmg || true) && (wget -c -O BioDownloader-${VERSION}.exe https://gh-proxy.org/https://github.com/sandy9707/bio-downloader/releases/download/v${VERSION}/BioDownloader.${VERSION}.exe || true)"

echo "=== [4/4] Starting/Restarting application with PM2 ==="
ssh "$SERVER" "$NVM_INIT cd $REMOTE_DIR && (pm2 delete $PM2_NAME || true) && pm2 start server.js --name $PM2_NAME && pm2 save"

echo "=== Deployment successful! ==="
ssh "$SERVER" "$NVM_INIT pm2 status $PM2_NAME"
