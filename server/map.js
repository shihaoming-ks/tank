/**
 * 地图生成
 *
 * 地图为 COLS × ROWS 的网格，每格 TILE 像素。
 * 0 = 空地，1 = 障碍。
 *
 * 为什么用网格而非任意矩形：
 *   碰撞检测退化为"算出实体覆盖哪几格，查数组"，O(4) 而非 O(n)，
 *   且不会出现浮点缝隙穿墙的经典 bug。
 *
 * ⚠️ 通道宽度约束：坦克为 TANK_SIZE(24)，格子为 TILE(32)，
 *    因此单格通道即可通行，但**相邻障碍之间必须留足 1 格**，
 *    否则会出现视觉上有路却走不过去的情况。
 */

import { COLS, ROWS, TANK_SIZE, TILE } from '../shared/constants.js';

/** 图块类型 */
export const TILE_TYPE = {
  EMPTY: 0,
  WALL: 1,
};

/**
 * 生成固定地图。
 *
 * 刻意用固定布局而非随机生成：
 *   1. 对战公平性 —— 所有玩家面对同一张图
 *   2. 可复现性 —— 出 bug 时能稳定重现
 *   3. 出生点安全性可预先验证，不会随机到墙里
 *
 * 布局为中心对称，保证四个出生角落机会均等。
 *
 * @returns {number[][]} grid[row][col]
 */
export function createMap() {
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(TILE_TYPE.EMPTY));

  const setWall = (col, row) => {
    if (row >= 0 && row < ROWS && col >= 0 && col < COLS) {
      grid[row][col] = TILE_TYPE.WALL;
    }
  };

  // ---- 外围边框 ----
  // 虽然移动逻辑已限制边界，但画出实体墙让玩家直观理解战场范围
  for (let c = 0; c < COLS; c++) {
    setWall(c, 0);
    setWall(c, ROWS - 1);
  }
  for (let r = 0; r < ROWS; r++) {
    setWall(0, r);
    setWall(COLS - 1, r);
  }

  // ---- 四个对称的方块掩体 ----
  // 位于四个象限，为出生点提供就近掩护
  const blocks = [
    [4, 4],
    [COLS - 6, 4],
    [4, ROWS - 6],
    [COLS - 6, ROWS - 6],
  ];
  for (const [c, r] of blocks) {
    for (let dc = 0; dc < 2; dc++) {
      for (let dr = 0; dr < 2; dr++) setWall(c + dc, r + dr);
    }
  }

  // ---- 中央十字掩体 ----
  // 打断中场直线视野，避免开局对角对射秒杀。
  // 刻意在正中留缺口，使十字不封闭，保留穿越路径
  const midC = Math.floor(COLS / 2);
  const midR = Math.floor(ROWS / 2);
  for (let d = -3; d <= 3; d++) {
    if (Math.abs(d) <= 1) continue; // 中心留空
    setWall(midC, midR + d);
    setWall(midC + d, midR);
  }

  // ---- 上下横向短墙 ----
  // 增加路径选择，避免上下贯通成为唯一高速通道
  for (let c = midC - 5; c <= midC + 5; c++) {
    if (Math.abs(c - midC) <= 1) continue; // 留缺口可穿过
    setWall(c, 3);
    setWall(c, ROWS - 4);
  }

  return grid;
}

/**
 * 出生点（像素坐标，坦克中心）。
 * 四角内缩 2 格，确保与任何墙体不重叠。
 * 顺序与玩家 slot 一致，slot 0 → 左上，1 → 右上，2 → 左下，3 → 右下。
 */
export function getSpawnPoints() {
  const inset = 2.5; // 单位：格
  return [
    { x: inset * TILE, y: inset * TILE },
    { x: (COLS - inset) * TILE, y: inset * TILE },
    { x: inset * TILE, y: (ROWS - inset) * TILE },
    { x: (COLS - inset) * TILE, y: (ROWS - inset) * TILE },
  ];
}

/**
 * 自检：确认所有出生点均不与墙体重叠。
 * 在房间初始化时调用，把地图设计错误暴露在启动阶段而非对战中途。
 *
 * @returns {string[]} 问题描述数组，空数组表示通过
 */
export function validateMap(grid) {
  const problems = [];
  const half = TANK_SIZE / 2;

  getSpawnPoints().forEach((p, i) => {
    const c0 = Math.floor((p.x - half) / TILE);
    const c1 = Math.floor((p.x + half - 1) / TILE);
    const r0 = Math.floor((p.y - half) / TILE);
    const r1 = Math.floor((p.y + half - 1) / TILE);

    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (grid[r]?.[c] === TILE_TYPE.WALL) {
          problems.push(`出生点 ${i} (${p.x},${p.y}) 与墙体重叠于格 (${c},${r})`);
        }
      }
    }
  });

  return problems;
}
