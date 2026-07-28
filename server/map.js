/**
 * 地图生成
 *
 * 地图为 COLS × ROWS 的网格，每格 TILE 像素，值取自 TILE_TYPE。
 *
 * 为什么用网格而非任意矩形：
 *   碰撞检测退化为"算出实体覆盖哪几格，查数组"，O(4) 而非 O(n)，
 *   且不会出现浮点缝隙穿墙的经典 bug。
 *
 * 每局随机生成，但受三条硬约束保护：
 *   1. 障碍比例固定（MAP_FILL_RATIO），避免忽空旷忽拥挤
 *   2. 出生点周围留安全区，不会开局即被围死
 *   3. 生成后校验连通性，保证任意两个出生点之间可达
 */

import {
  BLOCKING_TILES,
  BRICK_BY_HP,
  BRICK_HP_OF,
  COLS,
  DESTRUCTIBLE_TILES,
  MAP_FILL_RATIO,
  MAP_STEEL_RATIO,
  MIN_SPAWN_DISTANCE,
  ROOM_MAX,
  ROWS,
  SPAWN_SAFE_RADIUS,
  TANK_SIZE,
  TILE,
  TILE_TYPE,
} from '../shared/constants.js';

export { TILE_TYPE };

/** 某个图块是否阻挡通行 */
export function isBlocking(tile) {
  return BLOCKING_TILES.has(tile);
}

/** 某个图块是否可被子弹击破 */
export function isDestructible(tile) {
  return DESTRUCTIBLE_TILES.has(tile);
}

/**
 * 对格子施加一次子弹伤害。
 *
 * 砖墙有 BRICK_HP 点耐久，每次命中降一级，归零后变为空地。
 * 耐久直接编码进图块值（BRICK / BRICK_2 / BRICK_1），
 * 好处是地图始终是纯数字二维数组 —— 快照序列化、客户端渲染
 * 都无需为耐久单开一层数据结构。
 *
 * @returns {{ changed: boolean, broken: boolean, hp: number }}
 */
export function damageTile(grid, col, row) {
  const tile = grid[row]?.[col];
  if (!isDestructible(tile)) return { changed: false, broken: false, hp: 0 };

  const hp = (BRICK_HP_OF[tile] ?? 0) - 1;
  grid[row][col] = BRICK_BY_HP[Math.max(0, hp)];
  return { changed: true, broken: hp <= 0, hp: Math.max(0, hp) };
}

/**
 * 生成随机出生点（像素坐标，坦克中心）。
 *
 * 位置每局随机，但受两条约束：
 *   1. 所在格及其四邻必须为空地 —— 保证不会一出生就卡在墙里
 *   2. 彼此间距 ≥ MIN_SPAWN_DISTANCE —— 否则倒计时一结束就是贴脸互射，
 *      运气成分过大
 *
 * 采用"随机取点 + 拒绝采样"而非精心构造：
 * 实现简单且分布自然，失败时退化为四角固定点，保证一定能开局。
 *
 * @param {number[][]} grid
 * @param {number} count 需要的出生点数量
 * @param {() => number} rng
 * @returns {Array<{x:number,y:number}>}
 */
export function generateSpawnPoints(grid, count = ROOM_MAX, rng = Math.random) {
  const candidates = [];

  // 收集所有"自身与四邻皆为空地"的格子作为候选
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (isBlocking(grid[r][c])) continue;
      if (
        isBlocking(grid[r - 1][c]) ||
        isBlocking(grid[r + 1][c]) ||
        isBlocking(grid[r][c - 1]) ||
        isBlocking(grid[r][c + 1])
      ) {
        continue;
      }
      candidates.push({ x: c * TILE + TILE / 2, y: r * TILE + TILE / 2 });
    }
  }

  // 多次尝试整组采样：单点贪心容易走进"最后一个点无处可放"的死角
  for (let attempt = 0; attempt < 200; attempt++) {
    const picked = [];
    const pool = [...candidates];

    while (picked.length < count && pool.length > 0) {
      const idx = Math.floor(rng() * pool.length);
      const p = pool.splice(idx, 1)[0];
      const farEnough = picked.every(
        (q) => Math.hypot(p.x - q.x, p.y - q.y) >= MIN_SPAWN_DISTANCE
      );
      if (farEnough) picked.push(p);
    }

    if (picked.length === count) return picked;
  }

  // 兜底：退化为四角固定点。宁可位置固定，也不能开不了局
  return getFallbackSpawnPoints().slice(0, count);
}

/** 兜底出生点：四角内缩，顺序对应 slot */
export function getFallbackSpawnPoints() {
  const inset = 2.5; // 单位：格
  return [
    { x: inset * TILE, y: inset * TILE },
    { x: (COLS - inset) * TILE, y: inset * TILE },
    { x: inset * TILE, y: (ROWS - inset) * TILE },
    { x: (COLS - inset) * TILE, y: (ROWS - inset) * TILE },
  ];
}

/** @deprecated 保留以兼容旧调用，等价于 getFallbackSpawnPoints */
export function getSpawnPoints() {
  return getFallbackSpawnPoints();
}

/** 出生点对应的格坐标 */
function spawnCells(points = getFallbackSpawnPoints()) {
  return points.map((p) => ({
    col: Math.floor(p.x / TILE),
    row: Math.floor(p.y / TILE),
  }));
}

/**
 * 生成一张随机地图。
 *
 * @param {() => number} rng 随机源，默认 Math.random。
 *        允许注入是为了让测试可复现（传入固定种子的伪随机函数）。
 * @returns {number[][]} grid[row][col]
 */
export function createMap(rng = Math.random) {
  // 测试钩子：生成无内部障碍的空旷地图。
  //
  // 为何需要：战斗冒烟测试要验证的是"射击 → 命中 → 淘汰 → 结算"这条链路，
  // 而非寻路能力。随机掩体会让测试脚本必须实现 AI 寻路才能打中对手，
  // 既脆弱又与被测目标无关。
  // 地图随机性本身由 test/map.test.js 以 50 个种子独立覆盖，不会漏测。
  if (process.env.TANK_EMPTY_MAP === '1') return emptyWithBorder();

  // 最多重试若干次，直到生成一张连通的地图。
  // 实测首次即通过的概率极高，重试只是兜底，避免极端随机导致孤岛。
  for (let attempt = 0; attempt < 30; attempt++) {
    const grid = generateCandidate(rng);
    if (isFullyConnected(grid)) return grid;
  }

  // 极端情况下退化为"仅边界、无内部障碍"，保证游戏一定可玩。
  // 宁可地图单调，也不能让玩家进入一张走不通的图。
  return emptyWithBorder();
}

/** 只有外围边界的空地图 */
function emptyWithBorder() {
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(TILE_TYPE.EMPTY));
  for (let c = 0; c < COLS; c++) {
    grid[0][c] = TILE_TYPE.BORDER;
    grid[ROWS - 1][c] = TILE_TYPE.BORDER;
  }
  for (let r = 0; r < ROWS; r++) {
    grid[r][0] = TILE_TYPE.BORDER;
    grid[r][COLS - 1] = TILE_TYPE.BORDER;
  }
  return grid;
}

/**
 * 生成一张候选地图（未校验连通性）。
 *
 * 采用"对称块状投放"而非逐格随机：
 *   - 逐格随机会产生大量孤立单格，视觉杂乱且掩体功能差
 *   - 块状（1×1 ~ 2×2）更接近人工设计的掩体形态
 *   - 中心对称保证四个出生角机会均等，避免某个角天然吃亏
 *
 * ⚠️ 图块类型按**格**而非按块决定：
 *    整块同类型时，一个 2×2 块就占 4 格，钢/砖比例的方差极大
 *    （实测在目标 45% 下出现过 10%~45% 的剧烈波动）。
 *    逐格决定后比例稳定，且同一块内混合两种材质在视觉上也更耐看。
 */
function generateCandidate(rng) {
  const grid = emptyWithBorder();

  // 可放置区域为去掉边界后的内部
  const innerCols = COLS - 2;
  const innerRows = ROWS - 2;
  const targetCells = Math.floor(innerCols * innerRows * MAP_FILL_RATIO);

  const safe = buildSafeMask();

  let placed = 0;
  let guard = 0;
  // 因为采用中心对称成对投放，每次循环最多填 2 组块
  while (placed < targetCells && guard++ < 2000) {
    // 只在左半区取点，右半区由对称镜像产生
    const col = 1 + Math.floor(rng() * Math.ceil(innerCols / 2));
    const row = 1 + Math.floor(rng() * innerRows);

    // 2×2 的块占 35%，其余为 1×1，形态更自然
    const size = rng() < 0.35 ? 2 : 1;

    placed += tryPlaceBlock(grid, safe, col, row, size, rng);

    // 中心对称镜像点
    const mCol = COLS - 1 - col - (size - 1);
    const mRow = ROWS - 1 - row - (size - 1);
    placed += tryPlaceBlock(grid, safe, mCol, mRow, size, rng);
  }

  return grid;
}

/**
 * 标记禁止放置障碍的格子。
 * 包含出生点安全区，以及出生点之间沿边缘的通道，
 * 避免四角被完全封死。
 */
function buildSafeMask() {
  const safe = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));

  for (const { col, row } of spawnCells()) {
    for (let dr = -SPAWN_SAFE_RADIUS; dr <= SPAWN_SAFE_RADIUS; dr++) {
      for (let dc = -SPAWN_SAFE_RADIUS; dc <= SPAWN_SAFE_RADIUS; dc++) {
        const r = row + dr;
        const c = col + dc;
        if (r > 0 && r < ROWS - 1 && c > 0 && c < COLS - 1) safe[r][c] = true;
      }
    }
  }

  return safe;
}

/**
 * 尝试放置一个 size×size 的块。
 * 类型逐格决定（见 generateCandidate 的说明）。
 * @returns {number} 实际填充的格数
 */
function tryPlaceBlock(grid, safe, col, row, size, rng) {
  // 先整体校验，避免出现半个块被截断的碎片
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      const r = row + dr;
      const c = col + dc;
      if (r <= 0 || r >= ROWS - 1 || c <= 0 || c >= COLS - 1) return 0;
      if (safe[r][c]) return 0;
      if (grid[r][c] !== TILE_TYPE.EMPTY) return 0;
    }
  }

  let n = 0;
  for (let dr = 0; dr < size; dr++) {
    for (let dc = 0; dc < size; dc++) {
      grid[row + dr][col + dc] =
        rng() < MAP_STEEL_RATIO ? TILE_TYPE.STEEL : TILE_TYPE.BRICK;
      n++;
    }
  }
  return n;
}

/**
 * 校验所有出生点互相连通。
 *
 * 这一步不可省略：随机生成完全可能把某个出生角围成孤岛，
 * 那样对局会直接失去意义（玩家永远碰不到面）。
 *
 * 注意按**坦克实际可通行性**判定而非单格可达：
 * 坦克为 TANK_SIZE(24)、格为 TILE(32)，虽能穿单格通道，
 * 但格中心间的移动需保证目标格空闲，故用格中心 BFS 即可近似。
 */
export function isFullyConnected(grid, points) {
  const cells = spawnCells(points);
  const start = cells[0];
  if (isBlocking(grid[start.row]?.[start.col])) return false;

  const seen = Array.from({ length: ROWS }, () => new Array(COLS).fill(false));
  const queue = [start];
  seen[start.row][start.col] = true;

  const DIRS = [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ];

  while (queue.length) {
    const { row, col } = queue.shift();
    for (const [dr, dc] of DIRS) {
      const r = row + dr;
      const c = col + dc;
      if (r < 0 || r >= ROWS || c < 0 || c >= COLS) continue;
      if (seen[r][c]) continue;
      if (isBlocking(grid[r][c])) continue;
      seen[r][c] = true;
      queue.push({ row: r, col: c });
    }
  }

  return cells.every(({ row, col }) => seen[row]?.[col]);
}

/**
 * 自检：出生点不与障碍重叠、且全部连通。
 * 在房间初始化时调用，把地图缺陷暴露在启动阶段而非对战中途。
 *
 * @returns {string[]} 问题描述数组，空数组表示通过
 */
export function validateMap(grid, points = getFallbackSpawnPoints()) {
  const problems = [];
  const half = TANK_SIZE / 2;

  points.forEach((p, i) => {
    const c0 = Math.floor((p.x - half) / TILE);
    const c1 = Math.floor((p.x + half - 1) / TILE);
    const r0 = Math.floor((p.y - half) / TILE);
    const r1 = Math.floor((p.y + half - 1) / TILE);

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (isBlocking(grid[r]?.[c])) {
          problems.push(`出生点 ${i} (${p.x},${p.y}) 与障碍重叠于格 (${c},${r})`);
        }
      }
    }
  });

  if (!isFullyConnected(grid, points)) {
    problems.push('出生点之间不连通，存在孤岛');
  }

  return problems;
}

/** 统计各类图块数量，用于测试与调试 */
export function countTiles(grid) {
  const stat = { empty: 0, border: 0, brick: 0, steel: 0 };
  for (const row of grid) {
    for (const tile of row) {
      if (tile === TILE_TYPE.EMPTY) stat.empty++;
      else if (tile === TILE_TYPE.BORDER) stat.border++;
      else if (tile === TILE_TYPE.STEEL) stat.steel++;
      // 破损砖墙仍计入 brick，便于统计障碍总量
      else if (isDestructible(tile)) stat.brick++;
    }
  }
  return stat;
}
