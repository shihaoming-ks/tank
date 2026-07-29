# 环境配置与运行手册

## 1. 要求

| 项目 | 要求 |
|---|---|
| Node.js | >= 18；推荐按 `.nvmrc` 使用 Node 22 |
| npm | 随 Node 安装即可 |
| 浏览器 | 当前 Chrome 或 Edge，需支持 Canvas 2D、ESM、WebSocket 和 Web Audio |

```powershell
node -v
npm -v
```

## 2. 安装与启动

```powershell
npm install
npm run dev
```

访问 <http://localhost:8080>。默认服务同时提供页面、`/ws` WebSocket、`/healthz` 健康检查，以及 `/assets/`、`/shared/` 静态路径。

如环境变量中的代理阻断安装，只对当前终端取消代理；项目不要求使用任何公司 npm 源：

```powershell
$env:HTTP_PROXY=''; $env:HTTPS_PROXY=''
$env:http_proxy=''; $env:https_proxy=''
npm install
```

## 3. 两人本机联调

使用不同浏览器、不同 Profile，或普通窗口和无痕窗口进入相同四位房间号。

不要用同一浏览器配置文件的两个普通标签页模拟两个独立玩家：昵称、主题和 `resumeToken` 存在 `localStorage` 中，第二个标签页会尝试恢复同一个玩家身份。若只想旁观，则可直接在进行中的房间加入，服务端会创建观战席。

局域网设备可访问 `http://<本机 IP>:8080`；确保防火墙放行 TCP 8080。

## 4. 测试

```powershell
# 单元测试，无需先启动服务
npm test

# 冒烟测试：先在另一终端运行 npm run dev
npm run smoke

# 由脚本自行管理服务进程的完整冒烟流程
npm run smoke:all
```

`npm test` 当前覆盖地图、物理和房间管理，共 34 项。冒烟脚本覆盖真实 WebSocket 下的建房/入房、移动、砖墙和战斗路径。

## 5. 环境变量

| 变量 | 默认值 | 含义 |
|---|---|---|
| `PORT` | `8080` | HTTP 与 WebSocket 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `NODE_ENV` | `development` | 日志格式使用的运行环境 |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `ALLOWED_ORIGINS` | `*` | WebSocket Origin 白名单；公网部署应收敛为实际域名 |
| `TANK_EMPTY_MAP` | 未设置 | 测试用空地图模式 |

PowerShell 临时换端口示例：

```powershell
$env:PORT='9000'; npm run dev
```

## 6. 常见问题

### 端口被占用

```powershell
Get-NetTCPConnection -LocalPort 8080 -ErrorAction SilentlyContinue
$env:PORT='9000'; npm run dev
```

### 页面能打开但一直“连接中”

确认服务仍在运行，检查浏览器 DevTools 的 Network / WS：`101 Switching Protocols` 表示正常。若使用代理软件，确认其没有拦截 WebSocket。

### 修改后未生效

服务端没有热重载，修改 `server/` 或 `shared/` 后需重启 `npm run dev`。前端或 PNG 素材修改后刷新页面；仍为旧资源时按 `Ctrl+Shift+R` 强制刷新。

### 战场仍显示几何图形或 Emoji

渲染器会在主题图片加载失败时降级为 Canvas 几何图形/Emoji。先直接访问例如 `/assets/neon/pickup-shield.png`，再确认页面选择的主题与文件名一致；图片成功加载后，下一帧快照会重新绘制。

### 自动重连没有恢复原坦克

恢复只在断线后 20 秒内有效，且必须使用原浏览器 Profile 中保存的 `resumeToken`。清除站点数据、换 Profile、过期后重新进入，都会作为新玩家或观战者处理。
