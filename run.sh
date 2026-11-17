#!/bin/sh
# 抖音云容器启动脚本
# ─────────────────────────────────────────
# 平台通过执行 /opt/application/run.sh 启动服务（自定义镜像需拷到该路径）。
# 必须具有可执行权限，否则发布报 permission denied：
#   chmod a+x run.sh
set -e

cd "$(dirname "$0")"

# 抖音云只接受 8000 端口，这里显式兜底，避免环境变量缺失时退回别的端口
export PORT=8000
export NODE_ENV=production

echo "[run.sh] starting node index.js on port $PORT"
exec node index.js
