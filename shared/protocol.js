/**
 * 通信协议 —— 消息类型与校验
 *
 * ⚠️ 本文件被 server/（Node）与 client/（浏览器）import 同一个物理文件，
 *    保证双端协议永不漂移。只能写纯逻辑，不得引入 Node 或 DOM API。
 */

import { DIR, NICKNAME_MAX_LEN, NICKNAME_MIN_LEN, ROOM_ID_LEN } from './constants.js';

/** 上行消息类型（Client → Server） */
export const C2S = {
  /** 创建或加入房间 { roomId?, nickname } */
  JOIN: 'join',
  /** 断线恢复 { roomId, resumeToken } */
  RESUME: 'resume',
  /** 主动离开 {} */
  LEAVE: 'leave',
  /** 房主开局 {} */
  START: 'start',
  /** 移动意图 { dir }，仅在按键状态变化时发送 */
  INPUT: 'input',
  /** 射击意图 {}，由服务端按冷却裁决 */
  FIRE: 'fire',
  /** 连通性自测（S1.1 阶段用，后续保留作调试） { payload } */
  ECHO: 'echo',
};

/** 下行消息类型（Server → Client） */
export const S2C = {
  /** 身份确认 { selfId, roomId, isHost } */
  JOINED: 'joined',
  /** 房间状态变更 { roomId, phase, players[], hostId } */
  ROOM: 'room',
  /** 世界快照 { t, tanks[], bullets[], timeLeft }，首帧附带 map */
  SNAPSHOT: 'snapshot',
  /** 表现层事件 { kind, ... }，客户端仅用于播特效 */
  EVENT: 'event',
  /** 权威结算 { winnerId, reason, scores[] } */
  OVER: 'over',
  /** 错误 { code, message } */
  ERROR: 'error',
  /** 服务端即将关闭 { message } */
  SHUTDOWN: 'shutdown',
  /** echo 回包 { payload, serverTime } */
  ECHO: 'echo',
};

/** 表现层事件种类。客户端据此播特效与写战报 */
export const EVENT_KIND = {
  /** 玩家加入房间 */
  JOIN: 'join',
  /** 断线恢复 { roomId, resumeToken } */
  RESUME: 'resume',
  /** 玩家离开房间 */
  LEAVE: 'leave',
  /** 对局开始 */
  START: 'start',
  /** 开火 */
  FIRE: 'fire',
  /** 命中扣血 */
  HIT: 'hit',
  /** 击杀（目标 HP 归零） */
  KILL: 'kill',
  /** 复活 */
  RESPAWN: 'respawn',
  /** 房主移交 */
  HOST: 'host',
  /** 开局倒计时读秒（3/2/1） */
  COUNTDOWN: 'countdown',
  /** 砖墙被击破 */
  BRICK_BREAK: 'brick_break',
  /** 坦克相撞 */
  RAM: 'ram',
};

/** 错误码。客户端据此决定提示文案与是否可重试 */
export const ERR = {
  BAD_MESSAGE: 'BAD_MESSAGE',
  BAD_NICKNAME: 'BAD_NICKNAME',
  BAD_ROOM_ID: 'BAD_ROOM_ID',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_IN_GAME: 'ROOM_IN_GAME',
  BAD_RESUME: 'BAD_RESUME',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  INTERNAL: 'INTERNAL',
};

/** 错误码 → 用户可读文案。集中在此，避免前端散落硬编码字符串 */
export const ERR_TEXT = {
  [ERR.BAD_MESSAGE]: '消息格式错误',
  [ERR.BAD_NICKNAME]: `昵称需为 ${NICKNAME_MIN_LEN}~${NICKNAME_MAX_LEN} 个字符`,
  [ERR.BAD_ROOM_ID]: `房间号需为 ${ROOM_ID_LEN} 位数字`,
  [ERR.ROOM_NOT_FOUND]: '房间不存在，请检查房间号',
  [ERR.ROOM_FULL]: '房间已满',
  [ERR.ROOM_IN_GAME]: '该房间对局已开始',
  [ERR.BAD_RESUME]: '重连凭证无效或已过期',
  [ERR.NOT_IN_ROOM]: '你当前不在任何房间',
  [ERR.NOT_HOST]: '只有房主可以开始对局',
  [ERR.NOT_ENOUGH_PLAYERS]: '至少需要 2 名玩家才能开始',
  [ERR.INTERNAL]: '服务端异常，请重试',
};

// ---------------- 编解码 ----------------

/**
 * 编码为线路格式。
 * 统一出口便于后续替换为二进制协议而不动业务代码。
 */
export function encode(type, data = {}) {
  return JSON.stringify({ type, ...data });
}

/**
 * 解码并做基础结构校验。
 * 解析失败返回 null，由调用方回 BAD_MESSAGE —— 绝不抛出到连接层导致进程崩溃。
 */
export function decode(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return null;
    return msg;
  } catch {
    return null;
  }
}

// ---------------- 校验（双端共用，前端可提前拦截，后端必须再校验一次） ----------------

/**
 * 校验并规范化昵称。
 * 前端调用可即时提示；服务端必须独立再校验，不信任任何客户端输入。
 * @returns {string|null} 合法则返回 trim 后的昵称，否则 null
 */
export function normalizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length < NICKNAME_MIN_LEN || s.length > NICKNAME_MAX_LEN) return null;
  return s;
}

/** 校验房间号：必须是 ROOM_ID_LEN 位纯数字 */
export function isValidRoomId(raw) {
  return typeof raw === 'string' && new RegExp(`^\\d{${ROOM_ID_LEN}}$`).test(raw);
}

/** 校验移动方向：必须是四方向之一，或 null（表示停止） */
export function isValidDir(raw) {
  return raw === null || Object.values(DIR).includes(raw);
}
