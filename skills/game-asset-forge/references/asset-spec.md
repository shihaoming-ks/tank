# 素材简报规格

## 建议输入格式

```yaml
assets:
  - id: player-tank
    purpose: 玩家角色
    size: 64x64
    format: png
    alpha: true
    variants: [idle, damaged]
    priority: high
style:
  direction: 赛博工业
  camera: 俯视角
  lighting: 右上方冷光
  palette: ["#0B1220", "#2DD4BF", "#FB923C"]
  avoid: [文字, 水印, 写实照片]
technical:
  tile_size: 32
  animation: { frames: 4, layout: horizontal }
delivery:
  output_dir: client/assets
  max_file_size_kb: 50
  scale_mode: nearest
integration:
  renderer_map: { player-tank: tankSprite }
  fallback: Canvas 几何绘制
```

未提供字段时，采用项目现有约定；没有现有约定时，在交付报告中写明假设。

## 命名

使用小写 kebab-case，仅编码有意义的变体：

`<类别>-<对象>-<变体>-<状态>-<帧>.<扩展名>`

示例：`tank-scout-idle.png`、`tile-brick-damaged-2.png`、`fx-hit-01.png`。

## 提示词锚点

每组提示词固定包含：美术方向、视角、透视、色温与强调色、轮廓与边缘处理、光源方向、画布尺寸。要求 Alpha 时写明“透明背景、独立素材”；需要时补充“无文字、无水印”。

## 常用交付提示

| 用途 | 建议 |
|---|---|
| 网格图块 | 按项目图块尺寸；默认不透明；检查四边拼接 |
| 角色/载具 | 预留安全边距；透明 PNG；对齐项目锚点 |
| 特效表 | 透明 PNG；固定画布与视觉重心；明确帧数和方向 |
| HUD 图标 | 正方形透明 PNG；小尺寸下仍可辨识 |
| 整体背景 | 按视口或更大；可使用 WebP/PNG；明确是否平铺 |

## 人工检查重点

在 1× 实际显示倍率检查：轮廓是否清楚、玩法状态是否可分辨、是否有错误底色、图块是否接缝、动画是否跳帧、文件是否可映射到渲染器。
