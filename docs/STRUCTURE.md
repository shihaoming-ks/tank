# 坦克竞技场 —— 目录结构约定

> 本文件是**结构契约**。新增文件前先确认它属于哪一层，避免逻辑散落。

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
│   ├── index.js                #   进程入口：HTTP 静态托管 + WS 升级 + /healthz
│   ├── RoomManager.js          #   房间集合：创建/查找/销毁、玩家进出路由
│   ├── Room.js                 #   单房间：世界状态 + 30Hz tick + 广播
│   ├── physics.js              #   纯函数：移动、碰撞、子弹推进（可单测）
│   ├── map.js                  #   tilemap 生成
│   └── logger.js               #   结构化日志 { ts, evt, roomId, playerId }
│
├── shared/                     # 【双端共享】浏览器与 Node 同时 import 同一物理文件
│   ├── constants.js            #   全部可调参数的唯一来源
│   └── protocol.js             #   消息 type 常量 + payload 校验
│
├── client/                     # 【客户端】仅表现层，零判定逻辑
│   ├── index.html              #   大厅 + 战场 DOM
│   ├── main.js                 #   状态机 lobby → playing → over
│   ├── net.js                  #   WS 连接、重连提示、消息分发
│   ├── input.js                #   键盘 → intent（仅状态变化时发送）
│   ├── render.js               #   Canvas 绘制（当前为几何图形占位）
│   └── styles/
│       └── main.css
│
├── test/                       # 【测试】node:test 内置，零额外依赖
│   └── physics.test.js
│
├── assets/                     # 【素材】MVP 阶段为空，规范见 assets/README.md
│   └── sprites/
│
└── docs/
    ├── STRUCTURE.md            # 本文件
    └── prd/
        ├── 00-赛题原文.md
        ├── 01-PRD-主文档.md
        ├── 02-PRD-附录A-内部基建部署方案.md
        └── 03-PLAN-MVP.md
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

### 参数集中

所有可调数值（尺寸、速度、冷却、HP、时长、颜色）**必须**定义在 `shared/constants.js`。
`server/` 与 `client/` 一律 import，禁止出现魔法数字。

### 静态路由映射

`server/index.js` 对外暴露三条静态路由：

| URL 前缀 | 物理目录 |
|---|---|
| `/` | `client/`（`/` → `client/index.html`） |
| `/shared/` | `shared/` |
| `/assets/` | `assets/` |

因此客户端可直接 `import { TILE } from '/shared/constants.js'`。
