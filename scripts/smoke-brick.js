#!/usr/bin/env node
/**
 * 砖墙可击破冒烟测试
 *
 * 需在**随机地图模式**下运行（空旷地图无砖墙）：
 *   npm run dev  &&  node scripts/smoke-brick.js
 *
 * 为何独立成文件：
 *   smoke-combat 必须跑空旷地图（否则掩体会让测试脚本需要 AI 寻路），
 *   而砖墙测试恰恰需要砖墙 —— 两者地图要求互斥，合在一处必然有一方被跳过。
 */

import { WebSocket } from 'ws';
import { C2S, EVENT_KIND, S2C, decode, encode } from '../shared/protocol.js';
import { BLOCKING_TILES, BRICK_HP, COUNTDOWN_MS, TILE, TILE_TYPE } from '../shared/constants.js';

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
    this.events = [];
    this.patches = [];
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
          if (msg.mp) this.patches.push(...msg.mp);
          this.snapshots.push(msg);
        }
        if (msg.type === S2C.EVENT) this.events.push(...(msg.events ?? []));
        this.inbox.push(msg);
      });
    });
  }

  send(type, data) {
    this.ws.send(encode(type, data));
  }

  async wait(type, timeout = 2500) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const idx = this.inbox.findIndex((m) => m.type === type);
      if (idx !== -1) return this.inbox.splice(idx, 1)[0];
      await sleep(15);
    }
    return null;
  }

  get snap() {
    return this.snapshots[this.snapshots.length - 1] ?? null;
  }

  tank(id) {
    return this.snap?.tanks?.find((t) => t.id === id) ?? null;
  }

  evts(kind) {
    return this.events.filter((e) => e.kind === kind);
  }

  close() {
    this.ws?.close();
  }
}

/** 等开局倒计时走完，否则所有操作会被服务端拒绝 */
async function waitCountdown(client) {
  const deadline = Date.now() + COUNTDOWN_MS + 2000;
  while (Date.now() < deadline) {
    if (client.snap && !(client.snap.cd > 0)) break;
    await sleep(50);
  }
  await sleep(150);
}

/**
 * 在坦克正前方找一块可击破的砖墙。
 *
 * 逐格向前扫描：遇到砖墙则返回；遇到钢块或边界则说明前方被硬物挡住，
 * 换个方向再试。
 */
function findBrickAhead(map, tank, dir) {
  const step = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  let c = Math.floor(tank.x / TILE);
  let r = Math.floor(tank.y / TILE);

  for (let i = 0; i < 30; i++) {
    c += step[0];
    r += step[1];
    const t = map[r]?.[c];
    if (t === undefined) return null;
    if (t === TILE_TYPE.BRICK) return { col: c, row: r };
    if (BLOCKING_TILES.has(t)) return null; // 钢块/边界，此方向不可用
  }
  return null;
}

async function main() {
  console.log(`\n连接目标：${URL}\n`);

  console.log('0. 建立对局');
  const a = new Client('A');
  const b = new Client('B');
  await a.connect();
  a.send(C2S.JOIN, { nickname: '工兵' });
  const jA = await a.wait(S2C.JOINED);
  await b.connect();
  b.send(C2S.JOIN, { nickname: '观察员', roomId: jA.roomId });
  const jB = await b.wait(S2C.JOINED);
  const idA = jA.selfId;
  check('两名玩家已入房', Boolean(idA && jB.selfId));

  a.send(C2S.START, {});
  await sleep(250);
  await waitCountdown(a);
  check('地图已下发', Array.isArray(a.map));

  // ---------- 1. 地图中存在可击破砖墙 ----------
  console.log('\n1. 砖墙存在性');
  let brickTotal = 0;
  let steelTotal = 0;
  for (const row of a.map) {
    for (const t of row) {
      if (t === TILE_TYPE.BRICK) brickTotal++;
      else if (t === TILE_TYPE.STEEL) steelTotal++;
    }
  }
  check('地图中存在砖墙', brickTotal > 0, `${brickTotal} 格`);
  check('地图中存在钢块', steelTotal > 0, `${steelTotal} 格`);

  // ---------- 2. 找一个能打到砖墙的方向 ----------
  console.log('\n2. 定位目标砖墙');
  const me = a.tank(idA);
  let target = null;
  let aimDir = null;
  for (const dir of ['right', 'left', 'down', 'up']) {
    const t = findBrickAhead(a.map, me, dir);
    if (t) {
      target = t;
      aimDir = dir;
      break;
    }
  }
  if (target) check('找到正前方的砖墙', true, `方向 ${aimDir}`);

  if (!target) {
    console.log('\n  本局出生位置四向均无砖墙，跳过后续断言');
    a.close();
    b.close();
    await sleep(150);
    report();
    return;
  }

  // 转向目标
  a.send(C2S.INPUT, { dir: aimDir });
  await sleep(60);
  a.send(C2S.INPUT, { dir: null });
  await sleep(80);

  // ---------- 3. 逐发击打，验证耐久递减 ----------
  console.log('\n3. 耐久递减与击破');
  a.events = [];
  a.patches = [];

  const tileOf = () => a.map[target.row][target.col];
  const seenHp = [];
  let broken = false;

  for (let shot = 1; shot <= BRICK_HP + 3 && !broken; shot++) {
    a.send(C2S.FIRE, {});
    await sleep(400);

    // 应用服务端下发的增量，与客户端逻辑一致
    for (const p of a.patches.splice(0)) {
      if (a.map[p.r]) a.map[p.r][p.c] = p.v;
    }

    const brickEvents = a.evts(EVENT_KIND.BRICK_BREAK);
    const last = brickEvents[brickEvents.length - 1];
    if (last && typeof last.hp === 'number') seenHp.push(last.hp);
    if (tileOf() === TILE_TYPE.EMPTY) broken = true;
  }

  check('产生砖墙受损事件', a.evts(EVENT_KIND.BRICK_BREAK).length >= 1, `${a.evts(EVENT_KIND.BRICK_BREAK).length} 次`);
  check('事件携带剩余耐久', seenHp.length >= 1, `观测到 ${JSON.stringify(seenHp)}`);
  check('耐久单调递减', seenHp.every((v, i) => i === 0 || v <= seenHp[i - 1]), JSON.stringify(seenHp));
  check('砖墙最终被击破', broken, `当前值 ${tileOf()}`);
  check('击破后变为空地', tileOf() === TILE_TYPE.EMPTY, String(tileOf()));

  const breakEv = a.evts(EVENT_KIND.BRICK_BREAK).find((e) => e.broken);
  check('存在标记 broken 的事件', Boolean(breakEv));

  // ---------- 4. 双端地图一致 ----------
  console.log('\n4. 双端一致性');
  for (const p of b.patches.splice(0)) {
    if (b.map[p.r]) b.map[p.r][p.c] = p.v;
  }
  check(
    '双端该格状态一致',
    b.map[target.row][target.col] === a.map[target.row][target.col],
    `A=${a.map[target.row][target.col]} B=${b.map[target.row][target.col]}`
  );
  check('双端整张地图一致', JSON.stringify(a.map) === JSON.stringify(b.map));

  // ---------- 5. 击破后可通行 ----------
  console.log('\n5. 击破后可通行');
  const before = a.tank(idA);
  a.send(C2S.INPUT, { dir: aimDir });
  await sleep(1400);
  a.send(C2S.INPUT, { dir: null });
  await sleep(150);
  const after = a.tank(idA);

  const movedDist = Math.hypot(after.x - before.x, after.y - before.y);
  check('坦克能穿过被击破的位置', movedDist > 20, `位移 ${movedDist.toFixed(0)}px`);

  a.close();
  b.close();
  await sleep(150);
  report();
}

function report() {
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  通过 \x1b[32m${pass}\x1b[0m · 失败 \x1b[31m${fail}\x1b[0m`);
  console.log(`${'─'.repeat(48)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err.message, err.stack);
  process.exit(1);
});
