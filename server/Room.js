/**
 * 单个房间
 *
 * 持有该房间的**全部权威状态**。所有规则判定发生在此，
 * 客户端只接收广播结果。
 *
 * S1.2 阶段仅实现房间生命周期与玩家进出；
 * 世界状态（坦克/子弹）与 tick 循环在 S1.3 接入。
 */

import { COLORS, PHASE, ROOM_MAX, ROOM_MIN } from '../shared/constants.js';
import { S2C, encode } from '../shared/protocol.js';
import { logger } from './logger.js';

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
    const player = {
      id: `p${++playerSeq}`,
      nickname,
      slot,
      color: COLORS[slot],
      ws,
      joinedAt: Date.now(),
      // 以下字段在 S1.3 接入战斗后填充
      hp: 0,
      alive: false,
      kills: 0,
      deaths: 0,
    };

    this.players.set(player.id, player);
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
      this.onEmpty(this);
      return;
    }

    this.broadcastRoom();
  }

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

  broadcastRoom() {
    this.broadcast(S2C.ROOM, this.serialize());
  }

  /** 释放资源。S1.3 接入 tick 后需在此清理定时器 */
  dispose() {
    logger.info({
      evt: 'room_dispose',
      roomId: this.id,
      lifetimeSec: Math.floor((Date.now() - this.createdAt) / 1000),
    });
  }
}
