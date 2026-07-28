/**
 * S1.3 移动同步冒烟测试
 *
 * 验证服务端权威移动、碰撞阻挡、双端一致性。
 * 需要服务端已在 localhost:8080 运行。
 *
 *   node scripts/smoke-move.js
 */

import { WebSocket } from 'ws';
import { C2S, S2C, decode, encode } from '../shared/protocol.js';
import { COLS, MAP_H, MAP_W, ROWS, TANK_SIZE, TILE } from '../shared/constants.js';

const URL = process.env.WS_URL || 'ws://localhost:8080/ws';

let pass = 0;
let fail = 0;

function check(desc, ok, detail) {
  if (ok) {
    pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${desc}`);
  } else {
    fail++;
    console.log(`  \x1b[31m✗\x1b[0m ${desc}${detail ? ` → ${detail}` : ''}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.snapshots = [];
    this.map = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL, { origin: 'http://localhost:8080' });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = decode(raw.toString());
        if (!msg) return;
        if (msg.type === S2C.SNAPSHOT) {
          if (msg.map) this.map = msg.map;
          this.snapshots.push(msg);
        }
        this.inbox.push(msg);
      });
    });
  }

  send(type, data) {
    this.ws.send(encode(type, data));
  }

  async wait(type, timeout = 1500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const idx = this.inbox.findIndex((m) => m.type === type);
      if (idx !== -1) return this.inbox.splice(idx, 1)[0];
      await sleep(15);
    }
    return null;
  }

  /** 最新快照 */
  get snap() {
    return this.snapshots[this.snapshots.length - 1] ?? null;
  }

  /** 从最新快照中取指定坦克 */
  tank(id) {
    return this.snap?.tanks?.find((t) => t.id === id) ?? null;
  }

  clearSnaps() {
    this.snapshots = [];
  }

  close() {
    this.ws?.close();
  }
}

async function main() {
  console.log(`\n连接目标：${URL}\n`);

  // ---------- 准备：两名玩家进入同一房间并开局 ----------
  console.log('0. 建立对局');
  const a = new Client('A');
  const b = new Client('B');
  await a.connect();
  a.send(C2S.JOIN, { nickname: '甲' });
  const joinedA = await a.wait(S2C.JOINED);
  const roomId = joinedA.roomId;

  await b.connect();
  b.send(C2S.JOIN, { nickname: '乙', roomId });
  const joinedB = await b.wait(S2C.JOINED);

  const idA = joinedA.selfId;
  const idB = joinedB.selfId;
  check('两名玩家已入房', Boolean(idA && idB));

  a.send(C2S.START, {});
  await sleep(200);
  check('A 收到快照', Boolean(a.snap));
  check('B 收到快照', Boolean(b.snap));

  // ---------- 1. 地图下发 ----------
  console.log('\n1. 地图下发');
  check('A 收到地图', Array.isArray(a.map));
  check('B 收到地图', Array.isArray(b.map));
  check('地图行数正确', a.map?.length === ROWS, String(a.map?.length));
  check('地图列数正确', a.map?.[0]?.length === COLS, String(a.map?.[0]?.length));
  check('双端地图完全一致', JSON.stringify(a.map) === JSON.stringify(b.map));

  // 地图只在首帧下发，后续快照不应重复携带
  const mapRepeats = a.snapshots.filter((s) => s.map).length;
  check('地图仅下发一次', mapRepeats === 1, `出现 ${mapRepeats} 次`);

  // ---------- 2. 出生点合法性 ----------
  console.log('\n2. 出生点');
  const spawnA = a.tank(idA);
  const spawnB = a.tank(idB);
  check('A 坦克存在于快照', Boolean(spawnA));
  check('B 坦克存在于快照', Boolean(spawnB));
  check('两人出生点不同', spawnA?.x !== spawnB?.x || spawnA?.y !== spawnB?.y);
  check('A 初始存活', spawnA?.alive === true);
  check('A 初始满血', spawnA?.hp === 3, String(spawnA?.hp));
  check('开局有无敌保护', spawnA?.inv === 1);

  const half = TANK_SIZE / 2;
  const inBounds = (t) =>
    t.x - half >= 0 && t.y - half >= 0 && t.x + half <= MAP_W && t.y + half <= MAP_H;
  check('A 出生点在地图内', inBounds(spawnA));
  check('B 出生点在地图内', inBounds(spawnB));

  const onWall = (t) => {
    const c0 = Math.floor((t.x - half) / TILE);
    const c1 = Math.floor((t.x + half - 1) / TILE);
    const r0 = Math.floor((t.y - half) / TILE);
    const r1 = Math.floor((t.y + half - 1) / TILE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) if (a.map[r]?.[c] === 1) return true;
    }
    return false;
  };
  check('A 出生点不在墙内', !onWall(spawnA));
  check('B 出生点不在墙内', !onWall(spawnB));

  // ---------- 3. 移动生效 ----------
  console.log('\n3. 移动与双端一致');
  const beforeA = { ...a.tank(idA) };
  a.send(C2S.INPUT, { dir: 'down' });
  await sleep(400);
  a.send(C2S.INPUT, { dir: null });
  await sleep(120);

  const afterA = a.tank(idA);
  check('A 自己看到位置变化', afterA.y > beforeA.y, `${beforeA.y} → ${afterA.y}`);

  const afterAfromB = b.tank(idA);
  check('B 也看到 A 的位置变化', afterAfromB.y > beforeA.y, `${afterAfromB.y}`);
  check(
    '双端 A 坐标一致',
    afterA.x === afterAfromB.x && afterA.y === afterAfromB.y,
    `A端(${afterA.x},${afterA.y}) vs B端(${afterAfromB.x},${afterAfromB.y})`
  );

  // 速度合理性：120px/s × 约 0.4s ≈ 48px，放宽区间避免时序抖动误判
  const moved = afterA.y - beforeA.y;
  check('位移量符合设定速度', moved > 20 && moved < 90, `${moved}px`);

  // ---------- 4. 停止指令生效 ----------
  console.log('\n4. 停止指令');
  const stopped1 = a.tank(idA);
  await sleep(300);
  const stopped2 = a.tank(idA);
  check(
    '发送 dir:null 后坦克静止',
    stopped1.x === stopped2.x && stopped1.y === stopped2.y,
    `(${stopped1.x},${stopped1.y}) → (${stopped2.x},${stopped2.y})`
  );

  // ---------- 5. 朝向更新 ----------
  console.log('\n5. 炮管朝向');
  a.send(C2S.INPUT, { dir: 'right' });
  await sleep(120);
  check('朝向已更新为 right', a.tank(idA)?.dir === 'right', a.tank(idA)?.dir);
  a.send(C2S.INPUT, { dir: null });
  await sleep(80);
  check('停止后朝向保留', a.tank(idA)?.dir === 'right', a.tank(idA)?.dir);

  // ---------- 6. 边界阻挡 ----------
  console.log('\n6. 边界与墙体阻挡');
  // 持续朝左上顶，最终必然被外墙挡住
  a.send(C2S.INPUT, { dir: 'up' });
  await sleep(1600);
  a.send(C2S.INPUT, { dir: null });
  await sleep(120);
  const topPos = a.tank(idA);

  a.send(C2S.INPUT, { dir: 'up' });
  await sleep(600);
  a.send(C2S.INPUT, { dir: null });
  await sleep(120);
  const topPos2 = a.tank(idA);
  check('持续顶墙后坐标不再变化', topPos.y === topPos2.y, `${topPos.y} → ${topPos2.y}`);
  check('未穿透地图上边界', topPos2.y - half >= 0, `y=${topPos2.y}`);
  check('未卡在墙体内', !onWall(topPos2), `(${topPos2.x},${topPos2.y})`);

  // ---------- 7. 非法输入静默忽略 ----------
  console.log('\n7. 非法输入');
  const beforeBad = { ...a.tank(idA) };
  a.send(C2S.INPUT, { dir: 'diagonal' });
  a.send(C2S.INPUT, { dir: 123 });
  await sleep(200);
  const afterBad = a.tank(idA);
  check(
    '非法方向不产生位移',
    beforeBad.x === afterBad.x && beforeBad.y === afterBad.y,
    `(${afterBad.x},${afterBad.y})`
  );
  // 高频消息不应回错误，否则异常客户端会把自己刷爆
  const errAfterBad = await a.wait(S2C.ERROR, 250);
  check('非法方向静默忽略而非回错误', errAfterBad === null);

  // ---------- 8. 坦克间不可穿透 ----------
  console.log('\n8. 坦克互相阻挡');
  // 让 B 停在原地，A 朝 B 方向持续移动，最终应被挡住而非重叠
  const posB = a.tank(idB);
  const posA0 = a.tank(idA);
  // A 在左上，B 在右上：A 向右移动会接近 B
  const dirToB = posB.x > posA0.x ? 'right' : 'left';
  a.send(C2S.INPUT, { dir: dirToB });
  await sleep(2500);
  a.send(C2S.INPUT, { dir: null });
  await sleep(150);

  const finalA = a.tank(idA);
  const finalB = a.tank(idB);
  const overlap =
    Math.abs(finalA.x - finalB.x) < TANK_SIZE && Math.abs(finalA.y - finalB.y) < TANK_SIZE;
  check('两辆坦克未重叠', !overlap, `A(${finalA.x},${finalA.y}) B(${finalB.x},${finalB.y})`);

  // ---------- 9. 快照频率与帧号 ----------
  console.log('\n9. 快照广播');
  a.clearSnaps();
  await sleep(1000);
  const rate = a.snapshots.length;
  // 目标 30Hz，允许时序抖动
  check('广播频率接近 30Hz', rate >= 22 && rate <= 38, `${rate} 帧/秒`);

  const ticks = a.snapshots.map((s) => s.t);
  const monotonic = ticks.every((t, i) => i === 0 || t > ticks[i - 1]);
  check('帧号严格递增', monotonic);
  check('快照含倒计时', typeof a.snap?.timeLeft === 'number', String(a.snap?.timeLeft));
  check('倒计时在递减', a.snap.timeLeft < 180_000, `${a.snap.timeLeft}ms`);

  // ---------- 10. 离开后状态清理 ----------
  console.log('\n10. 玩家离开');
  b.clearSnaps();
  a.close();
  await sleep(400);
  const tanksAfterLeave = b.snap?.tanks ?? [];
  check(
    'A 已从快照中移除',
    !tanksAfterLeave.some((t) => t.id === idA),
    `剩余 ${tanksAfterLeave.length} 辆`
  );

  b.close();
  await sleep(150);

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  通过 \x1b[32m${pass}\x1b[0m · 失败 \x1b[31m${fail}\x1b[0m`);
  console.log(`${'─'.repeat(48)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err.message, err.stack);
  process.exit(1);
});
