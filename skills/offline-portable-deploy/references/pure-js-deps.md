# 纯 JS 依赖验证指引

## 问题背景

`.node` 原生模块是编译为目标平台机器码的共享库。
在 macOS 开发机上编译的 `.node` 文件无法在 Linux 上运行；
即使同为 Linux，`glibc` 或 CPU 指令集不同也可能导致加载失败。

## 检查步骤

```bash
# 1. 查找所有原生模块
find node_modules -name '*.node' | head -30

# 2. 若有结果，检查是哪个包引入的
for f in $(find node_modules -name '*.node'); do
  echo "$f  →  $(dirname $f | cut -d/ -f1-3)"
done
```

## 常见原生模块与纯 JS 替代

| 原生模块 | 用途 | 纯 JS 替代 |
|---------|------|-----------|
| `bcrypt` | 密码哈希 | `bcryptjs` |
| `sharp` | 图片处理 | `jimp`（性能较低）|
| `sqlite3` | 嵌入式数据库 | `better-sqlite3`（仍有原生模块）→ 改 pg/mysql |
| `canvas` | 服务端 Canvas | 无直接替代；考虑去掉服务端 Canvas |
| `fsevents` | macOS 文件监听 | 自动跳过（仅 macOS optional） |

## ws 模块说明

`ws` 是纯 JS WebSocket 实现，无原生模块，可安全跨平台复制。
验证：`find node_modules/ws -name '*.node'` 应无输出。

## 生产依赖裁剪

打包前只保留生产依赖，减小包体积：

```bash
# 安装生产依赖
npm ci --omit=dev

# 验证 node_modules 无原生模块
find node_modules -name '*.node' | wc -l  # 应为 0
```
