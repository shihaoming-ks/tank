import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  aabbOverlap,
  advanceBullet,
  bulletSpawnPos,
  findBulletHit,
  findTankCollisions,
  firstBlockingCell,
  hitsWall,
  insideMap,
  tryMoveTank,
} from '../server/physics.js';
import { DIR, MAP_H, MAP_W, TANK_SIZE, TILE, TILE_TYPE } from '../shared/constants.js';

const grid = (rows = 20, cols = 30) => Array.from({ length: rows }, () => Array(cols).fill(TILE_TYPE.EMPTY));
const tank = (overrides = {}) => ({ id: 't', x: 80, y: 80, alive: true, ...overrides });

test('insideMap 与 hitsWall 正确处理边界和阻挡格', () => {
  const map = grid();
  map[3][3] = TILE_TYPE.STEEL;
  assert.equal(insideMap(TANK_SIZE / 2, TANK_SIZE / 2, TANK_SIZE), true);
  assert.equal(insideMap(TANK_SIZE / 2 - 1, 50, TANK_SIZE), false);
  assert.equal(insideMap(MAP_W - TANK_SIZE / 2 + 1, 50, TANK_SIZE), false);
  assert.equal(insideMap(50, MAP_H - TANK_SIZE / 2 + 1, TANK_SIZE), false);
  assert.equal(hitsWall(map, 3 * TILE + TILE / 2, 3 * TILE + TILE / 2, TANK_SIZE), true);
  assert.equal(hitsWall(map, 80, 80, TANK_SIZE), false);
});

test('AABB 仅在实体实际重叠时为真', () => {
  assert.equal(aabbOverlap(0, 0, 10, 9, 0, 10), true);
  assert.equal(aabbOverlap(0, 0, 10, 10, 0, 10), false);
});

test('tryMoveTank 拦截墙、越界和其它存活坦克', () => {
  const map = grid();
  map[2][3] = TILE_TYPE.BRICK;
  const start = tank({ x: 80, y: 80 });
  assert.deepEqual(tryMoveTank(start, DIR.RIGHT, 1, 32, map), { x: 80, y: 80, moved: false });
  assert.equal(tryMoveTank(start, DIR.LEFT, 10, 32, map).moved, false);
  assert.equal(tryMoveTank(start, DIR.DOWN, 0.5, 32, map, [tank({ id: 'other', x: 80, y: 96 })]).moved, false);
  const moved = tryMoveTank(start, DIR.DOWN, 0.25, 32, map);
  assert.equal(moved.moved, true);
  assert.equal(moved.y, 88);
});

test('advanceBullet 子步进命中墙并返回阻挡格', () => {
  const map = grid();
  map[2][5] = TILE_TYPE.BRICK;
  const hit = advanceBullet({ x: 4 * TILE + 16, y: 2 * TILE + 16, dir: DIR.RIGHT }, 1, 120, map);
  assert.equal(hit.hitWall, true);
  assert.equal(hit.col, 5);
  assert.equal(hit.row, 2);
  assert.deepEqual(firstBlockingCell(map, 5 * TILE + 16, 2 * TILE + 16, 6), { col: 5, row: 2 });
});

test('findBulletHit 排除自身、死亡和无敌目标', () => {
  const bullet = { x: 100, y: 100, ownerId: 'a' };
  const self = tank({ id: 'a', x: 100, y: 100 });
  const dead = tank({ id: 'dead', x: 100, y: 100, alive: false });
  const inv = tank({ id: 'inv', x: 100, y: 100, invulnUntil: 200 });
  const victim = tank({ id: 'b', x: 100, y: 100 });
  assert.equal(findBulletHit(bullet, [self, dead, inv], 100), null);
  assert.equal(findBulletHit(bullet, [self, victim], 100), victim);
});

test('findTankCollisions 只返回存活且处于容差范围内的配对', () => {
  const a = tank({ id: 'a', x: 100, y: 100 });
  const b = tank({ id: 'b', x: 130, y: 100 });
  const dead = tank({ id: 'dead', x: 100, y: 100, alive: false });
  assert.deepEqual(findTankCollisions([a, b, dead]), [[a, b]]);
});

test('bulletSpawnPos 从炮口外侧生成子弹', () => {
  const pos = bulletSpawnPos(tank({ x: 100, y: 100, dir: DIR.RIGHT }));
  assert.ok(pos.x > 100 + TANK_SIZE / 2);
  assert.equal(pos.y, 100);
});
