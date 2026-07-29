---
name: offline-portable-deploy
description: >
  将 Node.js 项目打包为无需预装运行时的离线便携包，使其可在
  无网络/无 npm 的物理机（Linux x64 / arm64 / CentOS 7）上
  一键启动。适用于比赛评审机、内网服务器或受限部署环境。
  覆盖：运行时下载与缓存验证、纯 JS 依赖检查、启动/停止/健康
  脚本生成、systemd 模板、glibc 兼容目标选择与目标机验证。
---

# 离线便携部署工坊

将 Node.js 项目打包为单个 `.tar.gz`，内含 Node 运行时与所有
依赖，解压即可在无网络环境运行。

---

## 适用场景

| 场景 | 典型描述 |
|------|---------|
| 比赛评审机 | 裁判机不保证安装 Node；需要一条命令跑起来 |
| 内网物理服务器 | 无外网访问，无法 `npm install` |
| CentOS 7 / RHEL 7 | glibc 2.17，官方 Node v18+ 无法运行 |
| 快速交付 | 对方不熟悉 Node 生态，只需解压 + `./start.sh` |

不适用于需要原生模块（`.node`）且目标架构与开发机不同的项目。

---

## 输入

| 字段 | 说明 | 示例 |
|------|------|------|
| `project_dir` | 项目根目录（含 `package.json`） | `/Users/me/tank` |
| `entry` | 服务器入口文件 | `server/index.js` |
| `port` | 监听端口 | `3000` |
| `target` | 目标平台（见下表） | `linux-x64-glibc-217` |
| `node_ver`（可选） | Node 版本，默认 `v22.20.0` | `v20.18.0` |
| `extra_dirs`（可选） | 额外需要打包的目录 | `shared/` |
| `health_path`（可选） | 健康检查 HTTP 路径，默认 `/healthz` | `/health` |

### 目标平台对照表

| 目标值 | CPU | 最低 glibc | 典型系统 | Node 来源 |
|--------|-----|-----------|---------|----------|
| `linux-x64` | x86_64 | 2.28 | Ubuntu 20+, Debian 11+ | nodejs.org |
| `linux-x64-glibc-217` | x86_64 | 2.17 | **CentOS 7**, RHEL 7 | unofficial-builds |
| `linux-arm64` | aarch64 | 2.28 | Raspberry Pi 4+, ARM 服务器 | nodejs.org |

**如何确认目标机 glibc 版本：**
```bash
# 在目标机执行
uname -m           # 确认 CPU 架构
ldd --version      # 第一行末尾即 glibc 版本
# glibc < 2.28 且 x86_64 → 选 linux-x64-glibc-217
```

---

## 输出

```
dist/<project>-<version>-<target>.tar.gz
│
├── runtime/bin/node        ← 独立 Node 二进制（无需系统 Node）
├── server/                 ← 服务端源码
├── client/                 ← 前端静态文件（如有）
├── shared/                 ← 共享模块（如有）
├── node_modules/           ← 生产依赖（仅纯 JS）
├── start.sh                ← 启动脚本（含运行时自检）
├── stop.sh                 ← 停止脚本
├── health.sh               ← 健康检查脚本
├── <project>.service       ← systemd 单元模板
└── DEPLOY.md               ← 部署手册
```

打包完成后脚本输出：
- 运行时 ABI 要求（`GLIBC_x.xx / GLIBCXX_x.x.xx`）
- 压缩包大小
- 本机验证结果（用本地 Node 运行 `/healthz`）

---

## 操作步骤

### 1. 检查依赖是否可跨平台

打包前确认 `node_modules` 不含原生模块：

```bash
find node_modules -name '*.node' | head -20
```

若存在 `.node` 文件，需在目标机重新编译，或改用纯 JS 替代。
常见可替换模块：`bcrypt → bcryptjs`、`sharp → jimp`。

### 2. 生成打包脚本

Agent 根据输入生成 `scripts/build-portable.sh`，核心逻辑：

```bash
#!/usr/bin/env bash
set -euo pipefail

NODE_VER="${NODE_VER:-v22.20.0}"
TARGET="${TARGET:-linux-x64}"
APP_NAME=$(node -p "require('./package.json').name")
APP_VER=$(node -p "require('./package.json').version")

# 1. 根据 TARGET 选择下载源
if [[ "$TARGET" == *glibc-217* ]]; then
  BASE_URL="https://unofficial-builds.nodejs.org/download/release"
else
  BASE_URL="https://nodejs.org/dist"
fi

# 2. 下载并验证 Node（缓存到 .cache/）
TARBALL=".cache/node-${NODE_VER}-${TARGET}.tar.xz"
if [[ -f "$TARBALL" ]] && ! xz -t "$TARBALL" 2>/dev/null; then
  echo "▸ 缓存不完整，重新下载"
  rm -f "$TARBALL"
fi
if [[ ! -f "$TARBALL" ]]; then
  mkdir -p .cache
  curl -fL "${BASE_URL}/${NODE_VER}/node-${NODE_VER}-${TARGET}.tar.xz" -o "$TARBALL"
  xz -t "$TARBALL" || { echo "下载不完整"; rm -f "$TARBALL"; exit 1; }
fi

# 3. 组装 staging 目录
STAGE=$(mktemp -d)
mkdir -p "${STAGE}/runtime/bin"
tar -xJf "$TARBALL" --strip-components=2 \
    "node-${NODE_VER}-${TARGET}/bin/node" -C "${STAGE}/runtime/bin"

# 复制源码与依赖
cp -r server client shared node_modules package.json "${STAGE}/" 2>/dev/null || true

# 4. 生成 start.sh（含运行时自检）
# 5. 生成 stop.sh / health.sh / systemd 模板 / DEPLOY.md

# 6. 打包
OUTFILE="dist/${APP_NAME}-${APP_VER}-${TARGET}.tar.gz"
mkdir -p dist
tar -czf "$OUTFILE" -C "$(dirname $STAGE)" "$(basename $STAGE)"
echo "✅ ${OUTFILE}"
```

### 3. 生成 start.sh（运行时自检优先）

`start.sh` 必须在打印任何"启动中"信息**之前**验证 Node 可执行：

```bash
#!/usr/bin/env bash
set -euo pipefail
NODE_BIN="$(dirname "$0")/runtime/bin/node"

# ── 运行时自检 ──────────────────────────────────────────
if ! NODE_CHECK="$("${NODE_BIN}" -v 2>&1)"; then
  echo "✗ 内置 Node 运行时无法执行" >&2
  if echo "$NODE_CHECK" | grep -q 'GLIBC\|GLIBCXX\|CXXABI'; then
    CUR="$(ldd --version 2>/dev/null | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo '未知')"
    echo "原因：glibc 版本过低（当前 ${CUR}）" >&2
    echo "解决：在开发机改用 glibc-217 目标重新打包" >&2
  elif echo "$NODE_CHECK" | grep -q 'Exec format error'; then
    echo "原因：CPU 架构不匹配（本机 $(uname -m)）" >&2
  fi
  exit 1
fi

echo "▸ 运行时 OK (${NODE_CHECK})"
exec "${NODE_BIN}" server/index.js
```

### 4. 添加 npm 快捷命令

在 `package.json` 的 `scripts` 中：

```json
{
  "build:portable": "bash scripts/build-portable.sh",
  "build:portable:centos7": "TARGET=linux-x64-glibc-217 bash scripts/build-portable.sh"
}
```

### 5. 在目标机部署

```bash
tar -xzf <package>.tar.gz
cd <package>/
./start.sh

# 验证
./health.sh
# 或
curl http://localhost:<port>/healthz
```

---

## 使用约束

1. **纯 JS 依赖**：`.node` 原生模块无法跨平台复制，必须在目标机编译或替换。
2. **单实例**：游戏状态存在进程内存，不支持多实例；`stop.sh` 停止前一个再启动。
3. **glibc 版本**：`linux-x64` 目标要求 glibc ≥ 2.28；CentOS 7（2.17）需用 `glibc-217` 目标。
4. **`.cache/` 不入库**：缓存的 Node 安装包约 29 MB，加入 `.gitignore`。
5. **本机验证局限**：macOS 开发机无法直接执行 Linux 二进制；用本地 Node 运行源码做功能验证代替。

---

## 验证方法

### 开发机验证（打包后立即可做）

```bash
# 用本地 Node 运行打包后的源码
cd dist/<extracted>/
node server/index.js &
curl http://localhost:<port>/healthz   # 应返回 {"ok":true,...}
kill %1
```

### 目标机验证清单

```bash
# 1. 架构与 glibc 检查（选包前做）
uname -m && ldd --version | head -1

# 2. 解压与启动
tar -xzf <package>.tar.gz && cd <package>/ && ./start.sh

# 3. 健康检查
./health.sh

# 4. 功能验证
# 用浏览器访问 http://<IP>:<PORT>，走一遍核心流程
```

### 预期结果

| 检查项 | 期望值 |
|--------|-------|
| `start.sh` 输出 | 包含 `运行时 OK (vXX.XX.X)` |
| `/healthz` 响应 | `{"ok":true}` 且 HTTP 200 |
| 功能测试 | 核心用户流程无报错 |
| 内存（可选） | `ps aux` 确认进程存活 |

---

## 使用示例

> 用户触发本 Skill 时，直接将以下提示词（按需修改括号内容）发送给 Agent。

### 示例一：普通 Linux 服务器（glibc ≥ 2.28）

> 请使用 offline-portable-deploy Skill，为当前项目生成一个离线便携部署包。
>
> - 项目根目录：当前工作目录
> - 服务器入口：`server/index.js`
> - 监听端口：`3000`
> - 目标平台：`linux-x64`（Ubuntu 20+ / Debian 11+）
> - Node 版本：`v22.20.0`
>
> 请生成 `scripts/build-portable.sh`，并在 `package.json` 中添加 `build:portable` 快捷命令。最后用本地 Node 做一次开发机验证，确认 `/healthz` 返回正常。

---

### 示例二：CentOS 7 / RHEL 7（glibc 2.17）

> 请使用 offline-portable-deploy Skill，为当前项目生成兼容 CentOS 7 的离线包。
>
> - 目标平台：`linux-x64-glibc-217`（评审机已确认 glibc 2.17，`ldd --version` 输出见附）
> - 服务器入口：`server/index.js`，端口：`3000`
> - 健康检查路径：`/healthz`
> - 需要同时在 `package.json` 添加 `build:portable:centos7` 快捷命令
>
> 打包完成后输出 ABI 要求（GLIBC_x.xx / GLIBCXX_x.x.xx），并给出目标机部署的完整命令序列。

---

### 示例三：带反向代理的 WebSocket 应用

> 请使用 offline-portable-deploy Skill，为当前 Node.js WebSocket 项目生成离线便携包，目标平台 `linux-x64`。
>
> 额外要求：
> - 服务同时处理 HTTP 静态资源和 WebSocket（路径 `/ws`）
> - 部署在 Nginx 反向代理后面，代理地址 `http://127.0.0.1:3000`
> - 请在 DEPLOY.md 中补充 Nginx 配置片段，要求透传 `Upgrade` 和 `Connection` 头
> - 健康检查路径：`/healthz`，由代理直接透传给内网端口

---

## 参考

- [Node.js unofficial-builds](https://unofficial-builds.nodejs.org/) — glibc-217 专版来源
- [Node.js 官方发行](https://nodejs.org/dist/) — linux-x64 / linux-arm64
- `xz -t <file>` — 验证 `.tar.xz` 完整性（避免断点下载导致解包失败）
- `strings <node_bin> | grep -oE 'GLIBC_[0-9.]+' | sort -uV | tail -1` — 读取二进制实际 ABI 要求
