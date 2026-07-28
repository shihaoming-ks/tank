/**
 * 全局可调参数 —— 唯一来源
 *
 * ⚠️ 本文件被 server/（Node）与 client/（浏览器）import 同一个物理文件。
 *    因此这里只能写纯常量，不得引入任何 Node 或 DOM API。
 *
 * 任何数值调整只改这里，禁止在其他文件出现魔法数字。
 */

// ---------- 地图 ----------
/** 单格边长（px）。障碍物与墙体尺寸必须等于此值 */
export const TILE = 32;
/** 地图列数 */
export const COLS = 30;
/** 地图行数 */
export const ROWS = 20;
/** 地图像素宽 = 960 */
export const MAP_W = COLS * TILE;
/** 地图像素高 = 640 */
export const MAP_H = ROWS * TILE;

// ---------- 循环 ----------
/** 服务端权威 tick 频率。tick 与广播同频，MVP 阶段不做节流 */
export const TICK_HZ = 30;
/** 单 tick 间隔（ms），约 33.3ms */
export const TICK_MS = 1000 / TICK_HZ;

// ---------- 坦克 ----------
/** 坦克碰撞盒边长。小于 TILE，保证能穿过单格通道 */
export const TANK_SIZE = 24;
/** 移动速度（px/s） */
export const TANK_SPEED = 120;

// ---------- 子弹 ----------
export const BULLET_SIZE = 6;
/** 子弹速度（px/s）。为坦克速度 3 倍，保证可命中移动目标 */
export const BULLET_SPEED = 360;
/** 射击冷却（ms） */
export const FIRE_COOLDOWN_MS = 300;

// ---------- 战斗规则 ----------
/** 初始生命值 */
export const MAX_HP = 3;
/** 复活后无敌时长（ms），防止复活点连杀 */
export const RESPAWN_INVULN_MS = 2000;
/** 单局时限（ms） */
export const MATCH_DURATION_MS = 180_000;

// ---------- 房间 ----------
/** 开局最少人数 */
export const ROOM_MIN = 2;
/** 房间容量上限 */
export const ROOM_MAX = 4;
/** 房间号位数 */
export const ROOM_ID_LEN = 4;

// ---------- 连接 ----------
/** 心跳间隔（ms）。25s 是为穿透常见代理的 30s/60s 空闲超时 */
export const HEARTBEAT_MS = 25_000;
/** 断线判定超时（ms）。超过此时长无响应则视为掉线 */
export const DISCONNECT_TIMEOUT_MS = 3_000;

// ---------- 玩家外观 ----------
/** 玩家配色，按加入顺序分配。索引即 slot */
export const COLORS = ['#e94f37', '#3f88c5', '#44bba4', '#f6ae2d'];

// ---------- 昵称约束 ----------
export const NICKNAME_MIN_LEN = 1;
export const NICKNAME_MAX_LEN = 12;

// ---------- 房间阶段 ----------
export const PHASE = {
  /** 等待玩家加入 / 房主开局 */
  WAITING: 'waiting',
  /** 对局进行中 */
  PLAYING: 'playing',
  /** 已结算 */
  OVER: 'over',
};

// ---------- 对局结束原因 ----------
export const END_REASON = {
  /** 仅剩 1 名存活玩家 */
  LAST_SURVIVOR: 'last_survivor',
  /** 时限到，比较剩余生命值 */
  TIMEOUT: 'timeout',
  /** 人数不足 2 人，本局中止 */
  ABORTED: 'aborted',
};

// ---------- 移动方向 ----------
export const DIR = {
  UP: 'up',
  DOWN: 'down',
  LEFT: 'left',
  RIGHT: 'right',
};

/** 方向 → 单位向量。用于移动积分与炮管朝向 */
export const DIR_VEC = {
  [DIR.UP]: { x: 0, y: -1 },
  [DIR.DOWN]: { x: 0, y: 1 },
  [DIR.LEFT]: { x: -1, y: 0 },
  [DIR.RIGHT]: { x: 1, y: 0 },
};
