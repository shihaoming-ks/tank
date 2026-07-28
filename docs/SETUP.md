# 环境配置与运行手册

> 目标：任何人在**干净环境**下按本文档操作，都能一次性把项目跑起来。
> 若你发现某一步在你机器上失败，请把现象补充到 §6 常见问题。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| **Node.js** | ≥ 18（推荐 22） | 依赖内置 `node:test`、原生 `fetch`、ESM。仓库根 `.nvmrc` 已固定为 `22` |
| **npm** | ≥ 9 | 随 Node 安装 |
| **浏览器** | Chrome / Edge 最新版 | 需支持原生 ES Module 与 Canvas 2D |
| **操作系统** | macOS / Linux / Windows | 无平台相关代码 |

### 已验证环境

| 环境 | 版本 |
|---|---|
| macOS | 25.5.0 |
| Node.js | v22.23.1 |
| npm | 10.9.8 |

### 检查本机版本

```bash
node -v   # 需 >= v18
npm -v
```

若使用 `nvm`，在仓库根目录执行 `nvm use` 即可自动切到 `.nvmrc` 指定版本。

---

## 2. 安装依赖

```bash
npm install
```

### 内网 npm 源（快手内部环境必须）

```bash
npm install --registry https://npm.corp.kuaishou.com/
```

或一次性配置，后续无需重复指定：

```bash
npm config set registry https://npm.corp.kuaishou.com/
```

### 依赖清单

刻意保持极简 —— **只有一个运行时依赖**：

| 包 | 版本 | 用途 |
|---|---|---|
| `ws` | ^8.18.0 | WebSocket 服务端 |

无构建工具、无框架、无测试框架（用 Node 内置 `node:test`）。
因此 `node_modules` 体积极小，干净环境安装通常 < 1 秒。

---

## 3. 启动

```bash
npm run dev
```

启动成功会看到：

```
09:36:34.544 INFO  server_start {"port":8080,"host":"0.0.0.0","env":"development"}

  🎮 坦克竞技场已启动 →  http://localhost:8080
```

浏览器打开 **http://localhost:8080**

### 多人测试方式

服务端监听 `0.0.0.0`，因此有三种方式模拟多个玩家：

| 方式 | 操作 |
|---|---|
| 同机多窗口 | 再开一个**普通窗口**或**无痕窗口**访问同一地址 |
| 同机多浏览器 | Chrome + Safari 各开一个 |
| 局域网多设备 | 其他设备访问 `http://<本机内网IP>:8080` |

查看本机内网 IP：

```bash
# macOS
ipconfig getifaddr en0
# Linux
hostname -I
```

> 客户端身份完全由服务端分配，**不使用 localStorage 持久化**，
> 因此同一浏览器开多个标签页也不会串号。

### 停止服务

`Ctrl + C`。服务端会先向所有客户端广播"正在重启"提示再退出，
而不是让玩家看到连接莫名断开。

---

## 4. 命令一览

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动服务（开发模式，日志为彩色单行文本） |
| `npm start` | 启动服务（生产模式，日志为单行 JSON） |
| `npm test` | 运行单元测试（S2 阶段接入） |

### 开发 / 生产日志差异

```bash
# 开发模式：彩色文本，便于肉眼扫
npm run dev
# → 09:36:34.544 INFO  server_start {"port":8080,...}

# 生产模式：单行 JSON，便于日志平台按字段检索
NODE_ENV=production npm start
# → {"ts":"2026-07-28T09:36:34.544Z","level":"info","evt":"server_start","port":8080,...}
```

---

## 5. 环境变量

所有配置均有安全默认值，**不设置任何环境变量也能直接跑**。

需要覆盖时，复制模板：

```bash
cp .env.example .env
```

> ⚠️ `.env` 已被 `.gitignore` 忽略。**严禁将真实密钥提交到仓库。**

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址。改为 `127.0.0.1` 则仅本机可访问 |
| `NODE_ENV` | `development` | `development` \| `production`，影响日志格式 |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `ALLOWED_ORIGINS` | `*` | WS 来源白名单，逗号分隔。`*` 表示不校验 |

### 临时覆盖示例

```bash
# 换端口
PORT=9000 npm run dev

# 开启 debug 日志，排查消息收发
LOG_LEVEL=debug npm run dev

# 仅允许本机访问
HOST=127.0.0.1 npm run dev
```

### `ALLOWED_ORIGINS` 说明

本地开发默认 `*`（不校验 Origin）。
**S5 上线后应收敛为具体域名**，否则其他站点的页面可以盗连你的 WebSocket 服务：

```bash
ALLOWED_ORIGINS=https://tank-arena.example.corp.kuaishou.com npm start
```

### 游戏参数不在环境变量里

坦克速度、生命值、地图尺寸等**游戏性参数**统一定义在
`shared/constants.js`，因为它们必须被客户端和服务端**同时**读取。
调参改那一个文件即可，见 [STRUCTURE.md](./STRUCTURE.md)。

---

## 6. 常见问题

### 端口被占用

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:8080
```

查出占用进程并处理：

```bash
lsof -i :8080          # 查看占用者
kill -9 <PID>          # 或直接换端口
PORT=9000 npm run dev
```

### 浏览器提示 `Failed to load module script`

原因通常是**没有通过 `npm run dev` 访问**，而是直接双击 `client/index.html` 打开（`file://` 协议）。

原生 ES Module 与 `/shared/` 路径映射都依赖 HTTP 服务，
**必须**通过 `http://localhost:8080` 访问。

### 页面能打开但连接状态一直是"连接中…"

1. 确认终端里服务进程仍在运行（未被 Ctrl+C）
2. 打开 DevTools → Network → WS，查看握手响应码
   - `101 Switching Protocols` = 正常
   - `403` = Origin 被拒，检查 `ALLOWED_ORIGINS`
   - `404` = 路径错误，应为 `/ws`
3. 检查是否有代理软件劫持了 WebSocket

### 改了代码但刷新没生效

静态资源响应头已设 `Cache-Control: no-cache`，正常刷新即可。
若仍是旧版本，硬刷新：`Cmd/Ctrl + Shift + R`。

> 注意：**服务端代码改动需要重启进程**（`Ctrl+C` 后重新 `npm run dev`），
> 当前未接入热重载。

### 局域网其他设备打不开

1. 确认 `HOST` 是 `0.0.0.0`（默认值），而非 `127.0.0.1`
2. 检查本机防火墙是否放行 8080 端口
3. 确认两台设备在同一网段

---

## 7. 健康检查

```bash
curl localhost:8080/healthz
```

```json
{ "ok": true, "uptime": 12, "connections": 0, "rooms": 0, "players": 0 }
```

| 字段 | 含义 |
|---|---|
| `ok` | 服务存活 |
| `uptime` | 运行时长（秒） |
| `connections` | 当前 WebSocket 连接数 |
| `rooms` | 活跃房间数 |
| `players` | 在线玩家数 |

此接口在 S5 阶段作为容器云的**存活与就绪探针**，缺失会导致 Pod 反复重启。

---

## 8. 自检清单

新环境部署完成后，逐项确认：

```bash
# 1. 服务可启动
npm run dev

# 2. 健康检查可用
curl localhost:8080/healthz

# 3. 静态资源可访问
curl -o /dev/null -w "%{http_code}\n" localhost:8080/
curl -o /dev/null -w "%{http_code}\n" localhost:8080/shared/constants.js

# 4. 目录穿越已被拦截（应返回 404，不得泄漏文件内容）
curl --path-as-is "localhost:8080/shared/%2e%2e/.env.example"
```

浏览器端确认：

- [ ] 页面正常渲染，非白屏
- [ ] 连接状态显示「已连接」
- [ ] 共享参数显示「地图 960×640 · tick 30Hz」（证明 `shared/` 双端共享生效）
- [ ] 运行日志出现「收到 echo 回包」及往返耗时
- [ ] Console 无 error 级别日志
