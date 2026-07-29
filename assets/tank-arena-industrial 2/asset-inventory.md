# Asset Inventory — Tank Arena / Industrial

| 优先级 | 文件 | 用途 | 尺寸 | Alpha / 状态 | drawImage 映射建议 |
|---:|---|---|---:|---|---|
| 1 | `tank-red.png` | 玩家/敌方坦克红变体（样本） | 64×64 | 是；静态 | `drawImage(img, x-16, y-16, 64, 64)`，逻辑碰撞仍为 26 px |
| 2 | `tile-brick-3.png` | 砖墙耐久 3（样本） | 32×32 | 是 | `drawImage(img, col*32, row*32, 32, 32)` |
| 3 | `fx-explosion.png` | 淘汰爆炸表（样本） | 256×64 | 是；4×64 帧 | `sx=frame*64, sy=0, sw=64, sh=64`，以中心锚点绘制 |
| 4 | `tank-blue.png` | 坦克蓝变体 | 64×64 | 是；静态 | 同 `tank-red.png` |
| 4 | `tank-green.png` | 坦克青绿变体 | 64×64 | 是；静态 | 同 `tank-red.png` |
| 4 | `tank-yellow.png` | 坦克黄变体 | 64×64 | 是；静态 | 同 `tank-red.png` |
| 4 | `bullet.png` | 能量子弹 | 16×16 | 是；静态 | 以子弹中心绘制 16×16 |
| 4 | `tile-ground.png` | 深橄榄地面，可无缝平铺 | 32×32 | 是 | 每格平铺；网格另由渲染器绘制 |
| 4 | `tile-border-steel.png` | 外圈不可破坏边界钢墙 | 32×32 | 是 | 每格绘制；区分于内部钢块 |
| 4 | `tile-brick-2.png` | 砖墙耐久 2，一条裂纹 | 32×32 | 是 | 每格绘制 |
| 4 | `tile-brick-1.png` | 砖墙耐久 1，两条裂纹 | 32×32 | 是 | 每格绘制 |
| 4 | `tile-steel.png` | 内部不可破坏钢块 | 32×32 | 是 | 每格绘制 |
| 4 | `ui-hp-pip-full.png` | 满生命短条 | 14×10 | 是 | HUD 横向重复绘制 |
| 4 | `ui-hp-pip-empty.png` | 空生命短条 | 14×10 | 是 | HUD 横向重复绘制 |
| 4 | `ui-self-ring.png` | 自身选中框 | 32×32 | 是；中部透明 | 居中叠在实体格上 |
| 4 | `fx-hit.png` | 命中环形爆点表 | 256×64 | 是；4×64 帧 | 按帧切片、中心锚点 |
| 4 | `fx-wall-spark.png` | 钢墙短促火花表 | 256×64 | 是；4×64 帧 | 按帧切片、中心锚点 |
| 4 | `fx-brick-debris.png` | 砖块碎片表 | 256×64 | 是；4×64 帧 | 按帧切片、中心锚点 |
| 4 | `fx-ram.png` | 碰撞冲击线表 | 256×64 | 是；4×64 帧 | 按帧切片、中心锚点 |
| 4 | `ui-panel-corner.png` | 面板角标 | 32×32 | 是 | 在面板四角镜像/旋转复用 |
| 4 | `ui-countdown-frame.png` | 倒计时圆环，中心透明 | 256×256 | 是；中心≥140×140 透明 | 覆盖层居中；数字由 Canvas/HTML 绘制 |
| 4 | `fx-countdown-pulse.png` | 倒计时信号环表 | 256×64 | 是；4×64 帧 | 3/2/1 各 1000 ms，左至右播放 |
| 4 | `fx-start-burst.png` | 开局信号爆发表 | 256×64 | 是；4×64 帧 | 开始阶段 900 ms，左至右播放 |
| 4 | `ui-go-frame.png` | 开始徽章框 | 256×128 | 是；中央文字区透明 | 居中；“开始！”由 Canvas/HTML 绘制 |

**共同回退：** 图片加载失败时以既有 Canvas 图形绘制坦克、地形、HUD 与特效，不阻塞游戏或网络流程。
