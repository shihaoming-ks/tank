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
/**
 * 坦克碰撞盒边长。必须小于 TILE，保证能穿过单格通道。
 *
 * 26 而非 24：让碰撞盒接近一个格（32px），
 * 使「车体 + 炮筒」的视觉尺寸能完全装进碰撞盒内，
 * 同时保留 6px 容差避免浮点误差卡在通道里。
 */
export const TANK_SIZE = 26;

/**
 * 车体绘制边长（纯视觉，不参与碰撞）。
 *
 * 比碰撞盒小，空出的部分给炮筒，
 * 使得 TANK_BODY/2 + 炮筒长 = TANK_SIZE/2，视觉不超出碰撞盒。
 *
 * ⭐ 为何不直接给炮筒加碰撞（已评估并否定）：
 *   1. 贴墙时无法转向 —— 炮筒扫过墙面即被阻挡，坦克贴墙后就锁死方向，
 *      而贴墙调整射击角度是坦克类游戏的基本操作
 *   2. 碰撞盒会变成**方向相关的非正方形**，网格查表 O(4) 的优势尽失，
 *      且转向瞬间可能直接嵌入墙体，需额外的"转向合法性"判定
 * 因此反过来做：缩小视觉而非扩大碰撞，代价最小、手感最好。
 */
export const TANK_BODY = 18;

/** 炮筒长度（从车体边缘向外）。TANK_BODY/2 + 此值 = TANK_SIZE/2 */
export const BARREL_LEN = (TANK_SIZE - TANK_BODY) / 2;

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

// ---------- 开局倒计时 ----------
/**
 * 开局倒计时时长（ms）。3 秒对应 3-2-1。
 * 期间玩家可见地图与彼此位置，但不能移动或开火 ——
 * 避免手快的人在对手还没看清局面时就完成击杀。
 */
export const COUNTDOWN_MS = 3000;

/**
 * 倒计时结束后「开始！」的展示时长（ms）。
 * 纯客户端表现，不影响任何规则判定 —— 此期间已可正常操作。
 */
export const GO_TEXT_MS = 900;


// ---------- 碰撞伤害 ----------
/** 坦克相撞伤害。双方同时扣血，鲇鱼式撞击不划算 */
export const RAM_DAMAGE = 1;

/**
 * 相撞伤害冷却（ms）。
 *
 * 必须存在：两车贴在一起时每帧都重叠，
 * 无冷却会在 30Hz 下一秒内扣光双方全部血量。
 */
export const RAM_COOLDOWN_MS = 1200;

// ---------- 图块类型 ----------
/**
 * 图块类型。刻意区分边界与内部障碍，便于后续替换为不同美术素材：
 *   BORDER 用外围钢墙贴图，BRICK/STEEL 用可辨识的内部障碍贴图。
 * 数值即渲染层的贴图索引依据，不要随意调整已有值。
 *
 * BRICK 可被子弹击破，故用 BRICK_HP_N 表示不同破损程度 ——
 * 这样地图仍是一个纯数字二维数组，无需为耐久单开一层数据结构，
 * 快照序列化与客户端渲染都不必改变形态。
 */
export const TILE_TYPE = {
  /** 空地，可通行 */
  EMPTY: 0,
  /** 地图外围边界（不可破坏，视觉上应最厚重） */
  BORDER: 1,
  /** 内部砖墙 —— 满耐久（可被击破，需 BRICK_HP 次） */
  BRICK: 2,
  /** 内部钢块（不可破坏，视觉上更硬质） */
  STEEL: 3,
  /** 砖墙剩余 2 点耐久 */
  BRICK_2: 4,
  /** 砖墙剩余 1 点耐久 */
  BRICK_1: 5,
};

/** 砖墙初始耐久：需要几发子弹才能击破 */
export const BRICK_HP = 3;

/**
 * 砖墙耐久 → 图块值。索引即剩余耐久。
 * 0 耐久对应 EMPTY（已击破）。
 */
export const BRICK_BY_HP = [TILE_TYPE.EMPTY, TILE_TYPE.BRICK_1, TILE_TYPE.BRICK_2, TILE_TYPE.BRICK];

/** 图块值 → 剩余耐久。非砖墙返回 null */
export const BRICK_HP_OF = {
  [TILE_TYPE.BRICK]: 3,
  [TILE_TYPE.BRICK_2]: 2,
  [TILE_TYPE.BRICK_1]: 1,
};

/** 所有可被子弹击破的图块 */
export const DESTRUCTIBLE_TILES = new Set([
  TILE_TYPE.BRICK,
  TILE_TYPE.BRICK_2,
  TILE_TYPE.BRICK_1,
]);

/** 所有阻挡类图块。碰撞层据此判断，新增类型只需加进这里 */
export const BLOCKING_TILES = new Set([
  TILE_TYPE.BORDER,
  TILE_TYPE.BRICK,
  TILE_TYPE.BRICK_2,
  TILE_TYPE.BRICK_1,
  TILE_TYPE.STEEL,
]);

// ---------- 地图生成 ----------
/**
 * 内部障碍占可用区域的目标比例。
 *
 * 0.18 → 0.11 → 0.08 逐步下调：0.11 实测仍偏密，遭遇战前绕行过久。
 * 0.08 保留必要掩体但不妨碍机动。
 */
export const MAP_FILL_RATIO = 0.08;

/**
 * 内部障碍中钢块所占比例，其余为可破坏的砖墙。
 *
 * 上调至 0.45：砖墙可被击破，占比过高会让地图很快被推平；
 * 且两类障碍数量悬殊时，玩家难以建立"哪些能打、哪些不能打"的直觉。
 */
export const MAP_STEEL_RATIO = 0.45;

/**
 * 出生点周围的安全半径（单位：格）。
 * 该范围内不生成任何障碍，保证开局有活动空间且不会被瞬间围死。
 */
export const SPAWN_SAFE_RADIUS = 2;

/**
 * 玩家出生点之间的最小间距（px）。
 *
 * 出生位置每局随机，但必须保证彼此不会过近 ——
 * 否则倒计时一结束就是贴脸互射，运气成分过大。
 * 240px 约等于 7.5 格，够双方有反应与机动空间。
 */
export const MIN_SPAWN_DISTANCE = 240;

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
  /** 开局倒计时中：可见战场但禁止操作 */
  COUNTDOWN: 'countdown',
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
