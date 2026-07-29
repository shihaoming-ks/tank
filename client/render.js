/**
 * Canvas 渲染
 *
 * ⚠️ 本模块**只读快照，不做任何判定**。
 *    它不知道游戏规则，只负责把服务端下发的状态画出来。
 *
 * S3 阶段：优先使用 client/assets/industrial/ 下的 AIGC 贴图；
 * 任何图片加载失败时自动回退 Canvas 几何绘制，不影响游戏。
 */

import {
  BARREL_LEN,
  BULLET_SIZE,
  COLS,
  DIR_VEC,
  GO_TEXT_MS,
  MAP_H,
  MAP_W,
  MAX_HP,
  ROWS,
  TANK_BODY,
  TANK_SIZE,
  TILE,
  TILE_TYPE,
} from '/shared/constants.js';

/** 工业主题调色板（与 CSS 变量保持一致） */
const PALETTE = {
  ground:   '#12150f',
  gridLine: '#1a1e16',
  bullet:   '#ffe9b0',
  selfRing: '#ffffff',
  deadTank: '#2a2e26',
};

/**
 * 几何回退样式（图片加载失败时使用）
 */
const TILE_STYLE = {
  [TILE_TYPE.BORDER]: { fill: '#5a5f52', edge: '#767c6a', style: 'border' },
  [TILE_TYPE.BRICK]:  { fill: '#8a5a3c', edge: '#a97148', style: 'brick', damage: 0 },
  [TILE_TYPE.BRICK_2]:{ fill: '#7a4e33', edge: '#96633f', style: 'brick', damage: 1 },
  [TILE_TYPE.BRICK_1]:{ fill: '#69422b', edge: '#835435', style: 'brick', damage: 2 },
  [TILE_TYPE.STEEL]:  { fill: '#4a5560', edge: '#6b7a88', style: 'steel' },
};

/** 坦克颜色 → 素材文件名映射 */
const TANK_COLOR_MAP = {
  '#e94f37': 'tank-red',
  '#3f88c5': 'tank-blue',
  '#44bba4': 'tank-green',
  '#f6ae2d': 'tank-yellow',
};

/** 素材根目录 */
const ASSETS = '/assets/industrial/';

/**
 * 加载一张图片；失败时返回 null（不抛异常）。
 * @param {string} src
 * @returns {Promise<HTMLImageElement|null>}
 */
function loadImg(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/**
 * 特效帧数配置：每种特效对应精灵表的帧数与持续时间
 */
const FX_SPRITE = {
  burst:     { file: 'fx-hit.png',          frames: 4 },
  spark:     { file: 'fx-wall-spark.png',    frames: 4 },
  explosion: { file: 'fx-explosion.png',     frames: 4 },
  debris:    { file: 'fx-brick-debris.png',  frames: 4 },
  ram:       { file: 'fx-ram.png',           frames: 4 },
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
    /**
     * 「开始！」文字的展示截止时间（performance.now 基准）。
     */
    this.goUntil = 0;
    /** 上一帧的倒计时剩余，用于检测"倒计时刚结束"这一瞬间 */
    this.lastCd = 0;

    /** 已加载的图片缓存 key→HTMLImageElement|null */
    this._imgs = new Map();
    /** 异步预加载 Promise */
    this._ready = this._preload();

    this.setupHiDPI();
  }

  /**
   * 预加载所有静态素材。
   * 加载失败不阻塞游戏，对应位置自动用几何绘制。
   */
  async _preload() {
    const files = [
      'tank-red.png', 'tank-blue.png', 'tank-green.png', 'tank-yellow.png',
      'bullet.png',
      'tile-ground.png', 'tile-border-steel.png', 'tile-brick-3.png', 'tile-steel.png',
      'fx-hit.png', 'fx-wall-spark.png', 'fx-explosion.png',
      'fx-brick-debris.png', 'fx-ram.png',
      'ui-hp-pip-full.png', 'ui-hp-pip-empty.png',
    ];
    await Promise.all(files.map(async f => {
      this._imgs.set(f, await loadImg(ASSETS + f));
    }));
  }

  /** 获取已缓存图片，没有则返回 null */
  _img(name) {
    return this._imgs.get(name) ?? null;
  }

  /**
   * 适配高分屏。
   */
  setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width  = MAP_W * dpr;
    this.canvas.height = MAP_H * dpr;
    this.canvas.style.width  = `${MAP_W}px`;
    this.canvas.style.height = `${MAP_H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  setMap(grid) {
    if (grid) this.grid = grid;
  }

  /**
   * 应用地图增量（砖墙被击破）。
   */
  applyMapPatches(patches) {
    if (!this.grid || !patches?.length) return;
    for (const p of patches) {
      if (this.grid[p.r]) this.grid[p.r][p.c] = p.v;
    }
  }

  setSelfId(id) { this.selfId = id; }

  setPlayers(players) {
    this.playerMeta.clear();
    for (const p of players) this.playerMeta.set(p.id, p);
  }

  /**
   * 接收服务端事件并转为视觉特效。
   */
  handleEvents(events) {
    const now = performance.now();
    for (const ev of events) {
      if (ev.kind === 'hit') {
        this.effects.push({
          type: ev.wall ? 'spark' : 'burst',
          x: ev.x, y: ev.y,
          born: now,
          life: ev.wall ? 220 : 340,
        });
        if (ev.targetId) this.flash.set(ev.targetId, now + 150);
      } else if (ev.kind === 'kill') {
        this.effects.push({ type: 'explosion', x: ev.x, y: ev.y, born: now, life: 620 });
      } else if (ev.kind === 'brick_break') {
        this.effects.push({
          type: ev.broken ? 'debris' : 'dust',
          x: ev.x, y: ev.y,
          born: now,
          life: ev.broken ? 460 : 260,
        });
      } else if (ev.kind === 'ram') {
        this.effects.push({ type: 'ram', x: ev.x, y: ev.y, born: now, life: 380 });
      }
    }
  }

  /** 清空特效。用于开新一局，避免上局残留 */
  clearEffects() {
    this.effects = [];
    this.flash.clear();
    this.goUntil = 0;
    this.lastCd  = 0;
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
      for (const t of snap.tanks   ?? []) this.drawTank(ctx, t);
    }
    this.drawEffects(ctx);

    const cd = snap?.cd ?? 0;
    if (cd > 0) {
      this.drawCountdown(ctx, cd);
    } else if (this.lastCd > 0) {
      this.goUntil = performance.now() + GO_TEXT_MS;
    }
    this.lastCd = cd;

    if (performance.now() < this.goUntil) this.drawGo(ctx);
  }

  // ─── 地面 ────────────────────────────────────────────────────────────────

  drawGround(ctx) {
    const img = this._img('tile-ground.png');
    if (img) {
      // 用图片平铺地面
      const pat = ctx.createPattern(img, 'repeat');
      if (pat) {
        ctx.fillStyle = pat;
        ctx.fillRect(0, 0, MAP_W, MAP_H);
      } else {
        ctx.fillStyle = PALETTE.ground;
        ctx.fillRect(0, 0, MAP_W, MAP_H);
      }
    } else {
      ctx.fillStyle = PALETTE.ground;
      ctx.fillRect(0, 0, MAP_W, MAP_H);
    }

    // 网格线叠加（不烘焙进地面贴图）
    ctx.strokeStyle = PALETTE.gridLine;
    ctx.lineWidth   = 1;
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

  // ─── 墙体 ────────────────────────────────────────────────────────────────

  drawWalls(ctx) {
    for (let r = 0; r < this.grid.length; r++) {
      const row = this.grid[r];
      for (let c = 0; c < row.length; c++) {
        const tile = row[c];
        if (tile === TILE_TYPE.EMPTY) continue;
        this.drawTile(ctx, tile, c * TILE, r * TILE);
      }
    }
  }

  drawTile(ctx, tile, x, y) {
    // 边界钢墙
    if (tile === TILE_TYPE.BORDER) {
      const img = this._img('tile-border-steel.png');
      if (img) { ctx.drawImage(img, x, y, TILE, TILE); return; }
      return this._drawTileGeo(ctx, tile, x, y);
    }

    // 内部钢块
    if (tile === TILE_TYPE.STEEL) {
      const img = this._img('tile-steel.png');
      if (img) { ctx.drawImage(img, x, y, TILE, TILE); return; }
      return this._drawTileGeo(ctx, tile, x, y);
    }

    // 砖墙（三种耐久度）：图片统一用 tile-brick-3.png，
    // 耐久状态通过 Canvas 裂纹叠加表达（与原几何逻辑一致）
    if (tile === TILE_TYPE.BRICK || tile === TILE_TYPE.BRICK_2 || tile === TILE_TYPE.BRICK_1) {
      const img = this._img('tile-brick-3.png');
      if (img) {
        ctx.drawImage(img, x, y, TILE, TILE);
        // 叠加裂纹（与原几何版相同逻辑）
        const s = TILE_STYLE[tile];
        if (s && s.damage > 0) {
          ctx.save();
          ctx.strokeStyle = 'rgb(0 0 0 / 65%)';
          ctx.lineWidth   = 1.5;
          ctx.beginPath();
          ctx.moveTo(x + 6,  y + 4);
          ctx.lineTo(x + 14, y + 16);
          ctx.lineTo(x + 9,  y + 27);
          if (s.damage > 1) {
            ctx.moveTo(x + TILE - 5,  y + 7);
            ctx.lineTo(x + TILE - 15, y + 18);
            ctx.lineTo(x + TILE - 8,  y + TILE - 4);
          }
          ctx.stroke();
          ctx.restore();
        }
        return;
      }
      return this._drawTileGeo(ctx, tile, x, y);
    }
  }

  /** 几何回退 */
  _drawTileGeo(ctx, tile, x, y) {
    const s = TILE_STYLE[tile];
    if (!s) return;

    ctx.fillStyle = s.fill;
    ctx.fillRect(x, y, TILE, TILE);
    ctx.strokeStyle = s.edge;
    ctx.lineWidth = 1;

    if (s.style === 'border') {
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      ctx.strokeRect(x + 4.5, y + 4.5, TILE - 9, TILE - 9);
    } else if (s.style === 'brick') {
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        const ly = y + (TILE / 4) * i;
        ctx.moveTo(x, ly + 0.5); ctx.lineTo(x + TILE, ly + 0.5);
      }
      for (let i = 0; i < 4; i++) {
        const ly = y + (TILE / 4) * i;
        const lx = x + (i % 2 === 0 ? TILE / 2 : TILE / 4);
        ctx.moveTo(lx + 0.5, ly); ctx.lineTo(lx + 0.5, ly + TILE / 4);
      }
      ctx.stroke();
      if (s.damage > 0) {
        ctx.strokeStyle = 'rgb(0 0 0 / 55%)';
        ctx.lineWidth   = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 6,  y + 4);
        ctx.lineTo(x + 14, y + 16);
        ctx.lineTo(x + 9,  y + 27);
        if (s.damage > 1) {
          ctx.moveTo(x + TILE - 5,  y + 7);
          ctx.lineTo(x + TILE - 15, y + 18);
          ctx.lineTo(x + TILE - 8,  y + TILE - 4);
        }
        ctx.stroke();
      }
    } else if (s.style === 'steel') {
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      ctx.fillStyle = s.edge;
      const p = 5, rr = 2;
      for (const [dx, dy] of [[p,p],[TILE-p,p],[p,TILE-p],[TILE-p,TILE-p]]) {
        ctx.beginPath(); ctx.arc(x+dx, y+dy, rr, 0, Math.PI*2); ctx.fill();
      }
      ctx.fillStyle = 'rgb(255 255 255 / 8%)';
      ctx.fillRect(x + TILE/2 - 5, y + TILE/2 - 5, 10, 10);
    }
  }

  // ─── 坦克 ────────────────────────────────────────────────────────────────

  drawTank(ctx, tank) {
    const meta        = this.playerMeta.get(tank.id);
    const flashUntil  = this.flash.get(tank.id) ?? 0;
    const isFlashing  = performance.now() < flashUntil;
    let   color       = tank.alive ? (meta?.color ?? '#888') : PALETTE.deadTank;
    if (isFlashing && tank.alive) color = '#ffffff';

    const tankFile = TANK_COLOR_MAP[meta?.color] ? TANK_COLOR_MAP[meta.color] + '.png' : null;
    const tankImg  = tankFile ? this._img(tankFile) : null;

    ctx.save();
    ctx.translate(tank.x, tank.y);

    if (tank.inv) {
      ctx.globalAlpha = 0.4 + 0.35 * Math.sin(Date.now() / 90);
    }

    if (tankImg) {
      // ── 贴图模式（存活 / 受击 / 死亡统一走贴图） ────────────────────
      const vec      = DIR_VEC[tank.dir] ?? DIR_VEC.up;
      const angleDeg = vec.x === 1 ? 90 : vec.x === -1 ? -90 : vec.y === 1 ? 180 : 0;
      ctx.rotate(angleDeg * Math.PI / 180);
      const half = TANK_SIZE / 2;
      if (!tank.alive) {
        // 淘汰：降低透明度让坦克"熄火"变暗
        ctx.globalAlpha = (tank.inv ? (0.4 + 0.35 * Math.sin(Date.now() / 90)) : 1) * 0.35;
      }
      ctx.drawImage(tankImg, -half, -half, TANK_SIZE, TANK_SIZE);
      // 受击：在贴图上叠半透明白色蒙版，保留轮廓形状
      if (isFlashing && tank.alive) {
        ctx.save();
        ctx.globalCompositeOperation = 'source-atop';
        ctx.fillStyle = 'rgb(255 255 255 / 70%)';
        ctx.fillRect(-half, -half, TANK_SIZE, TANK_SIZE);
        ctx.restore();
      }
    } else {
      // ── 几何回退（图片未加载时） ─────────────────────────────────────
      const bodyHalf = TANK_BODY / 2;
      const vec      = DIR_VEC[tank.dir] ?? DIR_VEC.up;

      ctx.strokeStyle = color;
      ctx.lineWidth   = 5;
      ctx.lineCap     = 'butt';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(vec.x * (bodyHalf + BARREL_LEN), vec.y * (bodyHalf + BARREL_LEN));
      ctx.stroke();

      ctx.fillStyle = color;
      ctx.fillRect(-bodyHalf, -bodyHalf, TANK_BODY, TANK_BODY);

      ctx.fillStyle = 'rgb(0 0 0 / 32%)';
      if (vec.x !== 0) {
        ctx.fillRect(-bodyHalf, -bodyHalf, TANK_BODY, 3);
        ctx.fillRect(-bodyHalf, bodyHalf - 3, TANK_BODY, 3);
      } else {
        ctx.fillRect(-bodyHalf, -bodyHalf, 3, TANK_BODY);
        ctx.fillRect(bodyHalf - 3, -bodyHalf, 3, TANK_BODY);
      }
    }

    // 自选中框（始终用几何绘制，确保清晰）
    if (tank.id === this.selfId) {
      ctx.globalAlpha  = 1;
      ctx.strokeStyle  = PALETTE.selfRing;
      ctx.lineWidth    = 1;
      const h = TANK_SIZE / 2;
      ctx.strokeRect(-h - 0.5, -h - 0.5, TANK_SIZE + 1, TANK_SIZE + 1);
    }

    ctx.restore();

    if (meta) this.drawNameplate(ctx, tank, meta);
  }

  drawNameplate(ctx, tank, meta) {
    ctx.save();

    if (tank.alive) {
      const pipW  = 7, pipH = 5, gap = 2;
      const total = MAX_HP * pipW + (MAX_HP - 1) * gap;
      const bx    = tank.x - total / 2;
      const by    = tank.y - TANK_SIZE / 2 - 9;

      const pipFull  = this._img('ui-hp-pip-full.png');
      const pipEmpty = this._img('ui-hp-pip-empty.png');

      for (let i = 0; i < MAX_HP; i++) {
        const x = bx + i * (pipW + gap);
        if (i < tank.hp) {
          if (pipFull) {
            ctx.drawImage(pipFull, x, by, pipW, pipH);
            // 残血（最后1格）叠红色蒙版
            if (tank.hp <= 1) {
              ctx.save();
              ctx.globalCompositeOperation = 'source-atop';
              ctx.fillStyle = 'rgb(233 79 55 / 75%)';
              ctx.fillRect(x, by, pipW, pipH);
              ctx.restore();
            }
          } else {
            ctx.fillStyle = tank.hp <= 1 ? '#e94f37' : '#44bba4';
            ctx.fillRect(x, by, pipW, pipH);
          }
        } else {
          if (pipEmpty) {
            ctx.drawImage(pipEmpty, x, by, pipW, pipH);
          } else {
            ctx.fillStyle   = 'rgb(0 0 0 / 55%)';
            ctx.fillRect(x, by, pipW, pipH);
            ctx.strokeStyle = 'rgb(216 220 214 / 30%)';
            ctx.lineWidth   = 1;
            ctx.strokeRect(x + 0.5, by + 0.5, pipW - 1, pipH - 1);
          }
        }
      }
    }

    ctx.font          = '10px "SF Mono", Menlo, monospace';
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'bottom';
    const label = tank.alive ? meta.nickname : `${meta.nickname} · 淘汰`;
    const y     = tank.y - TANK_SIZE / 2 - (tank.alive ? 12 : 8);
    ctx.strokeStyle = 'rgb(0 0 0 / 78%)';
    ctx.lineWidth   = 3;
    ctx.strokeText(label, tank.x, y);
    ctx.fillStyle   = tank.alive ? '#d8dcd6' : '#6b7266';
    ctx.fillText(label, tank.x, y);

    ctx.restore();
  }

  // ─── 子弹 ────────────────────────────────────────────────────────────────

  drawBullet(ctx, b) {
    const img = this._img('bullet.png');
    ctx.save();
    if (img) {
      const half = BULLET_SIZE / 2;
      ctx.drawImage(img, b.x - half, b.y - half, BULLET_SIZE, BULLET_SIZE);
    } else {
      const tint = b.color ?? PALETTE.bullet;
      ctx.shadowColor = tint;
      ctx.shadowBlur  = 8;
      ctx.fillStyle   = PALETTE.bullet;
      ctx.beginPath();
      ctx.arc(b.x, b.y, BULLET_SIZE / 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // ─── 特效 ────────────────────────────────────────────────────────────────

  drawEffects(ctx) {
    const now   = performance.now();
    const alive = [];

    for (const fx of this.effects) {
      const p = (now - fx.born) / fx.life;
      if (p >= 1) continue;
      alive.push(fx);

      const spriteCfg = FX_SPRITE[fx.type];

      // dust 无精灵表，始终几何绘制
      if (fx.type === 'dust') {
        ctx.save();
        ctx.globalAlpha = (1 - p) * 0.7;
        ctx.fillStyle   = '#b79878';
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          const d = p * 12;
          ctx.beginPath();
          ctx.arc(fx.x + Math.cos(a)*d, fx.y + Math.sin(a)*d, 2*(1-p)+0.5, 0, Math.PI*2);
          ctx.fill();
        }
        ctx.restore();
        continue;
      }

      if (spriteCfg) {
        const img = this._img(spriteCfg.file);
        if (img) {
          const frame   = Math.min(Math.floor(p * spriteCfg.frames), spriteCfg.frames - 1);
          const frameW  = img.width  / spriteCfg.frames; // 原始帧宽
          const frameH  = img.height;
          const drawSz  = 64; // 渲染到画布上的大小（每帧 64×64）
          ctx.save();
          ctx.globalAlpha = Math.max(0, 1 - p * 1.1);
          ctx.drawImage(
            img,
            frame * frameW, 0, frameW, frameH,          // 源帧
            fx.x - drawSz / 2, fy(fx) - drawSz / 2, drawSz, drawSz // 目标
          );
          ctx.restore();
          continue;
        }
      }

      // ── 几何回退 ──────────────────────────────────────────────────────
      ctx.save();
      this._drawFxGeo(ctx, fx, p);
      ctx.restore();
    }

    this.effects = alive;
  }

  _drawFxGeo(ctx, fx, p) {
    if (fx.type === 'spark') {
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle   = '#cfd6c4';
      const r = 2 + p * 5;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, r, 0, Math.PI*2); ctx.fill();
    } else if (fx.type === 'burst') {
      ctx.globalAlpha  = 1 - p;
      ctx.strokeStyle  = '#ffd98a';
      ctx.lineWidth    = 2;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, 4 + p*14, 0, Math.PI*2); ctx.stroke();
    } else if (fx.type === 'debris') {
      ctx.globalAlpha = 1 - p;
      ctx.fillStyle   = '#8a5a3c';
      for (let i = 0; i < 8; i++) {
        const a  = (i/8)*Math.PI*2 + 0.3;
        const d  = p * 26;
        const sz = 4*(1-p)+1;
        ctx.fillRect(fx.x+Math.cos(a)*d-sz/2, fx.y+Math.sin(a)*d-sz/2, sz, sz);
      }
    } else if (fx.type === 'ram') {
      ctx.globalAlpha  = 1 - p;
      ctx.strokeStyle  = '#ff6b4a';
      ctx.lineWidth    = 2.5*(1-p)+1;
      const r = 8 + p*18;
      ctx.beginPath();
      for (let i = 0; i < 4; i++) {
        const a = (i/4)*Math.PI*2 + Math.PI/4;
        ctx.moveTo(fx.x+Math.cos(a)*r*0.4, fx.y+Math.sin(a)*r*0.4);
        ctx.lineTo(fx.x+Math.cos(a)*r,     fx.y+Math.sin(a)*r);
      }
      ctx.stroke();
    } else if (fx.type === 'explosion') {
      ctx.globalAlpha  = (1-p)*0.9;
      ctx.strokeStyle  = '#ff8f4d';
      ctx.lineWidth    = 3*(1-p)+1;
      ctx.beginPath(); ctx.arc(fx.x, fx.y, 6+p*34, 0, Math.PI*2); ctx.stroke();
      ctx.globalAlpha  = (1-p)*0.55;
      ctx.strokeStyle  = '#ffe9b0';
      ctx.beginPath(); ctx.arc(fx.x, fx.y, 3+p*20, 0, Math.PI*2); ctx.stroke();
      ctx.globalAlpha  = Math.max(0, 1-p*2.4);
      ctx.fillStyle    = '#fff6df';
      ctx.beginPath(); ctx.arc(fx.x, fx.y, 9*(1-p), 0, Math.PI*2); ctx.fill();
    }
  }

  // ─── 倒计时 / 开始 ────────────────────────────────────────────────────────

  drawGo(ctx) {
    const p = 1 - (this.goUntil - performance.now()) / GO_TEXT_MS;
    ctx.save();
    ctx.translate(MAP_W/2, MAP_H/2);
    ctx.scale(1 + p*0.6, 1 + p*0.6);
    ctx.globalAlpha   = Math.max(0, 1 - p*1.2);
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.font          = 'bold 84px "SF Mono", Menlo, monospace';
    ctx.lineWidth     = 7;
    ctx.strokeStyle   = 'rgb(0 0 0 / 75%)';
    ctx.strokeText('开始！', 0, 0);
    ctx.fillStyle     = '#44bba4';
    ctx.fillText('开始！', 0, 0);
    ctx.restore();
  }

  drawCountdown(ctx, remainMs) {
    const sec  = Math.ceil(remainMs / 1000);
    const frac = 1 - ((remainMs % 1000) || 1000) / 1000;

    ctx.save();
    ctx.fillStyle = 'rgb(0 0 0 / 42%)';
    ctx.fillRect(0, 0, MAP_W, MAP_H);
    ctx.translate(MAP_W/2, MAP_H/2);
    const scale = 1.5 - frac*0.5;
    ctx.scale(scale, scale);
    ctx.textAlign     = 'center';
    ctx.textBaseline  = 'middle';
    ctx.font          = 'bold 110px "SF Mono", Menlo, monospace';
    ctx.globalAlpha   = 0.35 + (1-frac)*0.65;
    ctx.lineWidth     = 6;
    ctx.strokeStyle   = 'rgb(0 0 0 / 70%)';
    ctx.strokeText(String(sec), 0, 0);
    ctx.fillStyle     = '#f6ae2d';
    ctx.fillText(String(sec), 0, 0);
    ctx.globalAlpha   = 1;
    ctx.scale(1/scale, 1/scale);
    ctx.font          = '13px "SF Mono", Menlo, monospace';
    ctx.fillStyle     = '#d8dcd6';
    ctx.fillText('准备就绪', 0, 88);
    ctx.restore();
  }
}

/** drawImage 中的 y 坐标辅助（fx.y 与 fx 同名避免命名冲突） */
function fy(fx) { return fx.y; }
