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

/** 配色。与 CSS 变量保持一致，走军事仪表盘方向 */
const PALETTE = {
  ground: '#12150f',
  gridLine: '#1a1e16',
  bullet: '#ffe9b0',
  selfRing: '#ffffff',
  deadTank: '#2a2e26',
};

/**
 * 各类图块的绘制样式。
 *
 * ⚠️ S3 接入 AIGC 贴图时，只需把此表的 fill/edge 换成 sprite 字段，
 *    并在 drawTile 里改为 ctx.drawImage —— 不触碰任何其他代码。
 */
const TILE_STYLE = {
  [TILE_TYPE.BORDER]: {
    fill: '#5a5f52',
    edge: '#767c6a',
    // 边界用双层描边表现"厚重不可破坏"
    style: 'border',
  },
  [TILE_TYPE.BRICK]: {
    fill: '#8a5a3c',
    edge: '#a97148',
    // 砖墙画横向砌缝
    style: 'brick',
    // 破损程度 0 = 完好。用于叠加裂纹，让玩家能判断还需几发
    damage: 0,
  },
  [TILE_TYPE.BRICK_2]: {
    fill: '#7a4e33',
    edge: '#96633f',
    style: 'brick',
    damage: 1,
  },
  [TILE_TYPE.BRICK_1]: {
    fill: '#69422b',
    edge: '#835435',
    style: 'brick',
    damage: 2,
  },
  [TILE_TYPE.STEEL]: {
    fill: '#4a5560',
    edge: '#6b7a88',
    // 钢块画中心铆钉与斜切高光
    style: 'steel',
  },
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
     * 由 cd 从 >0 变为 0 的那一刻触发，纯表现层。
     */
    this.goUntil = 0;
    /** 上一帧的倒计时剩余，用于检测"倒计时刚结束"这一瞬间 */
    this.lastCd = 0;

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

  /**
   * 应用地图增量（砖墙被击破）。
   * 增量而非全量重发：地图约 600B，30Hz 下全量会让流量翻十倍。
   */
  applyMapPatches(patches) {
    if (!this.grid || !patches?.length) return;
    for (const p of patches) {
      if (this.grid[p.r]) this.grid[p.r][p.c] = p.v;
    }
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
      } else if (ev.kind === 'brick_break') {
        // 击破用碎块四散，仅扣耐久用小尘土，二者观感必须可区分
        this.effects.push({
          type: ev.broken ? 'debris' : 'dust',
          x: ev.x,
          y: ev.y,
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
    this.lastCd = 0;
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

    // 倒计时盖在最上层：玩家能看清战场与彼此位置，但明确知道还不能动
    const cd = snap?.cd ?? 0;
    if (cd > 0) {
      this.drawCountdown(ctx, cd);
    } else if (this.lastCd > 0) {
      // 倒计时刚归零 —— 触发"开始！"。
      // 用状态跳变而非某个固定秒数判断，丢帧也不会漏触发
      this.goUntil = performance.now() + GO_TEXT_MS;
    }
    this.lastCd = cd;

    if (performance.now() < this.goUntil) this.drawGo(ctx);
  }

  /**
   * 绘制「开始！」。
   * 放大淡出，与 3-2-1 的节奏衔接，明确告知玩家可以行动了。
   */
  drawGo(ctx) {
    const p = 1 - (this.goUntil - performance.now()) / GO_TEXT_MS;

    ctx.save();
    ctx.translate(MAP_W / 2, MAP_H / 2);
    ctx.scale(1 + p * 0.6, 1 + p * 0.6);
    ctx.globalAlpha = Math.max(0, 1 - p * 1.2);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 84px "SF Mono", Menlo, monospace';
    ctx.lineWidth = 7;
    ctx.strokeStyle = 'rgb(0 0 0 / 75%)';
    ctx.strokeText('开始！', 0, 0);
    ctx.fillStyle = '#44bba4';
    ctx.fillText('开始！', 0, 0);

    ctx.restore();
  }

  drawCountdown(ctx, remainMs) {
    const sec = Math.ceil(remainMs / 1000);
    const frac = 1 - ((remainMs % 1000) || 1000) / 1000;

    ctx.save();
    ctx.fillStyle = 'rgb(0 0 0 / 42%)';
    ctx.fillRect(0, 0, MAP_W, MAP_H);

    ctx.translate(MAP_W / 2, MAP_H / 2);
    const scale = 1.5 - frac * 0.5;
    ctx.scale(scale, scale);

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = 'bold 110px "SF Mono", Menlo, monospace';
    ctx.globalAlpha = 0.35 + (1 - frac) * 0.65;

    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgb(0 0 0 / 70%)';
    ctx.strokeText(String(sec), 0, 0);
    ctx.fillStyle = '#f6ae2d';
    ctx.fillText(String(sec), 0, 0);

    ctx.globalAlpha = 1;
    ctx.scale(1 / scale, 1 / scale);
    ctx.font = '13px "SF Mono", Menlo, monospace';
    ctx.fillStyle = '#d8dcd6';
    ctx.fillText('准备就绪', 0, 88);

    ctx.restore();
  }
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
      } else if (fx.type === 'dust') {
        ctx.globalAlpha = (1 - p) * 0.7;
        ctx.fillStyle = '#b79878';
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2;
          const d = p * 12;
          ctx.beginPath();
          ctx.arc(fx.x + Math.cos(a) * d, fx.y + Math.sin(a) * d, 2 * (1 - p) + 0.5, 0, Math.PI * 2);
          ctx.fill();
        }
      } else if (fx.type === 'debris') {
        // 碎块四散：8 个方向的小方块，明确表达"墙被打穿了"
        ctx.globalAlpha = 1 - p;
        ctx.fillStyle = '#8a5a3c';
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2 + 0.3;
          const d = p * 26;
          const sz = 4 * (1 - p) + 1;
          ctx.fillRect(fx.x + Math.cos(a) * d - sz / 2, fx.y + Math.sin(a) * d - sz / 2, sz, sz);
        }
      } else if (fx.type === 'ram') {
        // 相撞用交叉冲击线，与子弹命中的圆环区分开
        ctx.globalAlpha = 1 - p;
        ctx.strokeStyle = '#ff6b4a';
        ctx.lineWidth = 2.5 * (1 - p) + 1;
        const r = 8 + p * 18;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
          ctx.moveTo(fx.x + Math.cos(a) * r * 0.4, fx.y + Math.sin(a) * r * 0.4);
          ctx.lineTo(fx.x + Math.cos(a) * r, fx.y + Math.sin(a) * r);
        }
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
        const tile = row[c];
        if (tile === TILE_TYPE.EMPTY) continue;
        this.drawTile(ctx, tile, c * TILE, r * TILE);
      }
    }
  }

  /**
   * 绘制单个图块。
   * 三类图块视觉差异明确，玩家能一眼分辨边界与内部障碍。
   *
   * S3 替换素材时只需把此函数体换成 ctx.drawImage(sprite, x, y, TILE, TILE)。
   */
  drawTile(ctx, tile, x, y) {
    const s = TILE_STYLE[tile];
    if (!s) return;

    ctx.fillStyle = s.fill;
    ctx.fillRect(x, y, TILE, TILE);

    ctx.strokeStyle = s.edge;
    ctx.lineWidth = 1;

    if (s.style === 'border') {
      // 双层描边 + 对角斜线，表现不可破坏的钢结构边界
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      ctx.strokeRect(x + 4.5, y + 4.5, TILE - 9, TILE - 9);
    } else if (s.style === 'brick') {
      // 横向砌缝，错位排列
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        const ly = y + (TILE / 4) * i;
        ctx.moveTo(x, ly + 0.5);
        ctx.lineTo(x + TILE, ly + 0.5);
      }
      // 竖缝逐行错开半砖
      for (let i = 0; i < 4; i++) {
        const ly = y + (TILE / 4) * i;
        const lx = x + (i % 2 === 0 ? TILE / 2 : TILE / 4);
        ctx.moveTo(lx + 0.5, ly);
        ctx.lineTo(lx + 0.5, ly + TILE / 4);
      }
      ctx.stroke();

      // 破损裂纹：按 damage 叠加，让玩家能判断还需几发
      if (s.damage > 0) {
        ctx.strokeStyle = 'rgb(0 0 0 / 55%)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(x + 6, y + 4);
        ctx.lineTo(x + 14, y + 16);
        ctx.lineTo(x + 9, y + 27);
        if (s.damage > 1) {
          ctx.moveTo(x + TILE - 5, y + 7);
          ctx.lineTo(x + TILE - 15, y + 18);
          ctx.lineTo(x + TILE - 8, y + TILE - 4);
        }
        ctx.stroke();
      }
    } else if (s.style === 'steel') {
      // 四角铆钉 + 中心高光块，质感区别于砖墙
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
      ctx.fillStyle = s.edge;
      const p = 5;
      const rr = 2;
      for (const [dx, dy] of [
        [p, p],
        [TILE - p, p],
        [p, TILE - p],
        [TILE - p, TILE - p],
      ]) {
        ctx.beginPath();
        ctx.arc(x + dx, y + dy, rr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = 'rgb(255 255 255 / 8%)';
      ctx.fillRect(x + TILE / 2 - 5, y + TILE / 2 - 5, 10, 10);
    }
  }

  drawTank(ctx, tank) {
    const meta = this.playerMeta.get(tank.id);
    const flashUntil = this.flash.get(tank.id) ?? 0;
    const isFlashing = performance.now() < flashUntil;

    let color = tank.alive ? (meta?.color ?? '#888') : PALETTE.deadTank;
    // 命中瞬间整车闪白，是最直接的受击反馈
    if (isFlashing && tank.alive) color = '#ffffff';

    // ⭐ 车体用 TANK_BODY（小于碰撞盒 TANK_SIZE），空出的部分给炮筒，
    //    使「车体 + 炮筒」的视觉总长恰好等于碰撞盒 ——
    //    从此不会再出现"炮筒插进墙里"的观感问题。
    const bodyHalf = TANK_BODY / 2;

    ctx.save();
    ctx.translate(tank.x, tank.y);

    // 无敌期闪烁：用时间驱动的透明度，让玩家明确知道处于保护状态
    if (tank.inv) {
      ctx.globalAlpha = 0.4 + 0.35 * Math.sin(Date.now() / 90);
    }

    // 炮管先画，让车体覆盖其根部，视觉上更像一体
    const vec = DIR_VEC[tank.dir] ?? DIR_VEC.up;
    ctx.strokeStyle = color;
    ctx.lineWidth = 5;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(vec.x * (bodyHalf + BARREL_LEN), vec.y * (bodyHalf + BARREL_LEN));
    ctx.stroke();

    // 车体
    ctx.fillStyle = color;
    ctx.fillRect(-bodyHalf, -bodyHalf, TANK_BODY, TANK_BODY);

    // 履带：两侧深色条带，提示这是载具而非方块
    ctx.fillStyle = 'rgb(0 0 0 / 32%)';
    if (vec.x !== 0) {
      ctx.fillRect(-bodyHalf, -bodyHalf, TANK_BODY, 3);
      ctx.fillRect(-bodyHalf, bodyHalf - 3, TANK_BODY, 3);
    } else {
      ctx.fillRect(-bodyHalf, -bodyHalf, 3, TANK_BODY);
      ctx.fillRect(bodyHalf - 3, -bodyHalf, 3, TANK_BODY);
    }

    // 自己的坦克加白色描边环，避免在同色系里找不到自己。
    // 描边尺寸即碰撞盒，顺便让玩家直观看到自己的实际体积
    if (tank.id === this.selfId) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = PALETTE.selfRing;
      ctx.lineWidth = 1;
      const h = TANK_SIZE / 2;
      ctx.strokeRect(-h - 0.5, -h - 0.5, TANK_SIZE + 1, TANK_SIZE + 1);
    }

    ctx.restore();

    // 昵称与血量画在坦克上方，不受 alpha 影响
    if (meta) this.drawNameplate(ctx, tank, meta);
  }

  drawNameplate(ctx, tank, meta) {
    ctx.save();

    // ---- 血条 ----
    // 画在坦克上方：对战时玩家视线锁在战场，顶部 HUD 需要移开目光才能看，
    // 而血量是最高频、最关键的信息，必须就近呈现。
    if (tank.alive) {
      const pipW = 7;
      const pipH = 5;
      const gap = 2;
      const total = MAX_HP * pipW + (MAX_HP - 1) * gap;
      const bx = tank.x - total / 2;
      const by = tank.y - TANK_SIZE / 2 - 9;

      for (let i = 0; i < MAX_HP; i++) {
        const x = bx + i * (pipW + gap);
        if (i < tank.hp) {
          // 残血转红，与 HUD 的配色规则一致，避免两处语义冲突
          ctx.fillStyle = tank.hp <= 1 ? '#e94f37' : '#44bba4';
          ctx.fillRect(x, by, pipW, pipH);
        } else {
          ctx.fillStyle = 'rgb(0 0 0 / 55%)';
          ctx.fillRect(x, by, pipW, pipH);
          ctx.strokeStyle = 'rgb(216 220 214 / 30%)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x + 0.5, by + 0.5, pipW - 1, pipH - 1);
        }
      }
    }

    // ---- 昵称 ----
    ctx.font = '10px "SF Mono", Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';

    const label = tank.alive ? meta.nickname : `${meta.nickname} · 淘汰`;
    const y = tank.y - TANK_SIZE / 2 - (tank.alive ? 12 : 8);

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
