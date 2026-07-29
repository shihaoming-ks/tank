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
| `npm run smoke` | 运行全部端到端冒烟测试（**需先启动服务**） |
| `npm run smoke:room` | 仅房间逻辑（39 项） |
| `npm run smoke:move` | 仅移动同步（37 项） |
| `npm run smoke:all` | 一键全量冒烟（自动管理服务端与地图模式，128 项） |
| `npm run dev:empty-map` | 以**空旷地图**启动（仅测试用，见下） |
| `npm run smoke:combat` | 仅战斗闭环（41 项） |

### 冒烟测试

用真实 WebSocket 客户端模拟多名玩家，自动验证端到端行为（共 117 项断言）：

```bash
# 终端 1：启动服务
npm run dev

# 终端 2：跑冒烟
npm run smoke
```

| 脚本 | 覆盖范围 |
|---|---|
| `smoke:room` | 创建/加入房间、颜色与槽位分配、权限校验、无效输入、容量上限、主动离开、断线移除、房主移交、开局条件、房间回收 |
| `smoke:move` | 地图下发与双端一致、出生点合法性、移动生效、**双端坐标一致**、停止指令、炮管朝向、边界与墙体阻挡、非法输入、坦克互相阻挡、广播频率与帧号递增 |
| `smoke:combat` | 射击与冷却、命中扣血、淘汰、**双端胜负与计分板完全一致**、不自伤、无敌保护、对手退出/掉线判胜、结束后行为、再来一局 |

> 与 `npm test` 的区别：`smoke` 测的是**端到端行为**，需真实服务进程；
> `test` 测的是**纯函数逻辑**，无需启动服务。

### 验证时限结束（可选）

默认对局时限 3 分钟，完整等待不现实。临时改短即可快速验证：

```bash
# 把 shared/constants.js 的 MATCH_DURATION_MS 改为 3_000，重启服务后跑一局
# 验证完毕记得改回 180_000
```

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
调参改那一个文件即可，见 [STRUCTURE.md](./03-STRUCTURE.md)。

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

### 战场画面空白（Canvas 不渲染）

若 HUD（房间号、血量、倒计时）正常但画布全白/全透明，
且 Console **无任何报错**，典型原因是 `requestAnimationFrame` 未被触发。

常见于：无头浏览器、自动化测试容器、长时间处于后台的标签页。

诊断方法（在 Console 执行）：

```javascript
let n = 0;
const t0 = performance.now();
(function tick() {
  n++;
  if (performance.now() - t0 < 600) requestAnimationFrame(tick);
  else console.log('rAF 触发次数:', n, '页面可见:', document.visibilityState);
})();
```

正常环境应输出 30~40 次；若为 **0**，则确认为 rAF 节流。

> 代码已内置保底：除 rAF 外，**每帧快照到达时也会主动绘制一次**（服务端 30Hz）。
> 因此即使 rAF 完全失效，游戏仍可正常渲染。

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
- [ ] 顶部连接状态显示「已连接」
- [ ] 空昵称点「创建房间」有错误提示
- [ ] 创建房间后显示 4 位房间号，自身条目带「房主」「你」标签
- [ ] 另开一个窗口输入同房间号，双端均看到 2 名玩家
- [ ] 房主点「开始对战」后双端均切入战场
- [ ] 战场可见：网格地面、灰色墙体、彩色坦克、昵称标签
- [ ] 自己的坦克带白色描边环
- [ ] HUD 显示房间号、各玩家血量、递减的倒计时
- [ ] WASD / 方向键可移动，另一端同步看到
- [ ] 撞墙与越界被正确阻挡
- [ ] 空格可射击，子弹可见且双端同步
- [ ] 命中时目标闪白，战报出现「XXX 击中了 XXX（剩余 N 血）」
- [ ] 血量归零后有爆炸特效，战报出现「XXX 淘汰了 XXX」
- [ ] 结算面板弹出，双端显示**相同**的胜负与计分板
- [ ] 战报区域记录进入/退出房间、对局开始等事件
- [ ] 对手退出后，剩下的玩家立即看到胜利提示
- [ ] 房主可点「再来一局」开新对局，血量与位置重置
- [ ] 关闭其中一个窗口，另一端 3s 内感知列表变为 1 人
- [ ] Console 无 error 级别日志

## 地图与测试模式

地图**每局随机生成**，图块分三类，便于后续替换美术素材：

| 类型 | 值 | 位置 | 当前占位视觉 |
|---|---|---|---|
| `EMPTY` | 0 | — | 深色地面 |
| `BORDER` | 1 | 仅外围一圈 | 灰绿、双层描边 |
| `BRICK` | 2 | 内部障碍 | 褐色砌缝，**可被 3 发子弹击破** |
| `STEEL` | 3 | 内部障碍 | 蓝灰、四角铆钉 |

生成受三条硬约束保护（见 `server/map.js`）：

1. **比例固定** —— 内部障碍占比 `MAP_FILL_RATIO = 0.08`，实测均值 8.3%、波动 1.2%；
   其中钢块占 `MAP_STEEL_RATIO = 0.45`（图块类型逐格决定，否则 2×2 整块同类会让方差极大）
2. **出生点安全区** —— 半径 2 格内不放障碍，不会开局被围死
3. **连通性校验** —— 生成后 BFS 验证四个出生点互通，不连通则重试；30 次失败退化为空旷图

替换美术素材时只需改 `client/render.js` 的 `TILE_STYLE` 表与 `drawTile()`，
不触碰服务端与协议。

### 空旷地图模式（仅测试用）

```bash
npm run dev:empty-map      # 等价于 TANK_EMPTY_MAP=1 node server/index.js
```

`scripts/smoke-combat.js` **必须**在此模式下运行。

> 为何需要：战斗冒烟要验证的是「射击 → 命中 → 淘汰 → 结算」链路，
> 随机掩体会让测试脚本必须实现 AI 寻路才能打中对手 —— 那考察的是脚本寻路
> 能力而非被测目标。曾尝试贪心移动与 BFS 寻路，均因坦克在格子边缘抖动而
> 超时（实测 20s 仅推进 670px）。
> 地图随机性本身由 `test/map.test.js` 以 50 个种子独立覆盖，不会漏测。

`npm run smoke:all` 会自动为各组测试切换模式，无需手动干预。
