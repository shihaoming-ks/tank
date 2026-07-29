# 部署到无 Node 环境的物理机

> **当前状态（2026-07-29）：**便携构建脚本仍可用，且会随包带上当前四套主题素材。`dist/` 是构建产物而非当前版本的事实来源；发布前必须从待发布提交重新构建，并在目标机执行健康检查和至少一次联机验证。

> 目标：把游戏部署到一台**没有安装 Node、可能无法联网**的 Linux 机器上。
>
> 做法：在有网的开发机上打一个**自包含便携包**（内含 Node 运行时），
> 拷到目标机解开即可运行。

---

## 为什么能这么做

| 前提 | 说明 |
|---|---|
| 唯一运行时依赖 `ws` 是**纯 JS** | 无 `.node` 原生产物，故可在 macOS 打包、Linux 运行 |
| 前端零构建 | 原生 ESM + Canvas，没有编译步骤，源码即产物 |
| Node 官方二进制免安装 | 解压出的 `bin/node` 可直接执行，无需 root、不污染系统 |
| 老系统有专用构建 | CentOS 7 等 glibc 2.17 环境可用 `glibc-217` 变体 |

> ⚠️ 若将来引入了含原生扩展的依赖（如 `bufferutil`、`sharp`、`better-sqlite3`），
> 这个方案会失效 —— 必须改为在**目标平台**上执行 `npm install`，或改用 Docker。

---

## 一、在开发机打包

```bash
# 默认 linux-x64
bash scripts/build-portable.sh

# 其他平台
TARGET=linux-arm64 bash scripts/build-portable.sh
TARGET=darwin-arm64 bash scripts/build-portable.sh
```

产物：`dist/tank-arena-<版本>-<平台>.tar.gz`（约 41MB）

首次运行会下载 Node 运行时（约 29MB）到 `.cache/`，之后复用，**不再需要联网**。

### 怎么确认目标平台

在目标机执行**两条**命令：

```bash
uname -m        # CPU 架构
ldd --version   # glibc 版本 ← 别漏这条
```

| `uname -m` | `ldd` 版本 | TARGET |
|---|---|---|
| `x86_64` | ≥ 2.28 | `linux-x64` |
| `x86_64` | **< 2.28**（CentOS 7 / RHEL 7 是 2.17） | **`linux-x64-glibc-217`** |
| `aarch64` | ≥ 2.28 | `linux-arm64` |

⚠️ **glibc 版本这一条最容易漏，代价却最大。**

官方 Node 二进制从 v18 起要求 glibc ≥ 2.28，而 CentOS 7 只有 2.17。
用错会在目标机启动时报：

```
./runtime/bin/node: /lib64/libc.so.6: version `GLIBC_2.28' not found
./runtime/bin/node: /lib64/libstdc++.so.6: version `GLIBCXX_3.4.21' not found
```

此时改用 `glibc-217` 变体重新打包即可 —— 它由 nodejs 官方的
[unofficial-builds](https://unofficial-builds.nodejs.org/) 针对老系统重新编译，
只依赖到 `GLIBC_2.17` / `GLIBCXX_3.4.19`，恰好是 CentOS 7 提供的上限：

```bash
TARGET=linux-x64-glibc-217 npm run build:portable
```

构建时会打印实际的符号依赖，可与目标机对照：

```
运行时要求：GLIBC_2.17 / GLIBCXX_3.4.19
```

**架构填错的症状**则是 `cannot execute binary file: Exec format error`。

---

## 二、拷到目标机

任选其一：

```bash
# SSH 可达
scp dist/tank-arena-0.1.0-linux-x64.tar.gz user@目标机:~/

# 完全隔离 —— 拷到 U 盘
cp dist/tank-arena-0.1.0-linux-x64.tar.gz /Volumes/U盘/
```

---

## 三、在目标机运行

```bash
tar -xzf tank-arena-0.1.0-linux-x64.tar.gz
cd tank-arena-0.1.0-linux-x64
./start.sh
```

看到下面这样就成功了：

```
──────────────────────────────────────────────
  坦克竞技场启动中
  本机访问 : http://localhost:8080
  局域网   : http://192.168.1.42:8080
  停止服务 : Ctrl+C
──────────────────────────────────────────────
```

玩家在浏览器打开**局域网那个地址**即可。

### 后台常驻

`./start.sh` 会占住终端，关掉 SSH 就停了。要长期运行用：

```bash
./start-daemon.sh        # 启动
./health.sh              # 检查状态
tail -f logs/server.log  # 看日志
./stop.sh                # 停止
```

`stop.sh` 先发 `SIGTERM` 走优雅退出（会广播「服务维护中」给在线玩家），
超过 5 秒未退出才强杀。

### 换端口

```bash
PORT=9000 ./start.sh
```

### 开机自启

包内 `tank-arena.service.template` 有 systemd 配置，替换两个占位符后：

```bash
sudo cp tank-arena.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tank-arena
```

---

## 四、包里有什么

```
tank-arena-0.1.0-linux-x64/
├── runtime/bin/node    # 内置 Node 运行时（117MB，占了绝大部分体积）
├── server/             # 权威服务端
├── client/             # 前端（零构建，源码即产物）
├── shared/             # 双端共享的协议与常量
├── node_modules/ws/    # 唯一依赖
├── start.sh            # 前台启动
├── start-daemon.sh     # 后台启动
├── stop.sh             # 优雅停止
├── health.sh           # 健康检查
├── tank-arena.service.template
└── 部署说明.txt         # 给运维看的精简版
```

只保留了 `bin/node`，丢掉了 npm、文档和头文件 —— 目标机不需要装包，依赖已随包提供。

---

## 五、可配置项

全部通过环境变量传入，无需改代码：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `HOST` | `0.0.0.0` | `0.0.0.0` 允许局域网访问；`127.0.0.1` 仅本机 |
| `NODE_ENV` | `production` | 运行环境 |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `ALLOWED_ORIGINS` | `*` | WS 来源白名单，公网部署建议收敛为具体域名 |

---

## 六、故障排查

### 只有本机能打开，别人访问不了

九成是防火墙。

```bash
# firewalld（CentOS / RHEL / Fedora）
sudo firewall-cmd --add-port=8080/tcp --permanent && sudo firewall-cmd --reload

# ufw（Ubuntu / Debian）
sudo ufw allow 8080/tcp
```

云服务器还需在控制台的**安全组**里放行该端口。

### `GLIBC_2.28 not found` / `GLIBCXX_3.4.21 not found`

系统 glibc 太旧（CentOS 7 / RHEL 7 为 2.17，官方 Node 要求 ≥ 2.28）。

```bash
# 在开发机重新打包
TARGET=linux-x64-glibc-217 npm run build:portable
```

`start.sh` 会在启动前自检运行时，遇到这类问题会直接给出上面这条命令，
不必自己判断。

> 顺带说明：原先的输出会先打印「坦克竞技场启动中」再报 GLIBC 错误，
> 看起来像应用崩溃、实际是运行时根本没跑起来。现已改为**先自检再打印**。

### `cannot execute binary file: Exec format error`

CPU 架构不匹配。用 `uname -m` 确认后重新打包。

### `./start.sh: Permission denied`

```bash
chmod +x *.sh
```

（经 U 盘或某些解压工具中转会丢失执行权限。）

### 端口被占用

```bash
ss -ltnp | grep 8080      # 查谁占了
PORT=9000 ./start.sh      # 或直接换端口
```

### 玩家进不了同一房间

双方必须访问**同一个地址**（同 IP 同端口）。
一人用 `localhost`、另一人用局域网 IP 会连到同一进程，这没问题；
但如果起了**两个实例**，就会连到不同进程 —— 见下方硬约束。

### 想减小包体积

内置的 Node 带调试符号（117MB）。在目标机上可剥离：

```bash
strip runtime/bin/node    # 可省约 40MB
```

macOS 的 `strip` 无法处理 Linux ELF，所以打包时没做这一步。

---

## 七、硬约束：只能起一个实例

世界状态保存在**进程内存**中。起多个实例并做负载均衡，会让玩家 A 和 B
连到**两个不同进程**，各自维护一份世界状态 —— 直接违反「双端结果一致」这一门槛项。

若将来确实需要多实例，必须按 `roomId` 做一致性哈希路由，属超纲项。

---

## 八、和 S5 容器云部署的关系

本文档解决的是「**临时/内网物理机快速起服**」，与
[（已删除）
描述的容器云部署并不冲突，反而是它的**兜底方案**：

> 若容器云审批未通过或线上 WSS 通路不可用，可直接在局域网物理机上起本包，
> 评审访问内网 IP 即可。

这也是原计划里「风险与对策」一节提到的降级路径。
