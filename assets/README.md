# Tank Arena 运行时素材

本目录已不再是预留目录。`client/render.js` 会根据当前主题从 `/assets/<theme>/` 预加载 PNG，并在加载失败时退回 Canvas 几何渲染。

## 主题

| 目录 | 主题值 | 定位 |
|---|---|---|
| `industrial/` | `industrial` | 军械终端 |
| `pixel/` | `pixel` | 像素街机 |
| `cartoon/` | `cartoon` | 手绘战术 |
| `neon/` | `neon` | 霓虹赛博 |

每套主题至少包含以下已经接入的文件：

```text
tank-{red,blue,green,yellow}.png       # 64x64，透明
bullet.png                             # 16x16，透明
tile-{ground,border-steel,brick-3,steel}.png  # 32x32
ui-hp-pip-{full,empty}.png             # 14x10，透明
fx-{hit,wall-spark,explosion,brick-debris,ram}.png # 256x64，横向四帧
pickup-{shield,boost,power,health,revive}.png       # 32x32，透明
```

文件名是运行时契约，替换美术时不要改名。地形需可平铺；特效图每帧 64x64、横向四帧且中心锚点一致；道具图标应保持透明背景和高对比度。

`sprites/.gitkeep` 仅保留兼容旧目录，不是当前加载路径。

完整的再生成提示词见 [docs/S3-THEME-ASSET-PROMPTS.md](../docs/S3-THEME-ASSET-PROMPTS.md)，每套主题目录内的 `asset-manifest.md` 与 `frontend-style-prompt.md` 记录该主题的细节。
