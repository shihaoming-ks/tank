# 坦克竞技场 —— 目录结构约定

> 本文件是**结构契约**。新增文件前先确认它属于哪一层，避免逻辑散落。
> 标记 `[S1.x]` / `[S2]` 的文件为**计划中**，尚未创建。

## 全景

```
tank/
├── package.json                # type:module，唯一依赖 ws
├── .env.example                # 环境变量模板（真实 .env 不入库）
├── .gitignore
├── .editorconfig
├── .nvmrc                      # Node 22
├── README.md                   # 启动/测试/操作说明
│
├── server/                     # 【服务端】权威状态，Node 独占
│   ├── index.js                #   进程入口：HTTP + WS 升级 + /healthz + 优雅退出
│   ├── config.js               #   环境变量读取，带安全默认值
│   ├── logger.js               #   结构化日志 { ts, level, evt, roomId, playerId }
│   ├── static.js               #   静态文件服务（含目录穿越防护）
│   ├── RoomManager.js          #   房间集合、连接绑定、上行消息路由与校验
│   ├── Room.js                 #   单房间：玩家进出、房主移交、广播；[S1.3] 加 tick
│   ├── map.js                  #   tilemap 生成、出生点、地图自检
│   └── physics.js              #   纯函数：移动、碰撞、子弹推进（可单测）
│
├── shared/                     # 【双端共享】浏览器与 Node 同时 import 同一物理文件
│   ├── constants.js            #   全部可调参数的唯一来源
│   └── protocol.js             #   消息 type 常量 + 编解码 + 校验
│
├── client/                     # 【客户端】仅表现层，零判定逻辑
│   ├── index.html              #   三视图骨架：lobby / room / game + 断连遮罩
│   ├── main.js                 #   视图状态机，阶段切换完全由服务端驱动
│   ├── net.js                  #   WS 连接、地址自适应、消息分发
│   ├── input.js                #   键盘 → intent（仅状态变化时发送）
│   ├── render.js               #   Canvas 绘制 + 命中/爆炸特效（几何图形占位）
│   ├── feed.js                 #   战报：将 event 翻译为可读文字
│   └── styles/
│       └── main.css
│
├── test/                       # 【测试】node:test 内置，零额外依赖
│   └── physics.test.js         #   [S2] 纯函数单测，无需启动服务
│
├── scripts/                    # 【工具】开发与验证脛本
│   ├── smoke-room.js           #   房间逻辑端到端冒烟
│   ├── smoke-move.js           #   移动同步端到端冒烟
│   └── smoke-combat.js         #   战斗闭环端到端冒烟
│
├── assets/                     # 【素材】S1~S2 为空，规范见 assets/README.md
│   └── sprites/
│
└── docs/
    ├── STRUCTURE.md            # 本文件：目录与分层契约
    ├── SETUP.md                # 环境配置与运行手册
    └── prd/
        ├── 00-赛题原文.md
        ├── 01-PRD-主文档.md
        ├── 02-PRD-附录A-内部基建部署方案.md
        └── 03-PLAN.md          # S1~S6 实施路线图
```

## 分层规则（不可违反）

### 依赖方向

```
server/  ──import──>  shared/  <──import──  client/
```

- `shared/` **不得** import `server/` 或 `client/` 的任何文件
- `server/` 与 `client/` **不得**互相 import
- 违反此规则会破坏"浏览器与 Node 共用同一份 shared"的前提

### 职责红线

| 目录 | 允许 | 禁止 |
|---|---|---|
| `server/` | 判定胜负、扣血、碰撞裁决、维护世界状态 | 操作 DOM、依赖浏览器 API |
| `client/` | 采集输入、绘制快照、播放特效 | **任何游戏规则判定**（扣血/胜负/碰撞） |
| `shared/` | 常量、消息类型、纯校验函数 | 有状态逻辑、I/O、副作用 |

> `client/` 零判定是"双端结果一致"的唯一保障。任何在客户端计算 HP 或胜负的代码都视为架构违规。

### 下行消息职责划分

三类下行消息职责不得重叠：

| 消息 | 语义 | 频率 | 丢失影响 |
|---|---|---|---|
| `room` | 房间元信息（玩家列表、阶段、房主） | 变更时 | 需重发 |
| `snapshot` | 幂等世界状态（坐标、血量） | 30Hz | 无害，下帧即恢复 |
| `event` | 一次性瞬时信号（命中/击杀/进出房） | 事件驱动 | 仅影响特效与战报 |

> 为何不把命中信息放进快照：快照是幂等状态，而命中是瞬时事件。
> 混在一起会导致要么特效重复播放，要么丢帧时永久丢失。

### 胜负判定唯一来源

`over` 消息是所有客户端胜负显示的**唯一来源**，由 `Room.checkEnd()` 在服务端判定一次。
客户端不得自行推断“只剩我一人所以我赢了”。

### 参数集中

所有可调数值（尺寸、速度、冷却、HP、时长、颜色）**必须**定义在 `shared/constants.js`。
`server/` 与 `client/` 一律 import，禁止出现魔法数字。

### CSS 约束

`[hidden] { display: none !important; }` 是**必需的全局规则**。
组件自身的 `display: grid/flex` 优先级高于 `[hidden]` 属性的默认样式，
若不加此规则，隐藏的遮罩层仍会以 `z-index` 拦截全部鼠标点击。

> 此问题已在 S1.2 阶段实际触发过：断连遮罩虽带 `hidden` 但因 `display:grid` 仍生效，
> 导致大厅所有按钮不可点击。

### 渲染驱动约束

画面绘制必须**双驱动**，不得只依赖 `requestAnimationFrame`：

| 驱动源 | 作用 |
|---|---|
| `requestAnimationFrame` | 跟随屏幕刷新率，保障时间驱动动画（如无敌闪烁）平滑 |
| 快照到达 | 服务端 30Hz 保底，即使 rAF 失效仍有画面 |

> 原因：无头浏览器、自动化测试容器、后台标签页中 rAF 可被节流至**完全不触发**，
> 且不报任何错误 —— 这类“静默白屏”极难定位。S1.3 阶段已实际触发过。

### 静态路由映射

`server/index.js` 对外暴露三条静态路由（挂载顺序即匹配顺序，`/` 为兜底）：

| URL 前缀 | 物理目录 |
|---|---|
| `/shared/` | `shared/` |
| `/assets/` | `assets/` |
| `/` | `client/`（`/` → `client/index.html`） |

因此客户端可直接 `import { TILE } from '/shared/constants.js'`。

> `static.js` 内置目录穿越防护：`normalize` 后路径必须仍在挂载目录内，
> 否则 `/shared/%2e%2e/.env` 之类的请求可读到仓库外任意文件。
