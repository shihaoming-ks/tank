# Asset Manifest

## 风格摘要
- 方向：16-bit 像素街机，硬像素、有限调色板。
- 视角与光源：严格正俯视；奶油白高光、深紫阴影。
- 调色板：午夜蓝紫、亮紫、奶油白、红棕，以及高饱和红/蓝/青绿/黄。
- 禁止元素：文字、Logo、水印、人物、模糊、抗锯齿和写实纹理。

## 文件
| 文件 | 用途 | 尺寸 | 格式/Alpha | 状态或帧 | 渲染器映射 | 验收 |
|---|---|---:|---|---|---|---|
| `bullet.png` | pixel 主题素材 | 16×16 | PNG / 是 | 静态 | `Renderer._img('bullet')` | 通过 |
| `fx-brick-debris.png` | pixel 主题素材 | 256×64 | PNG / 是 | 4 帧横排 | `Renderer._img('fx-brick-debris')` | 通过 |
| `fx-explosion.png` | pixel 主题素材 | 256×64 | PNG / 是 | 4 帧横排 | `Renderer._img('fx-explosion')` | 通过 |
| `fx-hit.png` | pixel 主题素材 | 256×64 | PNG / 是 | 4 帧横排 | `Renderer._img('fx-hit')` | 通过 |
| `fx-ram.png` | pixel 主题素材 | 256×64 | PNG / 是 | 4 帧横排 | `Renderer._img('fx-ram')` | 通过 |
| `fx-wall-spark.png` | pixel 主题素材 | 256×64 | PNG / 是 | 4 帧横排 | `Renderer._img('fx-wall-spark')` | 通过 |
| `tank-blue.png` | pixel 主题素材 | 64×64 | PNG / 是 | 静态 | `Renderer._img('tank-blue')` | 通过 |
| `tank-green.png` | pixel 主题素材 | 64×64 | PNG / 是 | 静态 | `Renderer._img('tank-green')` | 通过 |
| `tank-red.png` | pixel 主题素材 | 64×64 | PNG / 是 | 静态 | `Renderer._img('tank-red')` | 通过 |
| `tank-yellow.png` | pixel 主题素材 | 64×64 | PNG / 是 | 静态 | `Renderer._img('tank-yellow')` | 通过 |
| `tile-border-steel.png` | pixel 主题素材 | 32×32 | PNG / 是 | 静态 | `Renderer._img('tile-border-steel')` | 通过 |
| `tile-brick-3.png` | pixel 主题素材 | 32×32 | PNG / 是 | 静态 | `Renderer._img('tile-brick-3')` | 通过 |
| `tile-ground.png` | pixel 主题素材 | 32×32 | PNG / 是 | 静态 | `Renderer._img('tile-ground')` | 通过 |
| `tile-steel.png` | pixel 主题素材 | 32×32 | PNG / 是 | 静态 | `Renderer._img('tile-steel')` | 通过 |
| `ui-hp-pip-empty.png` | pixel 主题素材 | 14×10 | PNG / 是 | 静态 | `Renderer._img('ui-hp-pip-empty')` | 通过 |
| `ui-hp-pip-full.png` | pixel 主题素材 | 14×10 | PNG / 是 | 静态 | `Renderer._img('ui-hp-pip-full')` | 通过 |

## 生成摘要
- 共享提示词锚点：16-bit 像素街机、正俯视、硬边、无模糊、有限调色板。
- 各文件差异：坦克仅改变主色；地形按阻挡语义区分；特效为 4 帧横排。

## 接入与回退
- 加载方式：`/assets/pixel/`，由 `client/render.js` 根据 `body[data-theme]` 选择。
- 加载失败回退：保留现有 Canvas 几何绘制。

## 未解决项
- 无。
