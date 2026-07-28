/**
 * 地图生成单元测试
 *
 * 用 node:test 内置框架，零额外依赖，无需启动服务：
 *   npm test
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';

import {
  countTiles,
  createMap,
  damageTile,
  generateSpawnPoints,
  getFallbackSpawnPoints,
  isBlocking,
  isDestructible,
  isFullyConnected,
  validateMap,
} from '../server/map.js';
import {
  BRICK_HP,
  COLS,
  MIN_SPAWN_DISTANCE,
  ROOM_MAX,
  ROWS,
  TANK_SIZE,
  TILE,
  TILE_TYPE,
} from '../shared/constants.js';

/** 固定种子的伪随机数发生器（mulberry32），让随机生成可复现 */
function seeded(seed) {
  return function rng() {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('地图尺寸与常量一致', () => {
  const grid = createMap();
  assert.equal(grid.length, ROWS);
  for (const row of grid) assert.equal(row.length, COLS);
});

test('外围一圈全部为 BORDER 类型', () => {
  const grid = createMap();
  for (let c = 0; c < COLS; c++) {
    assert.equal(grid[0][c], TILE_TYPE.BORDER, `顶边 (${c},0)`);
    assert.equal(grid[ROWS - 1][c], TILE_TYPE.BORDER, `底边 (${c},${ROWS - 1})`);
  }
  for (let r = 0; r < ROWS; r++) {
    assert.equal(grid[r][0], TILE_TYPE.BORDER, `左边 (0,${r})`);
    assert.equal(grid[r][COLS - 1], TILE_TYPE.BORDER, `右边 (${COLS - 1},${r})`);
  }
});

test('边界与内部障碍为不同类型（便于替换美术素材）', () => {
  assert.notEqual(TILE_TYPE.BORDER, TILE_TYPE.BRICK);
  assert.notEqual(TILE_TYPE.BORDER, TILE_TYPE.STEEL);
  assert.notEqual(TILE_TYPE.BRICK, TILE_TYPE.STEEL);

  const grid = createMap(seeded(42));
  const stat = countTiles(grid);
  // 内部不应出现 BORDER 类型
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      assert.notEqual(grid[r][c], TILE_TYPE.BORDER, `内部 (${c},${r}) 不应是 BORDER`);
    }
  }
  assert.ok(stat.brick > 0, '应存在砖墙');
  assert.ok(stat.steel > 0, '应存在钢块');
});

test('内部障碍不含未知类型', () => {
  const known = new Set(Object.values(TILE_TYPE));
  for (let seed = 0; seed < 20; seed++) {
    const grid = createMap(seeded(seed));
    for (const row of grid) {
      for (const tile of row) assert.ok(known.has(tile), `未知图块 ${tile}`);
    }
  }
});

test('障碍比例稳定在设定区间（不会忽空旷忽拥挤）', () => {
  const innerArea = (COLS - 2) * (ROWS - 2);
  const ratios = [];

  for (let seed = 0; seed < 40; seed++) {
    const stat = countTiles(createMap(seeded(seed)));
    ratios.push((stat.brick + stat.steel) / innerArea);
  }

  for (const r of ratios) {
    assert.ok(r > 0.06, `比例过低：${(r * 100).toFixed(1)}%`);
    assert.ok(r < 0.18, `比例过高：${(r * 100).toFixed(1)}%`);
  }

  // 比例的波动幅度不应过大，否则每局手感差异明显
  const spread = Math.max(...ratios) - Math.min(...ratios);
  assert.ok(spread < 0.1, `比例波动过大：${(spread * 100).toFixed(1)}%`);
});

test('每局地图不同（随机生成生效）', () => {
  const maps = [];
  for (let i = 0; i < 12; i++) maps.push(JSON.stringify(createMap()));
  const unique = new Set(maps);
  // 允许极小概率重复，但不应大面积相同
  assert.ok(unique.size >= 10, `12 次生成仅 ${unique.size} 种不同地图`);
});

test('相同种子生成相同地图（可复现）', () => {
  const a = createMap(seeded(7));
  const b = createMap(seeded(7));
  assert.deepEqual(a, b);
});

test('随机出生点不与障碍重叠', () => {
  const half = TANK_SIZE / 2;

  for (let seed = 0; seed < 30; seed++) {
    const rng = seeded(seed);
    const grid = createMap(rng);

    generateSpawnPoints(grid, ROOM_MAX, rng).forEach((p, i) => {
      const c0 = Math.floor((p.x - half) / TILE);
      const c1 = Math.floor((p.x + half - 1) / TILE);
      const r0 = Math.floor((p.y - half) / TILE);
      const r1 = Math.floor((p.y + half - 1) / TILE);

      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
          assert.ok(!isBlocking(grid[r][c]), `seed=${seed} 出生点 ${i} 与障碍重叠于 (${c},${r})`);
        }
      }
    });
  }
});

test('所有出生点互相连通（不会出现孤岛）', () => {
  for (let seed = 0; seed < 50; seed++) {
    const rng = seeded(seed);
    const grid = createMap(rng);
    const spawns = generateSpawnPoints(grid, ROOM_MAX, rng);
    assert.ok(isFullyConnected(grid, spawns), `seed=${seed} 生成了不连通的地图`);
  }
});

test('随机出生点每局不同', () => {
  const sets = new Set();
  for (let i = 0; i < 12; i++) {
    const grid = createMap();
    sets.add(JSON.stringify(generateSpawnPoints(grid, ROOM_MAX)));
  }
  assert.ok(sets.size >= 10, `12 次仅 ${sets.size} 种不同出生点组合`);
});

test('出生点之间保持最小间距', () => {
  for (let seed = 0; seed < 40; seed++) {
    const rng = seeded(seed);
    const grid = createMap(rng);
    const pts = generateSpawnPoints(grid, ROOM_MAX, rng);
    assert.equal(pts.length, ROOM_MAX, `seed=${seed} 出生点数量不足`);

    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y);
        assert.ok(
          d >= MIN_SPAWN_DISTANCE,
          `seed=${seed} 出生点 ${i}/${j} 间距仅 ${d.toFixed(0)}px，低于 ${MIN_SPAWN_DISTANCE}`
        );
      }
    }
  }
});

test('砖墙需 BRICK_HP 次命中才被击破', () => {
  const grid = createMap(seeded(3));
  // 找一块完好砖墙
  let target = null;
  for (let r = 1; r < ROWS - 1 && !target; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (grid[r][c] === TILE_TYPE.BRICK) {
        target = { r, c };
        break;
      }
    }
  }
  assert.ok(target, '地图中应存在砖墙');

  for (let i = 1; i < BRICK_HP; i++) {
    const res = damageTile(grid, target.c, target.r);
    assert.equal(res.changed, true, `第 ${i} 次命中应生效`);
    assert.equal(res.broken, false, `第 ${i} 次命中不应击破`);
    assert.ok(isBlocking(grid[target.r][target.c]), `第 ${i} 次命中后仍应阻挡`);
  }

  const last = damageTile(grid, target.c, target.r);
  assert.equal(last.broken, true, `第 ${BRICK_HP} 次命中应击破`);
  assert.equal(grid[target.r][target.c], TILE_TYPE.EMPTY);
  assert.equal(isBlocking(grid[target.r][target.c]), false, '击破后应可通行');
});

test('钢块与边界不可被击破', () => {
  const grid = createMap(seeded(5));
  // 边界
  const before = grid[0][5];
  const r1 = damageTile(grid, 5, 0);
  assert.equal(r1.changed, false);
  assert.equal(grid[0][5], before);

  // 找一块钢块
  for (let r = 1; r < ROWS - 1; r++) {
    for (let c = 1; c < COLS - 1; c++) {
      if (grid[r][c] === TILE_TYPE.STEEL) {
        const res = damageTile(grid, c, r);
        assert.equal(res.changed, false, '钢块不应被击破');
        assert.equal(grid[r][c], TILE_TYPE.STEEL);
        return;
      }
    }
  }
});

test('isDestructible 只对砖墙成立', () => {
  assert.equal(isDestructible(TILE_TYPE.BRICK), true);
  assert.equal(isDestructible(TILE_TYPE.BRICK_2), true);
  assert.equal(isDestructible(TILE_TYPE.BRICK_1), true);
  assert.equal(isDestructible(TILE_TYPE.STEEL), false);
  assert.equal(isDestructible(TILE_TYPE.BORDER), false);
  assert.equal(isDestructible(TILE_TYPE.EMPTY), false);
});

test('validateMap 对合法地图返回空问题列表', () => {
  for (let seed = 0; seed < 20; seed++) {
    const rng = seeded(seed);
    const grid = createMap(rng);
    const spawns = generateSpawnPoints(grid, ROOM_MAX, rng);
    const problems = validateMap(grid, spawns);
    assert.deepEqual(problems, [], `seed=${seed}: ${problems.join('; ')}`);
  }
});

test('validateMap 能检出被围死的出生点', () => {
  const grid = createMap(seeded(1));
  // 人为把左上出生点四周封死
  const { col, row } = { col: 2, row: 2 };
  for (let r = row - 2; r <= row + 2; r++) {
    for (let c = col - 2; c <= col + 2; c++) {
      if (r === row && c === col) continue;
      if (grid[r]?.[c] !== undefined) grid[r][c] = TILE_TYPE.STEEL;
    }
  }
  const problems = validateMap(grid);
  assert.ok(problems.length > 0, '应检出问题');
});

test('isBlocking 正确区分可通行与阻挡', () => {
  assert.equal(isBlocking(TILE_TYPE.EMPTY), false);
  assert.equal(isBlocking(TILE_TYPE.BORDER), true);
  assert.equal(isBlocking(TILE_TYPE.BRICK), true);
  assert.equal(isBlocking(TILE_TYPE.BRICK_2), true, '破损砖墙仍应阻挡');
  assert.equal(isBlocking(TILE_TYPE.BRICK_1), true, '破损砖墙仍应阻挡');
  assert.equal(isBlocking(TILE_TYPE.STEEL), true);
});

test('坦克碰撞盒小于一格，可穿过单格通道', () => {
  assert.ok(TANK_SIZE < TILE, `TANK_SIZE(${TANK_SIZE}) 必须小于 TILE(${TILE})`);
});
