/**
 * Canvas 渲染
 *
 * ⚠️ 本模块**只读快照，不做任何判定**。
 *    它不知道游戏规则，只负责把服务端下发的状态画出来。
 *
 * 当前用几何图形占位（S3 阶段替换为 AIGC 贴图）。
 * 替换时只需把 fillRect 换成 drawImage，不触碰任何逻辑代码。
 */

import {
  BULLET_SIZE,
  COLS,
  DIR_VEC,
  MAP_H,
  MAP_W,
  ROWS,
  TANK_SIZE,
  TILE,
} from '/shared/constants.js';

/** 配色。与 CSS 变量保持一致，走军事仪表盘方向 */
const PALETTE = {
  ground: '#12150f',
  gridLine: '#1a1e16',
  wallFill: '#3d4436',
  wallEdge: '#4e5644',
  bullet: '#ffe9b0',
  selfRing: '#ffffff',
  deadTank: '#2a2e26',
};

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    /** @type {number[][]|null} 地图只在首帧下发，需缓存 */
    this.grid = null;
    /** 玩家 id → 元信息（昵称、颜色），来自 room 消息 */
    this.playerMeta = new Map();
    this.selfId = null;

    this.setupHiDPI();
  }

  /**
   * 适配高分屏。
   * 不做此处理会在 Retina 上呈现明显模糊。
   */
  setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = MAP_W * dpr;
    this.canvas.height = MAP_H * dpr;
    this.canvas.style.width = `${MAP_W}px`;
    this.canvas.style.height = `${MAP_H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setMap(grid) {
    if (grid) this.grid = grid;
  }

  setSelfId(id) {
    this.selfId = id;
  }

  setPlayers(players) {
    this.playerMeta.clear();
    for (const p of players) this.playerMeta.set(p.id, p);
  }

  /**
   * 绘制一帧。
   * @param {object} snap 服务端快照
   */
  draw(snap) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, MAP_W, MAP_H);

    this.drawGround(ctx);
    if (this.grid) this.drawWalls(ctx);
    if (snap) {
      for (const b of snap.bullets ?? []) this.drawBullet(ctx, b);
      for (const t of snap.tanks ?? []) this.drawTank(ctx, t);
    }
  }

  drawGround(ctx) {
    ctx.fillStyle = PALETTE.ground;
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    // 网格线让玩家能感知距离与格子边界，也便于判断能否通过
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let c = 1; c < COLS; c++) {
      ctx.moveTo(c * TILE + 0.5, 0);
      ctx.lineTo(c * TILE + 0.5, MAP_H);
    }
    for (let r = 1; r < ROWS; r++) {
      ctx.moveTo(0, r * TILE + 0.5);
      ctx.lineTo(MAP_W, r * TILE + 0.5);
    }
    ctx.stroke();
  }

  drawWalls(ctx) {
    for (let r = 0; r < this.grid.length; r++) {
      const row = this.grid[r];
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== 1) continue;
        const x = c * TILE;
        const y = r * TILE;

        ctx.fillStyle = PALETTE.wallFill;
        ctx.fillRect(x, y, TILE, TILE);
        // 内描边营造砖块厚度感，避免大片纯色显得扁平
        ctx.strokeStyle = PALETTE.wallEdge;
        ctx.lineWidth = 1;
        ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      }
    }
  }

  drawTank(ctx, tank) {
    const meta = this.playerMeta.get(tank.id);
    const color = tank.alive ? (meta?.color ?? '#888') : PALETTE.deadTank;
    const half = TANK_SIZE / 2;

    ctx.save();
    ctx.translate(tank.x, tank.y);

    // 无敌期闪烁：用时间驱动的透明度，让玩家明确知道处于保护状态
    if (tank.inv) {
      ctx.globalAlpha = 0.4 + 0.35 * Math.sin(Date.now() / 90);
    }

    // 车体
    ctx.fillStyle = color;
    ctx.fillRect(-half, -half, TANK_SIZE, TANK_SIZE);

    // 履带：两侧深色条带，提示这是载具而非方块
    ctx.fillStyle = 'rgb(0 0 0 / 32%)';
    const vec = DIR_VEC[tank.dir] ?? DIR_VEC.up;
    if (vec.x !== 0) {
      ctx.fillRect(-half, -half, TANK_SIZE, 4);
      ctx.fillRect(-half, half - 4, TANK_SIZE, 4);
    } else {
      ctx.fillRect(-half, -half, 4, TANK_SIZE);
      ctx.fillRect(half - 4, -half, 4, TANK_SIZE);
    }

    // 炮管
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = 'square';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(vec.x * (half + 7), vec.y * (half + 7));
    ctx.stroke();

    // 自己的坦克加白色描边环，避免在同色系里找不到自己
    if (tank.id === this.selfId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PALETTE.selfRing;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(-half - 3.5, -half - 3.5, TANK_SIZE + 7, TANK_SIZE + 7);
    }

    ctx.restore();

    // 昵称与血量画在坦克上方，不受 alpha 影响
    if (meta) this.drawNameplate(ctx, tank, meta);
  }

  drawNameplate(ctx, tank, meta) {
    ctx.save();
    ctx.font = '10px "SF Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const label = tank.alive ? meta.nickname : `${meta.nickname} · 淘汰`;
    const y = tank.y - TANK_SIZE / 2 - 8;

    // 描边保证在任何底色上都可读
    ctx.strokeStyle = 'rgb(0 0 0 / 78%)';
    ctx.lineWidth = 3;
    ctx.strokeText(label, tank.x, y);
    ctx.fillStyle = tank.alive ? '#d8dcd6' : '#6b7266';
    ctx.fillText(label, tank.x, y);

    ctx.restore();
  }

  drawBullet(ctx, b) {
    ctx.save();
    // 外发光让高速小物体更易被察觉
    ctx.shadowColor = PALETTE.bullet;
    ctx.shadowBlur = 6;
    ctx.fillStyle = PALETTE.bullet;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
