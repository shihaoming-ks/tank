# 霓虹未来主题素材清单

## 风格锚点

近黑竞技场、青色能量回路、洋红警示信号与克制的边缘发光；严格俯视、锐利技术面板、无文字与水印。坦克和图块来自本次图像生成的主题样本，缩放并切片为渲染器规格；子弹、生命格和特效以同一色板补齐。

| 文件 | 规格 | 用途 |
|---|---:|---|
| `tank-{red,blue,green,yellow}.png` | 64×64 / Alpha | 四位玩家坦克 |
| `bullet.png` | 16×16 / Alpha | 能量炮弹 |
| `tile-{ground,border-steel,brick-3,steel}.png` | 32×32 | 地面、边界、砖墙、钢墙 |
| `ui-hp-pip-{full,empty}.png` | 14×10 / Alpha | 生命格 |
| `fx-{hit,wall-spark,explosion,brick-debris,ram}.png` | 256×64 / Alpha | 横向四帧特效表 |

## 接入与验收

- 路径为 `/assets/neon/<file>`，由 `client/render.js` 的 `ASSET_THEMES` 预加载；图片失效时保持 Canvas 几何回退。
- 特效每帧为 64×64，从左到右播放；图块按 32×32 使用。
- 已检查文件名、PNG 尺寸、Alpha 以及四种坦克颜色区分。
