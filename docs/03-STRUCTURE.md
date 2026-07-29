# 目录结构与架构约定

## 当前目录

```text
tank/
├─ server/                 # Node 权威服务端
│  ├─ index.js             # HTTP、WS、健康检查、静态挂载、优雅退出
│  ├─ RoomManager.js       # 连接、房间与协议路由
│  ├─ Room.js              # tick、战斗、道具、观战、重连与结算
│  ├─ map.js / physics.js  # 地图生成与纯物理逻辑
│  └─ config.js logger.js static.js
├─ shared/                 # Node 和浏览器共同 import 的常量与协议
├─ client/                 # 原生 ESM + Canvas 客户端
│  ├─ main.js              # 视图状态、主题、恢复身份、UI 事件
│  ├─ net.js input.js      # WS 与输入意图
│  ├─ render.js            # 快照渲染、主题 PNG 预加载与 Canvas 回退
│  ├─ audio.js             # 程序化 Web Audio 与事件筛选
│  ├─ feed.js index.html styles/main.css
├─ assets/                 # 四套主题的实际运行时素材
│  ├─ industrial/ pixel/ cartoon/ neon/
│  └─ README.md
├─ test/                   # node:test：地图、物理、房间管理
├─ scripts/                # 冒烟和离线便携包脚本
├─ skills/                 # 项目沉淀的可复用 Skill
└─ docs/
```

## 分层红线

```text
server/  ──import──> shared/ <──import── client/
```

- `shared/` 不得依赖浏览器或 Node API。
- `server/` 不得操作 DOM；`client/` 不得判定 HP、命中、淘汰或胜负。
- 可调游戏参数集中在 `shared/constants.js`，协议集中在 `shared/protocol.js`。
- 世界状态保存在单一 Node 进程内；不能把多个无状态实例放到负载均衡后直接运行。

## 服务端状态与消息

服务端以 30 Hz 推进 `Room`。客户端上行只表达 `input`、`fire`、创建/加入/离开、开始和恢复身份等意图；服务端校验后广播：

| 下行消息 | 作用 |
|---|---|
| `room` | 房间成员、房主、阶段与观战身份等元信息 |
| `snapshot` | 地图、坦克、子弹、道具等可重复覆盖的世界快照 |
| `event` | 命中、击杀、道具、升级、离开等一次性表现/战报事件 |
| `over` | 服务端唯一的结算来源 |

`event` 中的战斗事件带有 `actorId`、目标/坐标，以及 `surface`（`tank`、`brick`、`steel`、`border`、`ram`）。客户端音效只优先播放自身相关或 192px 范围内的事件，并按材质选择音色与限频。

## 客户端主题与资源约定

- 根元素主题值为 `industrial`、`pixel`、`cartoon`、`neon`，选择保存在 `localStorage` 的 `tank:theme`。
- `render.js` 预加载 `/assets/<theme>/` 内的坦克、子弹、四种地形、五张特效表、两种血量格与五种道具图标。
- PNG 缺失或加载失败不应阻塞游戏：渲染器保留 Canvas 几何回退，道具回退为 Emoji。
- 主题不仅换色：CSS 同时定义字体、轮廓、面板、输入、HUD、战报和动效的不同语言；新增主题需补齐可读性与键盘提示对比度。

## 身份、观战与恢复边界

浏览器保存昵称、主题和 `resumeToken`。`resumeToken` 只用于在断线后 20 秒内恢复同一个服务端玩家；它不是账号系统，也不提供跨设备或跨房间的持久会话。进行中的房间接收新连接时会分配观战者，不占活跃玩家槽位。

## 静态路径

| URL 前缀 | 目录 |
|---|---|
| `/` | `client/` |
| `/shared/` | `shared/` |
| `/assets/` | `assets/` |

静态服务包含目录穿越防护。新增运行时资源必须放在对应挂载目录内，并用浏览器实际 URL 验证。
