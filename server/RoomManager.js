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

import { randomUUID } from 'node:crypto';
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
    /** resumeToken -> { roomId, playerId }；token 只由服务端签发 */
    this.resumeBindings = new Map();
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

  /**
   * 登记一个 resumeToken。
   *
   * 同一玩家可能因“观战转正”重新签发 token，
   * 此时必须先作废旧的，否则一人对应多个有效凭证。
   */
  registerResumeToken(token, roomId, playerId) {
    this.revokeResumeTokensOf(roomId, playerId);
    this.resumeBindings.set(token, { roomId, playerId });
  }

  /**
   * 作废某玩家名下的全部 token。
   *
   * 必需：`resumeBindings` 不清理就只增不减。
   * 实测建并离开 10 个房间后，房间已全部销毁（rooms=0）
   * 而 resumeBindings 仍残留 10 条记录 —— 对长跑进程是真实的内存泄漏。
   */
  revokeResumeTokensOf(roomId, playerId) {
    for (const [token, binding] of this.resumeBindings) {
      if (binding.roomId === roomId && binding.playerId === playerId) {
        this.resumeBindings.delete(token);
      }
    }
  }

  /** 作废整个房间的全部 token，房间销毁时调用 */
  revokeRoomTokens(roomId) {
    for (const [token, binding] of this.resumeBindings) {
      if (binding.roomId === roomId) this.resumeBindings.delete(token);
    }
  }

  createRoom() {
    const id = this.genRoomId();
    if (!id) return null;

    const room = new Room(id, (r) => this.destroyRoom(r.id), (r, playerId) =>
      this.revokeResumeTokensOf(r.id, playerId)
    );
    this.rooms.set(id, room);
    logger.info({ evt: 'room_create', roomId: id, total: this.rooms.size });
    return room;
  }

  destroyRoom(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.dispose();
    this.rooms.delete(roomId);
    // 房间已不存在，其下所有重连凭证均已无意义，必须同步释放
    this.revokeRoomTokens(roomId);
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
      case C2S.RESUME:
        this.handleResume(ws, msg);
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
    let spectator = false;
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
      // 对局进行中（含倒计时）加入则转为观战：
      // 此时出生点已分配完毕，直接入场会没有合法位置，
      // 但直接拒绕又让人无事可做 —— 观战并在下局自动转正是最小摩擦的方案
      spectator = room.phase === PHASE.PLAYING || room.phase === PHASE.COUNTDOWN;
      // 满员且非对局中才真正拒绕（对局中满员可以观战）
      if (room.isFull && !spectator) {
        this.sendError(ws, ERR.ROOM_FULL);
        return;
      }
    }

    const resumeToken = randomUUID();
    const player = room.addPlayer(ws, nickname, resumeToken, spectator);
    this.connBinding.set(ws, { roomId: room.id, playerId: player.id });
    this.registerResumeToken(resumeToken, room.id, player.id);

    // 先回 joined 让客户端确认自身身份，再广播 room 更新全员列表
    ws.send(
      encode(S2C.JOINED, {
        selfId: player.id,
        roomId: room.id,
        slot: player.slot,
        color: player.color,
        isHost: room.hostId === player.id,
        resumeToken,
        spectator,
      })
    );
    room.broadcastRoom();
  }

  handleResume(ws, msg) {
    const token = typeof msg.resumeToken === 'string' ? msg.resumeToken : '';
    const binding = this.resumeBindings.get(token);
    if (!binding || String(msg.roomId) !== binding.roomId) {
      this.sendError(ws, ERR.BAD_RESUME);
      return;
    }
    const room = this.rooms.get(binding.roomId);
    const player = room?.players.get(binding.playerId);
    if (!room || !player || player.resumeToken !== token) {
      this.resumeBindings.delete(token);
      this.sendError(ws, ERR.BAD_RESUME);
      return;
    }
    const restored = room.resumePlayer(player.id, ws);
    if (!restored) {
      this.sendError(ws, ERR.BAD_RESUME);
      return;
    }
    this.connBinding.set(ws, binding);
    ws.send(
      encode(S2C.JOINED, {
        selfId: player.id,
        roomId: room.id,
        slot: player.slot,
        color: player.color,
        isHost: room.hostId === player.id,
        resumeToken: token,
        spectator: player.spectator,
        resumed: true,
      })
    );
    logger.info({ evt: 'player_resume', roomId: room.id, playerId: player.id });
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
    // 观战者转正：按加入先后依次入局，先等的人先上
    const queued = [...room.players.values()]
      .filter((p) => p.spectator)
      .sort((a, b) => a.joinedAt - b.joinedAt);

    for (const watcher of queued) {
      if (room.isFull) break;
      // 先移除再重新 addPlayer：观战者 slot 为 -1，
      // 需走一次完整的 slot/颜色/出生点分配
      room.players.delete(watcher.id);
      // 旧身份已不存在，其 token 必须作废，否则永久治留在 resumeBindings 里
      this.revokeResumeTokensOf(room.id, watcher.id);

      const resumeToken = randomUUID();
      const promoted = room.addPlayer(watcher.ws, watcher.nickname, resumeToken);
      this.connBinding.set(watcher.ws, { roomId: room.id, playerId: promoted.id });
      this.registerResumeToken(resumeToken, room.id, promoted.id);

      watcher.ws.send(
        encode(S2C.JOINED, {
          selfId: promoted.id,
          roomId: room.id,
          slot: promoted.slot,
          color: promoted.color,
          isHost: room.hostId === promoted.id,
          resumeToken,
          spectator: false,
        })
      );
    }

    if (!room.canStart) {
      this.sendError(ws, ERR.NOT_ENOUGH_PLAYERS);
      return;
    }
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
    ctx.room.disconnectPlayer(ctx.player.id);
  }
}
