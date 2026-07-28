# MVP 实施计划：本地可运行的最小多人坦克对战

> 范围：**仅代码**。忽略 Skill 沉淀、忽略 AIGC 美术（用色块/几何图形占位）、忽略容器云/Access Proxy/MySQL 部署。
> 目标：`npm install && npm run dev` → 开两个浏览器窗口 → 同房间打完一局，双端结果一致。

---

## 1. 核心设计决策（先定，避免返工）

这几条决定了后面所有代码，逐条说明为什么这样选。

### 决策 1：零构建工具链（不用 Vite / React / TS 编译）

| 方案 | 取舍 |
|---|---|
| ❌ Vite + React + TS | 需要配 build、dev proxy、双进程，MVP 阶段纯负担 |
| ✅ 原生 ESM + Canvas，Node 直接托管静态文件 | 单进程、单命令、零构建、同源无 CORS |

**同源是关键收益**：Node 同时托管静态页和 WebSocket，前端连 `ws://localhost:8080/ws` 与页面同源，彻底绕开跨域、混合内容、代理配置三类问题。附录 A 里那些 `wss://` 风险在本地阶段完全不存在。

### 决策 2：`shared/` 目录被浏览器和 Node **同时 import**

```
server/  --import-->  shared/constants.js  <--import--  client/
                      shared/protocol.js
```

全项目 `"type": "module"`，Node 用 ESM import；浏览器通过 `/shared/*.js` 静态路由 import **同一个物理文件**。

这样协议常量和消息类型天然只有一份，不存在双端漂移 —— 直接满足主 PRD 的 F-5.5「关键参数不散落」。

### 决策 3：地图用网格（tilemap），不用任意矩形

障碍物是 `30×20` 的 `0/1` 二维数组，每格 32px。
碰撞检测退化成"算出实体覆盖哪几个格子，查数组" —— O(4) 而非 O(n)，代码量减少一大半，且不会有浮点缝隙穿墙的经典 bug。

### 决策 4：tick 与广播同频 30Hz

主 PRD 写的是 tick 30 / 广播 20。MVP 阶段**统一成 30Hz 广播**：4 名玩家 × 30Hz × 约 300B ≈ 36KB/s，本地毫无压力。少一套节流逻辑 = 少一处 bug。

代价是客户端不做插值也能看着流畅（33ms 一帧），所以 **MVP 阶段不实现插值**，直接按快照绘制。

### 决策 5：客户端绝对不做任何判定

客户端只做两件事：**采集按键 → 发意图**、**收快照 → 画图**。

不预测、不本地扣血、不本地判胜负。这是"双端一致"这个门槛项唯一稳妥的实现路径，也是 MVP 阶段最省事的做法。

---

## 2. 目录结构

```
tank/
├── package.json              # type:module, 单依赖 ws, scripts.dev
├── server/
│   ├── index.js              # HTTP 静态托管 + WS 升级 + /healthz
│   ├── RoomManager.js        # 房间增删查、玩家进出
│   ├── Room.js               # 单房间：世界状态 + 30Hz tick + 广播
│   ├── physics.js            # 移动/碰撞/子弹推进（纯函数，可单测）
│   └── map.js                # 生成固定 tilemap
├── shared/
│   ├── constants.js          # 所有可调参数（唯一来源）
│   └── protocol.js           # 消息 type 常量 + 校验
├── client/
│   ├── index.html            # 大厅 + 战场 DOM
│   ├── main.js               # 状态机：lobby → playing → over
│   ├── net.js               # WS 连接、重连提示、消息分发
│   ├── input.js              # 键盘 → intent（带去重）
│   ├── render.js             # Canvas 绘制（色块占位）
│   └── style.css
├── test/
│   └── physics.test.js       # node:test，无需额外依赖
└── README.md
```

---

## 3. 关键参数（`shared/constants.js`）

```javascript
export const TILE = 32;
export const COLS = 30, ROWS = 20;          // 960 × 640
export const TICK_HZ = 30;
export const TANK_SIZE = 24;
export const TANK_SPEED = 120;              // px/s
export const BULLET_SIZE = 6;
export const BULLET_SPEED = 360;            // px/s
export const FIRE_COOLDOWN_MS = 300;
export const MAX_HP = 3;
export const RESPAWN_INVULN_MS = 2000;
export const MATCH_DURATION_MS = 180_000;
export const ROOM_MIN = 2, ROOM_MAX = 4;
export const HEARTBEAT_MS = 25_000;
export const DISCONNECT_TIMEOUT_MS = 3_000;
export const COLORS = ['#e94f37', '#3f88c5', '#44bba4', '#f6ae2d'];
```

---

## 4. 消息协议（`shared/protocol.js`）

### 上行 C→S

| type | payload | 备注 |
|---|---|---|
| `join` | `{ roomId?, nickname }` | 无 roomId 则创建 |
| `leave` | `{}` | |
| `start` | `{}` | 仅房主有效 |
| `input` | `{ dir }` | `'up'\|'down'\|'left'\|'right'\|null`；**仅在变化时发**，不是每帧发 |
| `fire` | `{}` | 服务端按冷却裁决 |

### 下行 S→C

| type | payload | 备注 |
|---|---|---|
| `joined` | `{ selfId, roomId, isHost }` | 首次确认身份 |
| `room` | `{ roomId, phase, players[], hostId }` | 房间/大厅变更时发 |
| `snapshot` | `{ t, tanks[], bullets[], timeLeft }` | 30Hz；**首帧附带 `map`** |
| `event` | `{ kind, ...}` | `hit\|kill\|respawn`，纯表现用 |
| `over` | `{ winnerId, reason, scores[] }` | 唯一权威结算 |
| `error` | `{ code, message }` | |

> `map` 只在玩家的第一帧下发（约 600B），后续快照不重复带 —— 这是唯一一处刻意做的优化，因为每帧带 map 会让流量翻 10 倍。

---

## 5. 服务端权威循环（核心逻辑）

```
每 33ms（Room.tick）:
  1. 按 player.moveDir 尝试移动坦克
       → 检查地图边界
       → 检查 tilemap 障碍
       → 检查与其他坦克 AABB 重叠
       → 任一失败则不移动（不做滑动修正，MVP 够用）
  2. 推进所有子弹
       → 出界 / 撞墙 → 销毁
       → 命中非发射者且非无敌坦克 → HP-1，销毁子弹，推 hit 事件
  3. HP 归零 → 推 kill 事件，标记 dead
  4. 检查结束条件
       → 存活 ≤1 → last_survivor
       → 时间到 → timeout（比 HP，相同则平局）
       → 人数 <2 → aborted
  5. 广播 snapshot（+ 累积的 event）
```

**结束判定只在服务端发生一次**，`over` 消息是所有客户端胜负显示的唯一来源。

---

## 6. 分阶段实施（每阶段都可独立验证）

严格遵守"先纵向打通，再横向加功能"。每个阶段结束都必须能在浏览器里看到东西。

### Phase 0 — 脚手架（约 15 min）
- `package.json`（`type: module`，依赖只有 `ws`）
- `server/index.js`：HTTP 托管 `client/` 与 `shared/`，`/healthz`，WS echo
- `client/index.html` + 一个能连上 WS 并打印回包的 `net.js`

**验证**：`npm run dev` → 打开 `localhost:8080` → Console 看到 echo 回包。

> 这一步就是附录 A 里那条"第一小时的通路验证"，本地版。

### Phase 1 — 房间与玩家（约 40 min）
- `RoomManager` / `Room` 骨架，房间号 4 位数字
- `join` / `leave` / 断线移除 / 房间空则销毁 / 满员拒绝
- 大厅 UI：昵称输入、创建、加入、玩家列表、开始按钮（房主可见）

**验证**：两窗口进同一房间，互相看到玩家列表；关一个窗口，另一个 3s 内列表更新。

### Phase 2 — 移动同步（约 50 min）★ 最关键
- `map.js` 固定地图
- `physics.js` 移动 + 边界 + 障碍碰撞
- 30Hz tick + snapshot 广播
- `input.js` 按键变化时发 intent
- `render.js` 画 tilemap（灰块）+ 坦克（彩色方块 + 朝向短线）

**验证**：两窗口同房间，A 移动 B 立刻看到；撞墙停住；不能越界。

> **此阶段完成即 MVP 的技术风险归零**，后面全是填充。

### Phase 3 — 战斗闭环（约 50 min）
- `fire` + 冷却；子弹推进、撞墙销毁
- 子弹×坦克命中判定、HP-1、不自伤
- HP=0 淘汰、复活 + 2s 无敌
- 结束判定三条规则 + `over` 广播
- HUD：自身 HP、玩家列表 HP、剩余时间、房间号
- 结算面板：胜者 + 再来一局

**验证**：A 打死 B，双端同时显示相同 HP 变化与相同胜负结果。

### Phase 4 — 反馈与鲁棒性（约 30 min）
- 命中：受击坦克闪白 3 帧
- 爆炸：淘汰点扩散圆环（纯 Canvas 绘制，零素材）
- 异常处理（挑 2 类，对应主 PRD F-7）：
  - 空昵称 / 非法房间号 / 满员 → `error` + UI 提示
  - WS 断开 → 全屏"连接已断开，请刷新"遮罩
  - 未知消息类型 → 服务端 catch + 结构化日志，不崩进程
- 服务端日志：`{ ts, evt, roomId, playerId }`

**验证**：输入空昵称被拦；kill server 进程，客户端出现断开提示。

### Phase 5 — 测试与文档（约 20 min）
- `test/physics.test.js`（`node:test` 内置，零依赖）
  - 撞墙不位移
  - 子弹不伤发射者
  - 无敌期不扣血
  - 存活 1 人时判定结束
- `README.md`：一条启动命令 + 一条测试命令 + 操作说明 + 参数表

**验证**：`npm test` 全绿。

---

## 7. `package.json` 契约

```json
{
  "type": "module",
  "scripts": {
    "dev": "node server/index.js",
    "start": "node server/index.js",
    "test": "node --test test/"
  },
  "dependencies": { "ws": "^8.18.0" }
}
```

对应主 PRD F-5.3 / F-5.4：**一条启动命令 `npm run dev`，一条测试命令 `npm test`**。

---

## 8. 美术占位约定（Phase 4 后可无痛替换）

| 元素 | MVP 画法 | 后续替换点 |
|---|---|---|
| 地面 | `#1a1a1f` 纯色填充 | `render.js` 单函数 |
| 障碍 | `#4a4a55` 方块 + 描边 | 同上 |
| 坦克 | 玩家色 24×24 圆角方块 + 炮管短线 | 同上 |
| 自己 | 额外白色描边环 | 同上 |
| 子弹 | 4px 白色圆点 | 同上 |
| 命中 | 坦克闪白 3 帧 | 同上 |
| 爆炸 | 扩散圆环 + 透明度衰减 | 同上 |

所有绘制集中在 `render.js`，且**只读 snapshot**。后续接入 AIGC 贴图时，只需把 `ctx.fillRect` 换成 `ctx.drawImage`，不触碰任何逻辑代码。

---

## 9. 明确不做（MVP 阶段）

| 项 | 原因 |
|---|---|
| 客户端预测 / 插值 | 30Hz 已足够流畅，且预测会引入"客户端自行判定"的一致性风险 |
| 断线续玩 | 题目明确非目标 |
| Vite / React / TS | 零构建更快更稳 |
| AIGC 素材 | 本轮明确忽略 |
| 容器云 / Proxy / MySQL | 本轮明确忽略，附录 A 已备方案 |
| 音效、多地图、道具 | 闭环优先 |

---

## 10. 风险与对策

| 风险 | 对策 |
|---|---|
| 坦克 24px 卡在 32px 网格通道 | 地图设计保证通道 ≥2 格宽；碰撞失败时不做滑动修正，直接停 |
| 高频 `input` 消息刷爆 | 客户端仅在按键状态**变化**时发送，非每帧发 |
| `setInterval` 漂移累积 | tick 内用真实 `dt`（`performance.now()` 差值）积分，不假设固定 33ms |
| 两窗口共享 localStorage 串号 | 玩家身份完全由服务端分配的 `selfId` 决定，客户端不持久化任何身份 |

---

## 11. 验收清单（本轮）

- [ ] 干净目录 `npm install && npm run dev` 一次成功
- [ ] 两个浏览器窗口进入同一房间号
- [ ] 双端看到彼此移动、射击
- [ ] 命中扣血，双端 HP 数值一致
- [ ] 一方淘汰，双端显示**相同**胜负结果
- [ ] 撞墙、越界被正确阻止
- [ ] 关闭一个窗口，另一端 3s 内感知
- [ ] 空昵称/非法房间号有明确提示
- [ ] `npm test` 全绿
- [ ] README 可让他人从零复现
