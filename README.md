# AI 坦克竞技场（Tank Arena）

浏览器即可进入的在线多人坦克对战游戏。服务端维护唯一的权威世界状态；客户端只发送操作意图并渲染快照，因此生命、碰撞、道具、淘汰和胜负不会由某个浏览器自行判定。

## 当前实现（2026-07-29）

- 2–4 名玩家使用四位房间号创建或加入房间；房主开始对局。
- 30 Hz 服务端 tick、随机可连通地图、移动/射击、砖墙破坏、坦克相撞、倒计时、结算和再来一局。
- 道具、击杀升级、复活甲；新加入正在进行的对局者为观战者，结算页会标注“观战”。
- 简单自动重连：浏览器以 `localStorage` 中的 `resumeToken` 在 20 秒宽限期内取回原坦克；这不是完整的断线续玩系统。
- 四套可切换的界面与 Canvas 素材：`industrial`、`pixel`、`cartoon`、`neon`；包含坦克、地形、特效、血量格和主题化道具图标。
- Web Audio 程序化音效：命中按坦克/砖墙/钢墙/边界/撞击区分，且只播放自己相关或附近事件，避免多人战斗声音堆叠。

## 快速开始

要求：Node.js >= 18（仓库 `.nvmrc` 为 Node 22）。

```powershell
npm install
npm run dev
```

打开 <http://localhost:8080>。同机测试两个独立玩家时，请使用两个不同浏览器、不同浏览器配置文件，或普通窗口加无痕窗口；同一配置文件共享 `localStorage`，会恢复为同一身份。

若本机代理导致依赖安装失败，仅对当前 PowerShell 会话清空代理后再安装：

```powershell
$env:HTTP_PROXY=''
$env:HTTPS_PROXY=''
$env:http_proxy=''
$env:https_proxy=''
npm install
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` / `npm start` | 启动 HTTP + WebSocket 服务 |
| `npm test` | 运行 `node:test` 单元测试（当前 34 项） |
| `npm run smoke` | 对已启动服务执行房间、移动、砖墙与战斗冒烟测试 |
| `npm run smoke:all` | 脚本管理服务进程后执行完整冒烟流程 |
| `npm run build:portable` | 构建 Linux x64 离线便携包 |
| `npm run build:portable:centos7` | 构建 glibc 2.17 兼容便携包 |

服务端代码修改后需要重启；前端和主题素材修改后请刷新页面，资源疑似缓存时使用 `Ctrl+Shift+R`。

## 操作

| 按键 | 动作 |
|---|---|
| `WASD` 或方向键 | 移动/转向 |
| 空格 | 射击 |

## 规则摘要

- 初始 HP 为 5；子弹命中扣 1 HP，不能伤害发射者。
- 砖墙需 3 发子弹摧毁；钢墙和边界不可破坏。
- 坦克相撞时双方各受 1 点伤害，冷却 1.2 秒。
- 最后一名存活玩家获胜；3 分钟到时按 HP 判定，人数少于 2 时中止本局。
- 道具最多同时存在 2 个，20 秒刷新；砖墙被击破时有机会掉落。

## 文档

- [运行与排障](docs/02-SETUP.md)
- [目录与架构约定](docs/03-STRUCTURE.md)
- [离线便携部署](docs/04-DEPLOY.md)
- [阶段路线图](docs/05-PLAN.md)
- [开发进展与关键决策](docs/06-PROGRESS.md)
- [主题素材再生产提示词](docs/S3-THEME-ASSET-PROMPTS.md)
- [素材目录说明](assets/README.md)
- [赛题原文（保留档案）](docs/00-赛题原文.md)
