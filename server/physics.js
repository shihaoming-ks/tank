/**
 * 物理与碰撞 —— 纯函数
 *
 * 本模块**不持有任何状态**，所有函数的输出仅取决于输入。
 * 这样做的目的：
 *   1. 可零 mock 直接单测（见 test/physics.test.js）
 *   2. 便于推理，碰撞 bug 不会牵连房间状态
 *
 * 坐标约定：所有实体用**中心点**表示，碰撞盒为轴对齐正方形（AABB）。
 */

import {
  BULLET_SIZE,
  DIR_VEC,
  MAP_H,
  MAP_W,
  TANK_SIZE,
  TILE,
} from '../shared/constants.js';
import { TILE_TYPE } from './map.js';

/**
 * 判断以 (cx, cy) 为中心、边长 size 的正方形是否与任何墙体重叠。
 *
 * 只检查该正方形覆盖到的格子（最多 4 个），而非遍历全图。
 *
 * ⚠️ `-1` 的必要性：若实体右边界正好落在格子分界线上（如 x=64.0），
 *    不减 1 会多算入下一格，导致贴墙时被判定为碰撞（视觉上明显有缝却过不去）。
 */
export function hitsWall(grid, cx, cy, size) {
  const half = size / 2;
  const c0 = Math.floor((cx - half) / TILE);
  const c1 = Math.floor((cx + half - 1) / TILE);
  const r0 = Math.floor((cy - half) / TILE);
  const r1 = Math.floor((cy + half - 1) / TILE);

  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      // 越界视为墙，双重保险
      if (grid[r]?.[c] === undefined) return true;
      if (grid[r][c] === TILE_TYPE.WALL) return true;
    }
  }
  return false;
}

/** 中心点为 (cx, cy)、边长 size 的正方形是否完全在地图内 */
export function insideMap(cx, cy, size) {
  const half = size / 2;
  return cx - half >= 0 && cy - half >= 0 && cx + half <= MAP_W && cy + half <= MAP_H;
}

/** 两个轴对齐正方形是否重叠 */
export function aabbOverlap(ax, ay, aSize, bx, by, bSize) {
  const halfSum = (aSize + bSize) / 2;
  return Math.abs(ax - bx) < halfSum && Math.abs(ay - by) < halfSum;
}

/**
 * 尝试把坦克沿 dir 移动 dt 秒。
 *
 * 采用**先算目标位置再整体校验**，失败则完全不移动（不做滑动修正）。
 * 理由：滑动修正在网格地图上会产生"贴墙自动转向"的诡异手感，
 * 且实现复杂度高。直接停住更符合坦克类游戏预期。
 *
 * 分轴独立校验：允许沿墙滑行时保留另一轴的位移，
 * 否则斜向贴墙会完全卡死（本 MVP 仅四向移动，此处为后续扩展预留）。
 *
 * @param {object} tank      { x, y }
 * @param {string} dir       DIR 之一
 * @param {number} dt        秒
 * @param {number} speed     px/s
 * @param {number[][]} grid  地图
 * @param {Array} others     其他坦克 [{ x, y, alive }]
 * @returns {{x: number, y: number, moved: boolean}}
 */
export function tryMoveTank(tank, dir, dt, speed, grid, others = []) {
  const vec = DIR_VEC[dir];
  if (!vec) return { x: tank.x, y: tank.y, moved: false };

  const dist = speed * dt;
  const targetX = tank.x + vec.x * dist;
  const targetY = tank.y + vec.y * dist;

  if (!insideMap(targetX, targetY, TANK_SIZE)) {
    return { x: tank.x, y: tank.y, moved: false };
  }
  if (hitsWall(grid, targetX, targetY, TANK_SIZE)) {
    return { x: tank.x, y: tank.y, moved: false };
  }
  // 坦克之间不可穿透，否则会出现两辆车重叠导致同时被一颗子弹命中
  for (const other of others) {
    if (!other.alive) continue;
    if (aabbOverlap(targetX, targetY, TANK_SIZE, other.x, other.y, TANK_SIZE)) {
      return { x: tank.x, y: tank.y, moved: false };
    }
  }

  return { x: targetX, y: targetY, moved: true };
}

/**
 * 推进子弹一帧。
 *
 * ⚠️ 采用**分步推进**（sub-stepping）而非一次性位移：
 *    子弹速度 360px/s，单帧位移 12px；若目标是 32px 厚的墙尚可，
 *    但一旦调高子弹速度或降低帧率，就会出现"穿墙"（tunneling）。
 *    按不超过半个子弹尺寸的步长细分，从根源上消除此类 bug。
 *
 * @returns {{x, y, hitWall: boolean}}
 */
export function advanceBullet(bullet, dt, speed, grid) {
  const vec = DIR_VEC[bullet.dir];
  if (!vec) return { x: bullet.x, y: bullet.y, hitWall: true };

  const total = speed * dt;
  const maxStep = BULLET_SIZE / 2;
  const steps = Math.max(1, Math.ceil(total / maxStep));
  const stepDist = total / steps;

  let x = bullet.x;
  let y = bullet.y;

  for (let i = 0; i < steps; i++) {
    x += vec.x * stepDist;
    y += vec.y * stepDist;

    if (!insideMap(x, y, BULLET_SIZE) || hitsWall(grid, x, y, BULLET_SIZE)) {
      return { x, y, hitWall: true };
    }
  }

  return { x, y, hitWall: false };
}

/**
 * 找出子弹命中的坦克。
 *
 * 规则（对应 PRD F-2.10）：
 *   - 不伤害发射者
 *   - 不伤害已淘汰者
 *   - 不伤害无敌状态者（复活保护）
 *
 * @param {object} bullet  { x, y, ownerId }
 * @param {Array} tanks    [{ id, x, y, alive, invulnUntil }]
 * @param {number} now     当前时间戳
 * @returns {object|null}  命中的坦克
 */
export function findBulletHit(bullet, tanks, now) {
  for (const tank of tanks) {
    if (tank.id === bullet.ownerId) continue;
    if (!tank.alive) continue;
    if (tank.invulnUntil && now < tank.invulnUntil) continue;

    if (aabbOverlap(bullet.x, bullet.y, BULLET_SIZE, tank.x, tank.y, TANK_SIZE)) {
      return tank;
    }
  }
  return null;
}

/**
 * 计算子弹出生位置：从炮口而非坦克中心射出。
 *
 * 若从中心射出，子弹诞生瞬间就与自身坦克重叠；
 * 虽然 findBulletHit 会跳过发射者，但贴墙射击时子弹会直接生在墙里而立即消失。
 * 偏移到炮口外沿可让贴墙射击行为符合直觉。
 */
export function bulletSpawnPos(tank) {
  const vec = DIR_VEC[tank.dir] ?? DIR_VEC.up;
  const offset = TANK_SIZE / 2 + BULLET_SIZE / 2 + 1;
  return {
    x: tank.x + vec.x * offset,
    y: tank.y + vec.y * offset,
  };
}
