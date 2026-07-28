/**
 * 单个房间
 *
 * 持有该房间的**全部权威状态**，所有规则判定发生在此。
 * 客户端只上报操作意图，接收广播结果。
 *
 * S1.3 阶段实现移动同步；射击与战斗结算在 S1.4 接入。
 */

import {
  COLORS,
  MATCH_DURATION_MS,
  MAX_HP,
  PHASE,
  RESPAWN_INVULN_MS,
  ROOM_MAX,
  ROOM_MIN,
  TANK_SPEED,
  TICK_MS,
} from '../shared/constants.js';
import { S2C, encode } from '../shared/protocol.js';
import { logger } from './logger.js';
import { createMap, getSpawnPoints, validateMap } from './map.js';
import { tryMoveTank } from './physics.js';

let playerSeq = 0;

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
    this.grid = createMap();
    this.spawns = getSpawnPoints();
    /** 递增帧号，客户端可据此丢弃乱序到达的旧快照 */
    this.tick = 0;
    this.startedAt = 0;
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

    logger.info({
      evt: 'player_leave',
      roomId: this.id,
      playerId,
      nickname: player.nickname,
      reason,
      size: this.size,
    });

    // 房主离开则移交给最早加入者，避免房间失去控制权无法开局
    if (this.hostId === playerId) {
      const next = [...this.players.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      this.hostId = next?.id ?? null;
      if (next) {
        logger.info({ evt: 'host_transfer', roomId: this.id, playerId: next.id });
      }
    }

    if (this.players.size === 0) {
      this.stopLoop();
      this.onEmpty(this);
      return;
    }

    this.broadcastRoom();
  }

  // ---------------- 对局生命周期 ----------------

  /** 开局：重置全部坦克状态并启动 tick 循环 */
  startGame() {
    this.phase = PHASE.PLAYING;
    this.tick = 0;
    this.startedAt = Date.now();

    for (const p of this.players.values()) {
      const spawn = this.spawns[p.slot];
      p.x = spawn.x;
      p.y = spawn.y;
      p.dir = p.slot < 2 ? 'down' : 'up';
      p.moveDir = null;
      p.hp = MAX_HP;
      p.alive = true;
      p.invulnUntil = this.startedAt + RESPAWN_INVULN_MS;
      p.lastFireAt = 0;
      p.kills = 0;
      p.deaths = 0;
      // 重新下发地图：客户端可能是新加入的
      this.needMap.add(p.id);
    }

    logger.info({ evt: 'game_start', roomId: this.id, size: this.size });
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

    // ---- 移动 ----
    for (const tank of tanks) {
      if (!tank.alive || !tank.moveDir) continue;

      const others = tanks.filter((t) => t.id !== tank.id);
      const next = tryMoveTank(tank, tank.moveDir, dt, TANK_SPEED, this.grid, others);
      tank.x = next.x;
      tank.y = next.y;
    }

    // 子弹推进与命中判定在 S1.4 接入

    this.broadcastSnapshot(now);
  }

  // ---------------- 意图处理 ----------------

  /**
   * 设置移动意图。
   * 同时更新炮管朝向 —— 即使因撞墙无法移动，朝向也应改变，
   * 否则贴墙时无法调整射击方向。
   */
  setMoveIntent(player, dir) {
    if (this.phase !== PHASE.PLAYING || !player.alive) return;
    player.moveDir = dir;
    if (dir) player.dir = dir;
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
      bullets: [], // S1.4 接入
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
