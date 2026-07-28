# assets/ —— 视觉资产目录

MVP 阶段**为空**：所有视觉元素由 `client/render.js` 用 Canvas 几何图形（色块 / 圆环 / 线段）绘制，无需任何图片资源。

## 后续接入 AIGC 素材时的规范

```
assets/
└── sprites/
    ├── tank-red.png       64×64  PNG 带透明通道
    ├── tank-blue.png
    ├── tank-green.png
    ├── tank-yellow.png
    ├── wall-brick.png     32×32  与 TILE 尺寸一致
    ├── bullet.png         16×16
    └── explosion.png      256×64 序列帧（4 帧 × 64px）
```

### 硬约束

| 项 | 要求 |
|---|---|
| 格式 | PNG，必须带 Alpha 透明通道 |
| 尺寸 | 坦克 64×64；墙体必须等于 `TILE`（32）；子弹 16×16 |
| 命名 | 全小写，`kebab-case`，`<类别>-<变体>.png` |
| 色板 | 与 `shared/constants.js` 的 `COLORS` 保持一致 |
| 体积 | 单文件 < 50KB |

### 替换方式

素材接入**只需修改 `client/render.js`**，把 `ctx.fillRect(...)` 换成 `ctx.drawImage(...)`，
不得触碰 `server/` 与 `shared/` 下的任何逻辑代码。
