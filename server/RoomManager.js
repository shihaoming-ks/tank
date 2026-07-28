/**
 * 房间管理器
 *
 * 职责：
 *   1. 房间的创建、查找、销毁
 *   2. 连接与玩家的绑定关系
 *   3. 所有上行消息的路由与校验
 *
 * 设计要点：**服务端不信任任何客户端输入**。
 * 即使前端已做校验，此处必须独立再校验一次。
 */

import { PHASE, ROOM_ID_LEN } from '../shared/constants.js';
import {
  C2S,
  ERR,
  ERR_TEXT,
  S2C,
  encode,
  isValidDir,
  isValidRoomId,
  normalizeNickname,
} from '../shared/protocol.js';
import { logger } from './logger.js';
import { Room } from './Room.js';

export class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} roomId → Room */
    this.rooms = new Map();
    /** @type {Map<object, {roomId: string, playerId: string}>} ws → 归属信息 */
    this.connBinding = new Map();
  }

  get roomCount() {
    return this.rooms.size;
  }

  get playerCount() {
    let n = 0;
    for (const room of this.rooms.values()) n += room.size;
    return n;
  }

  /**
   * 生成未被占用的房间号。
   * 空间为 10^4 = 10000，Demo 场景下碰撞概率极低；
   * 仍加重试上限，避免房间数接近上限时死循环。
   */
  genRoomId() {
    const max = 10 ** ROOM_ID_LEN;
    for (let attempt = 0; attempt < 100; attempt++) {
      const id = String(Math.floor(Math.random() * max)).padStart(ROOM_ID_LEN, '0');
      if (!this.rooms.has(id)) return id;
    }
    return null;
  }

  createRoom() {
    const id = this.genRoomId();
    if (!id) return null;

    const room = new Room(id, (r) => this.destroyRoom(r.id));
    this.rooms.set(id, room);
    logger.info({ evt: 'room_create', roomId: id, total: this.rooms.size });
    return room;
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.dispose();
    this.rooms.delete(roomId);
    logger.info({ evt: 'room_destroy', roomId, total: this.rooms.size });
  }

  // ---------------- 消息路由 ----------------

  sendError(ws, code, extra) {
    try {
      ws.send(encode(S2C.ERROR, { code, message: ERR_TEXT[code] ?? code, ...extra }));
    } catch {
      /* 连接已不可写 */
    }
  }

  /** 取连接当前归属的房间与玩家 */
  resolve(ws) {
    const binding = this.connBinding.get(ws);
    if (!binding) return null;
    const room = this.rooms.get(binding.roomId);
    if (!room) return null;
    const player = room.players.get(binding.playerId);
    if (!player) return null;
    return { room, player };
  }

  /**
   * 处理一条上行消息。
   * @returns {boolean} 是否已处理（false 表示未知类型，由调用方回错误）
   */
  handleMessage(ws, msg) {
    switch (msg.type) {
      case C2S.JOIN:
        this.handleJoin(ws, msg);
        return true;
      case C2S.LEAVE:
        this.handleLeave(ws);
        return true;
      case C2S.START:
        this.handleStart(ws);
        return true;
      case C2S.INPUT:
        this.handleInput(ws, msg);
        return true;
      case C2S.FIRE:
        this.handleFire(ws);
        return true;
      default:
        return false;
    }
  }

  handleJoin(ws, msg) {
    // 已在房间中则先退出，避免一个连接占用多个 slot
    if (this.connBinding.has(ws)) this.handleLeave(ws);

    const nickname = normalizeNickname(msg.nickname);
    if (!nickname) {
      this.sendError(ws, ERR.BAD_NICKNAME);
      return;
    }

    let room;
    if (msg.roomId === undefined || msg.roomId === null || msg.roomId === '') {
      // 未指定房间号 → 创建新房间
      room = this.createRoom();
      if (!room) {
        this.sendError(ws, ERR.INTERNAL);
        return;
      }
    } else {
      if (!isValidRoomId(String(msg.roomId))) {
        this.sendError(ws, ERR.BAD_ROOM_ID);
        return;
      }
      room = this.rooms.get(String(msg.roomId));
      if (!room) {
        this.sendError(ws, ERR.ROOM_NOT_FOUND);
        return;
      }
      if (room.isFull) {
        this.sendError(ws, ERR.ROOM_FULL);
        return;
      }
      // 对局中不允许中途加入，否则新玩家会以 0 血进场，规则不清晰
      // 倒计时阶段同样不允许中途加入：此时出生点已分配完毕，
      // 新玩家会没有合法出生位置
      if (room.phase === PHASE.PLAYING || room.phase === PHASE.COUNTDOWN) {
        this.sendError(ws, ERR.ROOM_IN_GAME);
        return;
      }
    }

    const player = room.addPlayer(ws, nickname);
    this.connBinding.set(ws, { roomId: room.id, playerId: player.id });

    // 先回 joined 让客户端确认自身身份，再广播 room 更新全员列表
    ws.send(
      encode(S2C.JOINED, {
        selfId: player.id,
        roomId: room.id,
        slot: player.slot,
        color: player.color,
        isHost: room.hostId === player.id,
      })
    );
    room.broadcastRoom();
  }

  handleLeave(ws) {
    const ctx = this.resolve(ws);
    this.connBinding.delete(ws);
    if (!ctx) return;
    ctx.room.removePlayer(ctx.player.id, 'leave');
  }

  handleStart(ws) {
    const ctx = this.resolve(ws);
    if (!ctx) {
      this.sendError(ws, ERR.NOT_IN_ROOM);
      return;
    }
    const { room, player } = ctx;

    if (room.hostId !== player.id) {
      this.sendError(ws, ERR.NOT_HOST);
      return;
    }
    if (!room.canStart) {
      this.sendError(ws, ERR.NOT_ENOUGH_PLAYERS);
      return;
    }
    // 已在对局中则忽略，避免重复点击把正在进行的对局重置
    // 已在对局中（含倒计时）则忽略，防止重复点击重置对局
    if (room.phase === PHASE.PLAYING || room.phase === PHASE.COUNTDOWN) return;

    room.startGame();
  }

  /**
   * 移动意图。
   *
   * 高频消息，因此：
   *   - 校验失败**静默忽略**而非回错误，避免异常客户端把自己刷爆
   *   - 客户端仅在按键状态变化时发送，不是每帧发
   */
  handleInput(ws, msg) {
    const ctx = this.resolve(ws);
    if (!ctx) return;

    const dir = msg.dir ?? null;
    if (!isValidDir(dir)) {
      logger.debug({ evt: 'bad_input_dir', playerId: ctx.player.id, dir });
      return;
    }

    ctx.room.setMoveIntent(ctx.player, dir);
  }

  /** 射击意图。同样高频，校验失败静默忽略；冷却由服务端裁决 */
  handleFire(ws) {
    const ctx = this.resolve(ws);
    if (!ctx) return;
    ctx.room.fire(ctx.player);
  }

  /** 连接断开时清理。与主动 leave 的区别仅在于日志 reason */
  handleDisconnect(ws) {
    const ctx = this.resolve(ws);
    this.connBinding.delete(ws);
    if (!ctx) return;
    ctx.room.removePlayer(ctx.player.id, 'disconnect');
  }
}
