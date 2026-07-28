/**
 * 单个房间
 *
 * 持有该房间的**全部权威状态**，所有规则判定发生在此。
 * 客户端只上报操作意图，接收广播结果。
 *
 * 下行消息分三类，职责不重叠：
 *   - room     房间元信息，仅在玩家/阶段变更时发
 *   - snapshot 幂等世界状态，30Hz，丢帧无害
 *   - event    一次性瞬时信号（命中/击杀/进出房），驱动特效与战报
 */

import {
  BULLET_SPEED,
  COLORS,
  COUNTDOWN_MS,
  END_REASON,
  FIRE_COOLDOWN_MS,
  MATCH_DURATION_MS,
  MAX_HP,
  PHASE,
  RAM_COOLDOWN_MS,
  RAM_DAMAGE,
  RESPAWN_INVULN_MS,
  ROOM_MAX,
  ROOM_MIN,
  MAP_W,
  TANK_SPEED,
  TICK_MS,
  TILE,
} from '../shared/constants.js';
import { S2C, EVENT_KIND, encode } from '../shared/protocol.js';
import { logger } from './logger.js';
import {
  createMap,
  damageTile,
  generateSpawnPoints,
  getFallbackSpawnPoints,
  isDestructible,
  validateMap,
} from './map.js';
import {
  advanceBullet,
  bulletSpawnPos,
  findBulletHit,
  findTankCollisions,
  tryMoveTank,
} from './physics.js';

let playerSeq = 0;
let bulletSeq = 0;

export class Room {
  /**
   * @param {string} id 房间号
   * @param {(room: Room) => void} onEmpty 房间空置回调，由 RoomManager 负责销毁
   */
  constructor(id, onEmpty) {
    this.id = id;
    this.onEmpty = onEmpty;
    this.phase = PHASE.WAITING;
    /** @type {Map<string, object>} playerId → player */
    this.players = new Map();
    /** 房主 playerId。房主退出后自动移交给最早加入的玩家 */
    this.hostId = null;
    this.createdAt = Date.now();

    // ---- 世界状态 ----
    /**
     * 地图每局随机生成。构造时先生成一张，供等待区玩家预览。
     * @type {number[][]}
     */
    this.grid = createMap();
    /** 本局出生点，每局随机生成 */
    this.spawns = getFallbackSpawnPoints();
    /** @type {Array<object>} 活跃子弹 */
    this.bullets = [];
    /**
     * 本帧累积的表现层事件（命中、击殺、复活）。
     * 与快照分开下发：快照是幂等状态，事件是一次性瞬时信号，
     * 客户端靠它触发特效，丢帧时不会影响状态正确性。
     * @type {Array<object>}
     */
    this.pendingEvents = [];
    /**
     * 递增帧号，客户端据此丢弃乱序到达的旧快照。
     *
     * ⚠️ **在房间生命周期内单调递增，开新局也不重置**。
     * 曾因在 startGame 里重置为 0 而引入严重 bug：
     * 上局跑到 t=650 后开新局，新局从 t=1 开始，
     * 客户端的防乱序判断（t < 上一帧则丢弃）会把新局前 650 帧全部丢掉，
     * 表现为“点了再来一局要等很久才开始”，且等待时长≈上局时长。
     */
    this.tick = 0;
    /** 对局序号。每开一局 +1，客户端据此识别“换局”并重置本地帧号基准 */
    this.matchId = 0;
    this.startedAt = 0;
    /** 倒计时结束时间戳。0 表示不在倒计时 */
    this.countdownUntil = 0;
    /** 上一次广播的倒计时秒数，避免重复推送同一秒 */
    this.lastCountdownSec = 0;
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** 上一帧时间戳，用于计算真实 dt */
    this.lastTickAt = 0;
    /**
     * 尚未收到地图的玩家。地图约 600B，只在玩家首帧下发一次，
     * 每帧都带会让流量翻约 10 倍。
     * @type {Set<string>}
     */
    this.needMap = new Set();
    /**
     * 本帧发生变更的地图格。砖墙被击破后需增量下发，
     * 全量重发地图（约 600B）在 30Hz 下会让流量翻十倍。
     * @type {Array<{c:number,r:number,v:number}>}
     */
    this.mapPatches = [];

    // 地图设计错误必须在启动阶段暴露，而非对战中途才发现坦克卡在墙里
    const problems = validateMap(this.grid);
    if (problems.length) {
      logger.error({ evt: 'map_invalid', roomId: id, problems });
    }
  }

  get size() {
    return this.players.size;
  }

  get isFull() {
    return this.players.size >= ROOM_MAX;
  }

  get canStart() {
    return this.players.size >= ROOM_MIN;
  }

  /**
   * 分配空闲颜色槽位。
   * 用"找最小未占用索引"而非按 size 递增，
   * 否则玩家中途退出再进会出现两人同色。
   */
  allocSlot() {
    const used = new Set([...this.players.values()].map((p) => p.slot));
    for (let i = 0; i < ROOM_MAX; i++) {
      if (!used.has(i)) return i;
    }
    return -1;
  }

  /**
   * 加入房间。调用方需先确保未满。
   * @returns {object} player
   */
  addPlayer(ws, nickname) {
    const slot = this.allocSlot();
    const spawn = this.spawns[slot];

    const player = {
      id: `p${++playerSeq}`,
      nickname,
      slot,
      color: COLORS[slot],
      ws,
      joinedAt: Date.now(),

      // ---- 坦克状态（权威） ----
      x: spawn.x,
      y: spawn.y,
      /** 炮管朝向，即使停止移动也保留 */
      dir: slot < 2 ? 'down' : 'up',
      /** 当前移动意图，null 表示停止 */
      moveDir: null,
      hp: MAX_HP,
      alive: false,
      invulnUntil: 0,
      lastFireAt: 0,
      kills: 0,
      deaths: 0,
    };

    this.players.set(player.id, player);
    this.needMap.add(player.id);
    // 首个加入者成为房主
    if (!this.hostId) this.hostId = player.id;

    logger.info({
      evt: 'player_join',
      roomId: this.id,
      playerId: player.id,
      nickname,
      slot,
      size: this.size,
    });

    // 战报：先广播给已在房间的玩家（此时新玩家已在 players 中，也会收到）
    this.pushEvent({ kind: EVENT_KIND.JOIN, actor: nickname, color: player.color });
    this.flushEvents();

    return player;
  }

  /**
   * 移除玩家。处理房主移交与房间空置。
   * @param {string} playerId
   * @param {string} reason 'leave' | 'disconnect'
   */
  removePlayer(playerId, reason) {
    const player = this.players.get(playerId);
    if (!player) return;

    this.players.delete(playerId);
    this.needMap.delete(playerId);
    // 离开者遗留的子弹必须清除，否则会出现“幽灵子弹”继续伤害其他人
    this.bullets = this.bullets.filter((b) => b.ownerId !== playerId);

    logger.info({
      evt: 'player_leave',
      roomId: this.id,
      playerId,
      nickname: player.nickname,
      reason,
      size: this.size,
    });

    this.pushEvent({
      kind: EVENT_KIND.LEAVE,
      actor: player.nickname,
      color: player.color,
      reason,
    });

    // 房主离开则移交给最早加入者，避免房间失去控制权无法开局
    if (this.hostId === playerId) {
      const next = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostId = next?.id ?? null;
      if (next) {
        logger.info({ evt: 'host_transfer', roomId: this.id, playerId: next.id });
        this.pushEvent({ kind: EVENT_KIND.HOST, actor: next.nickname, color: next.color });
      }
    }

    if (this.players.size === 0) {
      this.stopLoop();
      this.onEmpty(this);
      return;
    }

    this.flushEvents();
    this.broadcastRoom();

    // 玩家退出可能直接触发对局结束（仅剩 1 人 → 胜利；不足 2 人 → 中止）。
    // 不处理会导致对手退出后另一方永远卡在战场里。
    if (this.phase === PHASE.PLAYING || this.phase === PHASE.COUNTDOWN) {
      this.checkEnd(Date.now());
    }
  }

  // ---------------- 对局生命周期 ----------------

  /** 开局：重新生成地图与出生点，进入倒计时阶段 */
  startGame() {
    // 先进入倒计时：玩家可见地图与彼此位置，但不能操作
    this.phase = PHASE.COUNTDOWN;
    // 注意：故意不重置 this.tick（原因见 constructor 中的说明），
    // 换局靠 matchId 辨识
    this.matchId++;
    const now = Date.now();
    this.countdownUntil = now + COUNTDOWN_MS;
    this.lastCountdownSec = 0;
    // startedAt 指向倒计时结束时刻，使对局时限不包含倒计时
    this.startedAt = this.countdownUntil;
    this.bullets = [];
    this.pendingEvents = [];
    this.mapPatches = [];
    this.result = null;

    // 每局重新生成地图，提升重复对战的新鲜感
    this.grid = createMap();
    // 出生点也每局随机，但保证彼此间距 ≥ MIN_SPAWN_DISTANCE
    this.spawns = generateSpawnPoints(this.grid, ROOM_MAX);

    const problems = validateMap(this.grid, this.spawns);
    if (problems.length) {
      logger.error({ evt: 'map_invalid', roomId: this.id, problems });
    }

    // 随机洗牌出生点分配，避免固定 slot 总得到同一位置
    const shuffled = [...this.spawns];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    let idx = 0;
    for (const p of this.players.values()) {
      const spawn = shuffled[idx++ % shuffled.length];
      p.x = spawn.x;
      p.y = spawn.y;
      // 服向改为指向地图中心，无论出生在哪都面向战场
      p.dir = spawn.x < MAP_W / 2 ? 'right' : 'left';
      p.moveDir = null;
      p.hp = MAX_HP;
      p.alive = true;
      p.invulnUntil = this.startedAt + RESPAWN_INVULN_MS;
      p.lastFireAt = 0;
      p.lastRamAt = 0;
      p.kills = 0;
      p.deaths = 0;
      // 地图每局重新生成，必须重新下发给所有玩家
      this.needMap.add(p.id);
    }

    logger.info({ evt: 'game_start', roomId: this.id, size: this.size, matchId: this.matchId });
    this.pushEvent({ kind: EVENT_KIND.START });
    this.flushEvents();
    this.broadcastRoom();
    this.startLoop();
  }

  startLoop() {
    this.stopLoop();
    this.lastTickAt = Date.now();
    this.timer = setInterval(() => {
      // tick 内任何异常都不得让定时器带着崩溃状态继续跑
      try {
        this.step();
      } catch (err) {
        logger.error({ evt: 'tick_error', roomId: this.id, err: err.message, stack: err.stack });
        this.stopLoop();
      }
    }, TICK_MS);
  }

  stopLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 推进一帧。
   *
   * ⚠️ 用**真实 dt** 而非假设固定 TICK_MS：
   *    setInterval 必然漂移（GC、主线程繁忙），写死 33ms 会让不同机器、
   *    不同负载下的坦克速度出现可观测差异。
   */
  step() {
    const now = Date.now();
    let dt = (now - this.lastTickAt) / 1000;
    this.lastTickAt = now;

    // 夹紧 dt：进程被挂起（如笔记本合盖）后恢复，dt 可能高达数秒，
    // 会让坦克瞬移穿过整张地图。上限取 3 帧时长。
    dt = Math.min(dt, (TICK_MS * 3) / 1000);

    this.tick++;

    const tanks = [...this.players.values()];

    // ---- 0. 倒计时阶段：只广播画面，不推进任何游戏逻辑 ----
    if (this.phase === PHASE.COUNTDOWN) {
      this.stepCountdown(now);
      this.broadcastSnapshot(now);
      this.flushEvents();
      return;
    }

    // ---- 1. 移动 ----
    for (const tank of tanks) {
      if (!tank.alive || !tank.moveDir) continue;

      const others = tanks.filter((t) => t.id !== tank.id);
      const next = tryMoveTank(tank, tank.moveDir, dt, TANK_SPEED, this.grid, others);
      tank.x = next.x;
      tank.y = next.y;
    }

    // ---- 2. 坦克相撞伤害 ----
    // 放在移动之后：此时位置已是本帧最终值，判定不会与移动结果矛盾
    this.stepRamDamage(tanks, now);

    // ---- 3. 子弹推进与命中 ----
    this.stepBullets(dt, tanks, now);

    // ---- 4. 结束判定 ----
    // 必须在广播快照前执行：若本帧产生胜负，应直接走 endGame 的广播路径，
    // 避免先发一帧普通快照再发 over，造成客户端状态跳变
    if (this.checkEnd(now)) return;

    this.broadcastSnapshot(now);
    this.flushEvents();
  }

  /**
   * 推进倒计时。到点后切入 PLAYING。
   *
   * 读秒事件只在秒数变化时下发一次，避免 30Hz 刷屏。
   */
  stepCountdown(now) {
    const remainMs = this.countdownUntil - now;

    if (remainMs <= 0) {
      this.phase = PHASE.PLAYING;
      this.countdownUntil = 0;
      // 倒计时期间累积的移动意图必须清空，
      // 否则提前按住方向键的玩家会在开局瞬间抢跑
      for (const p of this.players.values()) p.moveDir = null;

      this.pushEvent({ kind: EVENT_KIND.COUNTDOWN, n: 0 });
      this.broadcastRoom();
      logger.info({ evt: 'countdown_end', roomId: this.id, matchId: this.matchId });
      return;
    }

    const sec = Math.ceil(remainMs / 1000);
    if (sec !== this.lastCountdownSec) {
      this.lastCountdownSec = sec;
      this.pushEvent({ kind: EVENT_KIND.COUNTDOWN, n: sec });
    }
  }

  /**
   * 坦克相撞造成双向伤害。
   *
   * ⚠️ 冷却是必需的：两车贴在一起时每帧都满足碰撞条件，
   *    无冷却会在 30Hz 下不到一秒扣光双方全部血量。
   *    冷却按**每辆车独立**计时，避免一方刚被撞完又立刻被另一车追撞。
   */
  stepRamDamage(tanks, now) {
    for (const [a, b] of findTankCollisions(tanks)) {
      // 无敌期内不受相撞伤害，与子弹规则保持一致
      const aProtected = now < a.invulnUntil || now - a.lastRamAt < RAM_COOLDOWN_MS;
      const bProtected = now < b.invulnUntil || now - b.lastRamAt < RAM_COOLDOWN_MS;
      if (aProtected && bProtected) continue;

      const x = Math.round((a.x + b.x) / 2);
      const y = Math.round((a.y + b.y) / 2);
      this.pushEvent({ kind: EVENT_KIND.RAM, x, y, actor: a.nickname, target: b.nickname });

      // 双方同时扣血，撞人者不占便宜 —— 否则会演变成"互相撞死"的下水道玩法
      if (!aProtected) this.applyRamDamage(a, b, now, x, y);
      if (!bProtected) this.applyRamDamage(b, a, now, x, y);
    }
  }

  /** 结算一次相撞伤害。attacker 仅用于战报归属，不计击杀 */
  applyRamDamage(victim, other, now, x, y) {
    victim.lastRamAt = now;
    victim.hp = Math.max(0, victim.hp - RAM_DAMAGE);

    this.pushEvent({
      kind: EVENT_KIND.HIT,
      x,
      y,
      targetId: victim.id,
      target: victim.nickname,
      actor: other.nickname,
      color: other.color,
      hp: victim.hp,
      ram: 1,
    });

    logger.info({
      evt: 'ram_hit',
      roomId: this.id,
      victimId: victim.id,
      otherId: other.id,
      hp: victim.hp,
    });

    if (victim.hp > 0) return;

    victim.alive = false;
    victim.moveDir = null;
    victim.deaths++;
    // 相撞致死不计对方击杀数：这不是主动击杀，计入会鼓励自杀式撞击

    this.pushEvent({
      kind: EVENT_KIND.KILL,
      x: Math.round(victim.x),
      y: Math.round(victim.y),
      targetId: victim.id,
      target: victim.nickname,
      actor: other.nickname,
      color: other.color,
      ram: 1,
    });
  }

  /** 推进所有子弹，处理撞墙与命中 */
  stepBullets(dt, tanks, now) {
    const survived = [];

    for (const bullet of this.bullets) {
      const next = advanceBullet(bullet, dt, BULLET_SPEED, this.grid);
      bullet.x = next.x;
      bullet.y = next.y;

      if (next.hitWall) {
        // 砖墙可被击破：扣耐久，归零则变空地
        let broken = false;
        let brickHp = null;
        if (next.col !== undefined && isDestructible(this.grid[next.row]?.[next.col])) {
          const r = damageTile(this.grid, next.col, next.row);
          broken = r.broken;
          brickHp = r.hp;
          // 地图已变更，必须让客户端知道，否则会看到子弹穿过"已消失"的墙
          this.mapPatches.push({ c: next.col, r: next.row, v: this.grid[next.row][next.col] });

          this.pushEvent({
            kind: EVENT_KIND.BRICK_BREAK,
            x: next.col * TILE + TILE / 2,
            y: next.row * TILE + TILE / 2,
            hp: brickHp,
            broken: broken ? 1 : 0,
          });
        }

        // 撞墙也给反馈，否则玩家不知道子弹打到哪了
        this.pushEvent({
          kind: EVENT_KIND.HIT,
          x: Math.round(bullet.x),
          y: Math.round(bullet.y),
          wall: 1,
        });
        continue;
      }

      const victim = findBulletHit(bullet, tanks, now);
      if (!victim) {
        survived.push(bullet);
        continue;
      }

      this.applyDamage(victim, bullet);
      // 命中后子弹消失，不穿透
    }

    this.bullets = survived;
  }

  /**
   * 结算一次命中。
   * 这是**唯一**修改 hp 的地方，便于审计与排查。
   */
  applyDamage(victim, bullet) {
    const attacker = this.players.get(bullet.ownerId);
    victim.hp = Math.max(0, victim.hp - 1);

    this.pushEvent({
      kind: EVENT_KIND.HIT,
      x: Math.round(bullet.x),
      y: Math.round(bullet.y),
      targetId: victim.id,
      target: victim.nickname,
      actor: attacker?.nickname ?? '未知',
      color: attacker?.color,
      hp: victim.hp,
    });

    logger.info({
      evt: 'hit',
      roomId: this.id,
      attackerId: bullet.ownerId,
      victimId: victim.id,
      hp: victim.hp,
    });

    if (victim.hp > 0) return;

    // ---- 淘汰 ----
    victim.alive = false;
    victim.moveDir = null;
    victim.deaths++;
    if (attacker && attacker.id !== victim.id) attacker.kills++;

    this.pushEvent({
      kind: EVENT_KIND.KILL,
      x: Math.round(victim.x),
      y: Math.round(victim.y),
      targetId: victim.id,
      target: victim.nickname,
      actor: attacker?.nickname ?? '未知',
      color: attacker?.color,
    });

    logger.info({ evt: 'kill', roomId: this.id, attackerId: bullet.ownerId, victimId: victim.id });
  }

  /**
   * 检查对局是否结束。
   *
   * 三条规则（对应 PRD F-2.8），**只在服务端判定一次**，
   * over 消息是所有客户端胜负显示的唯一来源。
   *
   * @returns {boolean} 是否已结束
   */
  checkEnd(now) {
    // 倒计时阶段也需判定：此时若有人退出导致不足 2 人，
    // 应立即中止而非等倒计时走完再开一局空对局
    if (this.phase !== PHASE.PLAYING && this.phase !== PHASE.COUNTDOWN) return false;

    const all = [...this.players.values()];
    const alive = all.filter((p) => p.alive);

    // 规则 3：人数不足 → 中止。
    // 但若剩下的唯一玩家还活着，应判他胜利而非中止 ——
    // 否则"对手中途退出"会让胜者得不到任何反馈，永远卡在战场里。
    if (all.length < ROOM_MIN) {
      if (all.length === 1 && alive.length === 1) {
        this.endGame(alive[0], END_REASON.LAST_SURVIVOR, now);
      } else {
        this.endGame(null, END_REASON.ABORTED, now);
      }
      return true;
    }

    // 规则 1：仅剩 1 名存活玩家 → 该玩家胜
    if (alive.length <= 1) {
      this.endGame(alive[0] ?? null, END_REASON.LAST_SURVIVOR, now);
      return true;
    }

    // 规则 2：时限到 → 剩余生命值高者胜，相同则平局
    if (now - this.startedAt >= MATCH_DURATION_MS) {
      const maxHp = Math.max(...alive.map((p) => p.hp));
      const top = alive.filter((p) => p.hp === maxHp);
      this.endGame(top.length === 1 ? top[0] : null, END_REASON.TIMEOUT, now);
      return true;
    }

    return false;
  }

  /** 结算并广播。winner 为 null 表示平局或中止 */
  endGame(winner, reason, now = Date.now()) {
    this.phase = PHASE.OVER;
    this.stopLoop();
    this.bullets = [];

    for (const p of this.players.values()) p.moveDir = null;

    this.result = {
      winnerId: winner?.id ?? null,
      winnerName: winner?.nickname ?? null,
      reason,
      durationMs: Math.max(0, now - this.startedAt),
      scores: [...this.players.values()]
        .map((p) => ({
          id: p.id,
          nickname: p.nickname,
          color: p.color,
          hp: p.hp,
          kills: p.kills,
          deaths: p.deaths,
          alive: p.alive,
        }))
        // 击杀降序，其次剩余血量降序，便于直接作为排名展示
        .sort((a, b) => b.kills - a.kills || b.hp - a.hp),
    };

    logger.info({
      evt: 'game_over',
      roomId: this.id,
      winnerId: this.result.winnerId,
      reason,
      durationSec: Math.floor(this.result.durationMs / 1000),
    });

    // 顺序有意为之：先把本帧的 hit/kill 事件与最终快照发出，再发 over。
    // 否则客户端会先弹结算面板、后播击杀特效，观感错乱
    this.flushEvents();
    this.broadcastSnapshot(now);
    this.broadcast(S2C.OVER, this.result);
    this.broadcastRoom();
  }

  // ---------------- 意图处理 ----------------

  /**
   * 设置移动意图。
   * 同时更新炮管朝向 —— 即使因撞墙无法移动，朝向也应改变，
   * 否则贴墙时无法调整射击方向。
   */
  setMoveIntent(player, dir) {
    // 倒计时期间禁止移动：此时 phase 为 COUNTDOWN 而非 PLAYING，
    // 天然被此判断拦下，无需额外分支
    if (this.phase !== PHASE.PLAYING || !player.alive) return;
    player.moveDir = dir;
    if (dir) player.dir = dir;
  }

  /** 处理射击意图。冷却完全由服务端裁决，客户端只需无脑上报 */
  fire(player) {
    // 同 setMoveIntent：倒计时阶段 phase 不是 PLAYING，开火自动无效
    if (this.phase !== PHASE.PLAYING || !player.alive) return;

    const now = Date.now();
    if (now - player.lastFireAt < FIRE_COOLDOWN_MS) return;
    player.lastFireAt = now;

    const pos = bulletSpawnPos(player);

    this.bullets.push({
      id: `b${++bulletSeq}`,
      ownerId: player.id,
      x: pos.x,
      y: pos.y,
      dir: player.dir,
      color: player.color,
    });

    this.pushEvent({
      kind: EVENT_KIND.FIRE,
      actorId: player.id,
      x: Math.round(pos.x),
      y: Math.round(pos.y),
      dir: player.dir,
    });
  }

  // ---------------- 事件队列 ----------------

  /** 累积一个表现层事件，随下一次 flush 一并下发 */
  pushEvent(ev) {
    this.pendingEvents.push({ ...ev, t: this.tick });
  }

  /**
   * 下发并清空事件队列。
   * 合并为单条消息：一帧内可能同时产生多个 hit/kill，
   * 逐条发送会成倍增加消息数。
   */
  flushEvents() {
    if (this.pendingEvents.length === 0) return;
    const events = this.pendingEvents;
    this.pendingEvents = [];
    this.broadcast(S2C.EVENT, { events });
  }

  // ---------------- 序列化与广播 ----------------

  /** 房间元信息，用于下行 room 消息 */
  serialize() {
    return {
      roomId: this.id,
      phase: this.phase,
      hostId: this.hostId,
      minPlayers: ROOM_MIN,
      maxPlayers: ROOM_MAX,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        nickname: p.nickname,
        slot: p.slot,
        color: p.color,
        hp: p.hp,
        alive: p.alive,
        kills: p.kills,
      })),
    };
  }

  /**
   * 世界快照。
   * 坐标取整到整数像素：减少约 40% 的 JSON 体积，
   * 且 1px 误差在视觉上不可辨。
   */
  snapshot(now) {
    return {
      t: this.tick,
      m: this.matchId,
      timeLeft: Math.max(0, MATCH_DURATION_MS - (now - this.startedAt)),
      tanks: [...this.players.values()].map((p) => ({
        id: p.id,
        x: Math.round(p.x),
        y: Math.round(p.y),
        dir: p.dir,
        hp: p.hp,
        alive: p.alive,
        // 仅在无敌期内下发，避免每帧传递无意义字段
        inv: now < p.invulnUntil ? 1 : 0,
      })),
      bullets: this.bullets.map((b) => ({
        id: b.id,
        x: Math.round(b.x),
        y: Math.round(b.y),
        color: b.color,
      })),
      // 倒计时剩余毫秒。>0 表示尚未开打，客户端据此显示 3-2-1 并禁用操作提示
      cd: this.countdownUntil > 0 ? Math.max(0, this.countdownUntil - now) : 0,
    };
  }

  /** 向房间内所有玩家广播 */
  broadcast(type, data) {
    const payload = encode(type, data);
    for (const player of this.players.values()) {
      // 单个连接发送失败不应影响其他玩家
      try {
        player.ws.send(payload);
      } catch (err) {
        logger.warn({
          evt: 'broadcast_failed',
          roomId: this.id,
          playerId: player.id,
          err: err.message,
        });
      }
    }
  }

  /**
   * 广播快照。
   * 首次收到快照的客户端额外附带地图，其余玩家复用同一份序列化结果。
   */
  broadcastSnapshot(now = Date.now()) {
    const base = this.snapshot(now);
    // 地图增量：本帧被击破的砖墙。收到全量地图的玩家无需再收增量
    if (this.mapPatches.length) base.mp = this.mapPatches;
    const shared = this.needMap.size < this.players.size ? encode(S2C.SNAPSHOT, base) : null;

    for (const player of this.players.values()) {
      try {
        if (this.needMap.has(player.id)) {
          player.ws.send(encode(S2C.SNAPSHOT, { ...base, map: this.grid }));
          this.needMap.delete(player.id);
        } else {
          player.ws.send(shared ?? encode(S2C.SNAPSHOT, base));
        }
      } catch (err) {
        logger.warn({
          evt: 'snapshot_failed',
          roomId: this.id,
          playerId: player.id,
          err: err.message,
        });
      }
    }

    // 增量已下发，清空。必须在此处而非 step 末尾 ——
    // endGame 也会调用 broadcastSnapshot，遗漏会导致重复下发
    if (this.mapPatches.length) this.mapPatches = [];
  }

  broadcastRoom() {
    this.broadcast(S2C.ROOM, this.serialize());
  }

  /** 释放资源 */
  dispose() {
    this.stopLoop();
    logger.info({
      evt: 'room_dispose',
      roomId: this.id,
      lifetimeSec: Math.floor((Date.now() - this.createdAt) / 1000),
    });
  }
}
