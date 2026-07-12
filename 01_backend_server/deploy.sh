#!/usr/bin/env bash

# ==============================================================================
# Deployment Script for Bio-Downloader Backend Server
# Deploys code to tenney@107.175.142.245 and starts/restarts PM2 process.
# ==============================================================================

set -eo pipefail

SERVER="tenney@107.175.142.245"
REMOTE_DIR="/home/tenney/app/bio-downloader-server"
PM2_NAME="bio-downloader-server"

echo "=== [1/4] Preparing remote directory on $SERVER ==="
ssh "$SERVER" "mkdir -p $REMOTE_DIR"

echo "=== [2/4] Uploading files to remote server ==="
# 使用 scp 上传 package.json 和 server.js
scp package.json server.js "$SERVER:$REMOTE_DIR/"

echo "=== [3/4] Running npm install on remote server ==="
ssh "$SERVER" "cd $REMOTE_DIR && npm install --production"

echo "=== [4/4] Starting/Restarting application with PM2 ==="
ssh "$SERVER" "cd $REMOTE_DIR && (pm2 delete $PM2_NAME || true) && pm2 start server.js --name $PM2_NAME && pm2 save"

echo "=== Deployment successful! ==="
ssh "$SERVER" "pm2 status $PM2_NAME"
