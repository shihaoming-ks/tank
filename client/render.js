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
    /**
     * 瞬时特效列表。由 event 消息驱动，按时间衰减后自动移除。
     * 特效纯属表现层，不影响任何状态。
     * @type {Array<object>}
     */
    this.effects = [];
    /** playerId → 命中闪白截止时间 */
    this.flash = new Map();

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
   * 接收服务端事件并转为视觉特效。
   * 这是 event 消息在渲染层的唯一入口。
   */
  handleEvents(events) {
    const now = performance.now();
    for (const ev of events) {
      if (ev.kind === 'hit') {
        // 撞墙用小火花，命中坦克用较大爆点并让目标闪白
        this.effects.push({
          type: ev.wall ? 'spark' : 'burst',
          x: ev.x,
          y: ev.y,
          born: now,
          life: ev.wall ? 220 : 340,
        });
        if (ev.targetId) this.flash.set(ev.targetId, now + 150);
      } else if (ev.kind === 'kill') {
        this.effects.push({ type: 'explosion', x: ev.x, y: ev.y, born: now, life: 620 });
      }
    }
  }

  /** 清空特效。用于开新一局，避免上局残留 */
  clearEffects() {
    this.effects = [];
    this.flash.clear();
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
    this.drawEffects(ctx);
  }

  /**
   * 绘制并回收瞬时特效。
   * 用 performance.now 而非快照帧号驱动：特效必须按真实时间衰减，
   * 否则网络抖动会让爆炸忽快忽慢。
   */
  drawEffects(ctx) {
    const now = performance.now();
    const alive = [];

    for (const fx of this.effects) {
      const p = (now - fx.born) / fx.life;
      if (p >= 1) continue;
      alive.push(fx);

      ctx.save();
      if (fx.type === 'spark') {
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = '#cfd6c4';
        const r = 2 + p * 5;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
        ctx.fill();
      } else if (fx.type === 'burst') {
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = '#ffd98a';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 4 + p * 14, 0, Math.PI * 2);
        ctx.stroke();
      } else if (fx.type === 'explosion') {
        // 双层扩散圆环 + 中心亮斑，纯几何实现，零素材
        ctx.globalAlpha = (1 - p) * 0.9;
        ctx.strokeStyle = '#ff8f4d';
        ctx.lineWidth = 3 * (1 - p) + 1;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 6 + p * 34, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = (1 - p) * 0.55;
        ctx.strokeStyle = '#ffe9b0';
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 3 + p * 20, 0, Math.PI * 2);
        ctx.stroke();

        ctx.globalAlpha = Math.max(0, 1 - p * 2.4);
        ctx.fillStyle = '#fff6df';
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, 9 * (1 - p), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    this.effects = alive;
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
    const flashUntil = this.flash.get(tank.id) ?? 0;
    const isFlashing = performance.now() < flashUntil;

    let color = tank.alive ? (meta?.color ?? '#888') : PALETTE.deadTank;
    // 命中瞬间整车闪白，是最直接的受击反馈
    if (isFlashing && tank.alive) color = '#ffffff';

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
    // 外发光让高速小物体更易被察觉；用发射者颜色便于分辨威胁来源
    const tint = b.color ?? PALETTE.bullet;
    ctx.shadowColor = tint;
    ctx.shadowBlur = 8;
    ctx.fillStyle = PALETTE.bullet;
    ctx.beginPath();
    ctx.arc(b.x, b.y, BULLET_SIZE / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
