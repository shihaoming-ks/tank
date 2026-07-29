#!/usr/bin/env bash
#
# 构建离线便携包
#
# 产出一个自包含 tar.gz：内含 Node 运行时 + 源码 + 依赖 + 启动脚本，
# 目标机无需安装任何东西，解开即可运行。
#
# 为何可行：唯一的运行时依赖 ws 是纯 JS（无 .node 原生产物），
# 因此可以在 macOS 上打包、在 Linux 上运行。
# 若将来引入了含原生扩展的依赖，必须改为在目标平台上执行 npm install。
#
# 用法：
#   bash scripts/build-portable.sh                     # 默认 linux-x64
#   TARGET=linux-arm64 bash scripts/build-portable.sh  # 指定平台
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

NODE_VER="${NODE_VER:-v22.20.0}"
TARGET="${TARGET:-linux-x64}"
APP_VER="$(node -p "require('./package.json').version")"

NAME="tank-arena-${APP_VER}-${TARGET}"
DIST="$ROOT/dist"
STAGE="$DIST/$NAME"
CACHE="$ROOT/.cache"

echo "──────────────────────────────────────────────"
echo "  构建离线便携包"
echo "  应用版本 : $APP_VER"
echo "  目标平台 : $TARGET"
echo "  Node     : $NODE_VER"
echo "──────────────────────────────────────────────"

# ---------- 1. 校验源码 ----------
echo "▸ 校验源码语法"
find server shared client -name "*.js" -print0 | xargs -0 -n1 node --check
echo "  ✓ 全部通过"

# ---------- 2. 准备 Node 运行时 ----------
mkdir -p "$CACHE"
TARBALL="$CACHE/node-${NODE_VER}-${TARGET}.tar.xz"
NODE_DIR_NAME="node-${NODE_VER}-${TARGET}"

# 校验缓存是否完整。
# ⚠️ 必须校验而非仅判断文件存在：下载被中断会留下一个残缺的 tar.xz，
#    后续解压时报的是 "Lzma library error" 这种与根因无关的错误，极难定位（实测踩过）。
if [[ -f "$TARBALL" ]] && ! xz -t "$TARBALL" 2>/dev/null; then
  echo "▸ 缓存文件不完整，删除后重新下载"
  rm -f "$TARBALL"
fi

if [[ ! -f "$TARBALL" ]]; then
  echo "▸ 下载 Node 运行时（缓存于 .cache/，仅首次需要联网）"
  curl -fL --retry 3 --progress-bar \
    -o "$TARBALL" \
    "https://nodejs.org/dist/${NODE_VER}/${NODE_DIR_NAME}.tar.xz"

  if ! xz -t "$TARBALL" 2>/dev/null; then
    echo "  ✗ 下载的文件不完整，请检查网络后重试" >&2
    rm -f "$TARBALL"
    exit 1
  fi
else
  echo "▸ 复用已缓存的 Node 运行时"
fi

# ---------- 3. 铺开产物目录 ----------
echo "▸ 组装产物"
rm -rf "$STAGE"
mkdir -p "$STAGE"

# 3.1 Node 运行时：只取 bin/node，丢掉 npm/文档/头文件。
#     完整包解开约 100MB，只留 node 可执行文件约 60MB。
#     目标机不需要 npm —— 依赖已随包提供。
mkdir -p "$STAGE/runtime/bin"
tar -xJf "$TARBALL" -C "$CACHE" "${NODE_DIR_NAME}/bin/node"
cp "$CACHE/${NODE_DIR_NAME}/bin/node" "$STAGE/runtime/bin/node"
chmod +x "$STAGE/runtime/bin/node"
rm -rf "$CACHE/${NODE_DIR_NAME}"

# 3.2 应用源码
cp -R server shared client "$STAGE/"
cp package.json "$STAGE/"
[[ -f README.md ]] && cp README.md "$STAGE/"

# 3.3 生产依赖
#     从本地 node_modules 直接拷贝而非 npm install ——
#     目标机可能完全离线，且 ws 是纯 JS 无需重新编译
mkdir -p "$STAGE/node_modules"
if [[ -d node_modules/ws ]]; then
  cp -R node_modules/ws "$STAGE/node_modules/"
else
  echo "  ✗ 未找到 node_modules/ws，请先在本机执行 npm install" >&2
  exit 1
fi

# 3.4 剔除无需随包分发的内容
find "$STAGE" -name "*.map" -delete 2>/dev/null || true
find "$STAGE" -name ".DS_Store" -delete 2>/dev/null || true

# ---------- 4. 生成运行脚本 ----------
echo "▸ 生成运行脚本"

cat > "$STAGE/start.sh" <<'LAUNCHER'
#!/usr/bin/env bash
#
# 启动坦克竞技场
#
# 所有配置均可用环境变量覆盖，例如：
#   PORT=9000 ./start.sh
#
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

export PORT="${PORT:-8080}"
# 0.0.0.0 才能被局域网其他设备访问；只想本机访问可设为 127.0.0.1
export HOST="${HOST:-0.0.0.0}"
export NODE_ENV="${NODE_ENV:-production}"
export LOG_LEVEL="${LOG_LEVEL:-info}"

NODE_BIN="./runtime/bin/node"
if [[ ! -x "$NODE_BIN" ]]; then
  echo "✗ 找不到内置 Node 运行时：$NODE_BIN" >&2
  exit 1
fi

# 端口占用会让服务启动失败但报错不直观，提前给出明确提示
if command -v ss >/dev/null 2>&1; then
  if ss -ltn 2>/dev/null | grep -q ":${PORT} "; then
    echo "✗ 端口 ${PORT} 已被占用。可换端口：PORT=9000 ./start.sh" >&2
    exit 1
  fi
fi

LOCAL_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '')"
echo "──────────────────────────────────────────────"
echo "  坦克竞技场启动中"
echo "  本机访问 : http://localhost:${PORT}"
[[ -n "$LOCAL_IP" ]] && echo "  局域网   : http://${LOCAL_IP}:${PORT}"
echo "  停止服务 : Ctrl+C"
echo "──────────────────────────────────────────────"

exec "$NODE_BIN" server/index.js
LAUNCHER

cat > "$STAGE/start-daemon.sh" <<'DAEMON'
#!/usr/bin/env bash
#
# 后台常驻启动。适合"关掉 SSH 后仍要继续跑"的场景。
# 日志写入 logs/server.log，PID 记录在 logs/server.pid。
#
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p logs
PIDFILE="logs/server.pid"

# 已在运行则拒绝重复启动，否则会出现两个进程抢同一端口
if [[ -f "$PIDFILE" ]] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "✗ 服务已在运行（PID $(cat "$PIDFILE")）。先执行 ./stop.sh" >&2
  exit 1
fi

nohup ./start.sh >> logs/server.log 2>&1 &
echo $! > "$PIDFILE"
sleep 1

if kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
  echo "✓ 已后台启动，PID $(cat "$PIDFILE")"
  echo "  查看日志：tail -f logs/server.log"
  echo "  停止服务：./stop.sh"
else
  echo "✗ 启动失败，请查看 logs/server.log" >&2
  rm -f "$PIDFILE"
  exit 1
fi
DAEMON

cat > "$STAGE/stop.sh" <<'STOPPER'
#!/usr/bin/env bash
#
# 停止后台服务。
# 先发 SIGTERM 让服务端走优雅退出（会广播"服务维护中"给在线玩家），
# 超时未退出才强杀。
#
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PIDFILE="logs/server.pid"
if [[ ! -f "$PIDFILE" ]]; then
  echo "服务未在运行（无 $PIDFILE）"
  exit 0
fi

PID="$(cat "$PIDFILE")"
if ! kill -0 "$PID" 2>/dev/null; then
  echo "进程 $PID 已不存在，清理 PID 文件"
  rm -f "$PIDFILE"
  exit 0
fi

echo "正在停止 PID $PID ..."
kill -TERM "$PID" 2>/dev/null || true

for _ in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "✓ 已停止"
    exit 0
  fi
  sleep 0.5
done

echo "优雅退出超时，强制结束"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PIDFILE"
echo "✓ 已强制停止"
STOPPER

cat > "$STAGE/health.sh" <<'HEALTH'
#!/usr/bin/env bash
# 健康检查：确认服务在跑，并显示房间数与在线人数
set -euo pipefail
PORT="${PORT:-8080}"
if command -v curl >/dev/null 2>&1; then
  curl -fsS "http://127.0.0.1:${PORT}/healthz" && echo
else
  # 目标机可能没有 curl，用内置 Node 兜底
  cd "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  ./runtime/bin/node -e "
    fetch('http://127.0.0.1:${PORT}/healthz')
      .then(r => r.text()).then(t => console.log(t))
      .catch(e => { console.error('✗ 服务未响应:', e.message); process.exit(1); });
  "
fi
HEALTH

chmod +x "$STAGE"/*.sh

# ---------- 5. 生成 systemd 单元（可选用） ----------
cat > "$STAGE/tank-arena.service.template" <<'UNIT'
# 开机自启配置（可选）
#
# 安装步骤：
#   1. 把 <安装路径> 替换为实际路径，<用户名> 替换为运行账号
#   2. sudo cp tank-arena.service /etc/systemd/system/
#   3. sudo systemctl daemon-reload
#   4. sudo systemctl enable --now tank-arena
#
# 查看状态：systemctl status tank-arena
# 查看日志：journalctl -u tank-arena -f

[Unit]
Description=AI Tank Arena
After=network.target

[Service]
Type=simple
User=<用户名>
WorkingDirectory=<安装路径>
ExecStart=<安装路径>/start.sh
Restart=always
RestartSec=3
Environment=PORT=8080
Environment=NODE_ENV=production
# 单副本硬约束：世界状态在进程内存中，
# 多实例会让玩家连到不同进程、各自维护一份状态
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

# ---------- 6. 生成部署说明 ----------
cat > "$STAGE/部署说明.txt" <<EOF
AI 坦克竞技场 —— 离线便携包
版本 ${APP_VER} · 目标平台 ${TARGET} · 内置 Node ${NODE_VER}

【无需安装任何东西】Node 运行时已内置于 runtime/ 目录。

────────────────────────────────
一、最快上手
────────────────────────────────
  tar -xzf ${NAME}.tar.gz
  cd ${NAME}
  ./start.sh

浏览器打开 http://<服务器IP>:8080

────────────────────────────────
二、后台常驻运行
────────────────────────────────
  ./start-daemon.sh      # 启动（关掉 SSH 也继续跑）
  ./health.sh            # 查看是否正常
  tail -f logs/server.log
  ./stop.sh              # 停止

────────────────────────────────
三、换端口
────────────────────────────────
  PORT=9000 ./start.sh

────────────────────────────────
四、开机自启（可选）
────────────────────────────────
  见 tank-arena.service.template 文件内的说明

────────────────────────────────
五、常见问题
────────────────────────────────
1) 别人访问不了，只有本机能开
   → 检查防火墙是否放行端口：
     sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload
     或 sudo ufw allow 8080/tcp

2) 提示端口被占用
   → 换端口：PORT=9000 ./start.sh
     或查占用：ss -ltnp | grep 8080

3) 提示 "cannot execute binary file"
   → 平台不匹配。本包为 ${TARGET}，
     请用 uname -m 确认目标机架构后重新构建

4) 玩家进不了同一房间
   → 双方必须访问同一个服务器地址（同一 IP 同一端口）

────────────────────────────────
六、注意
────────────────────────────────
· 只能起一个实例。世界状态保存在进程内存中，
  多实例会导致玩家连到不同进程、各自维护一份状态，
  双端结果将不一致。
· 至少 2 人才能开局，单房间最多 4 人。
EOF

# ---------- 7. 打包 ----------
echo "▸ 压缩"
cd "$DIST"
tar -czf "$NAME.tar.gz" "$NAME"
SIZE="$(du -h "$NAME.tar.gz" | cut -f1)"

# ---------- 8. 自检 ----------
echo "▸ 自检产物完整性"
MISSING=0
for f in start.sh stop.sh start-daemon.sh health.sh 部署说明.txt \
         runtime/bin/node server/index.js shared/constants.js \
         client/index.html node_modules/ws/package.json package.json; do
  if [[ ! -e "$NAME/$f" ]]; then
    echo "  ✗ 缺失 $f"
    MISSING=1
  fi
done
[[ $MISSING -eq 0 ]] && echo "  ✓ 关键文件齐全"

echo ""
echo "──────────────────────────────────────────────"
echo "  ✓ 构建完成"
echo ""
echo "  产物：dist/$NAME.tar.gz  ($SIZE)"
echo ""
echo "  拷到目标机后执行："
echo "    tar -xzf $NAME.tar.gz"
echo "    cd $NAME && ./start.sh"
echo "──────────────────────────────────────────────"

exit $MISSING
