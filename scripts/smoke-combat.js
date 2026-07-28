/**
 * S1.4 战斗闭环冒烟测试
 *
 * 验证射击、命中扣血、淘汰、胜负结算、事件下发。
 * 需要服务端已在 localhost:8080 运行。
 *
 *   node scripts/smoke-combat.js
 */

import { WebSocket } from 'ws';
import { C2S, EVENT_KIND, S2C, decode, encode } from '../shared/protocol.js';
import {
  BLOCKING_TILES,
  COUNTDOWN_MS,
  END_REASON,
  MAX_HP,
  TILE,
  TILE_TYPE,
} from '../shared/constants.js';

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

/**
 * 等待开局倒计时结束。
 *
 * 开局后有 COUNTDOWN_MS 的准备期，期间服务端会拒绝移动与开火 ——
 * 测试必须等它走完，否则所有操作都会被静默丢弃。
 */
async function waitCountdown(client, extra = 150) {
  const deadline = Date.now() + COUNTDOWN_MS + 2000;
  while (Date.now() < deadline) {
    if (client.snap && !(client.snap.cd > 0)) break;
    await sleep(50);
  }
  await sleep(extra);
}


class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
    this.snapshots = [];
    this.events = [];
    this.over = null;
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
        if (msg.type === S2C.EVENT) this.events.push(...(msg.events ?? []));
        if (msg.type === S2C.OVER) this.over = msg;
        this.inbox.push(msg);
      });
    });
  }

  send(type, data) {
    this.ws.send(encode(type, data));
  }

  async wait(type, timeout = 2000) {
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

  /** 只清事件，保留快照。清快照会导致随后 tank() 读到 undefined */
  clearEvents() {
    this.events = [];
  }

  reset() {
    this.snapshots = [];
    this.events = [];
    this.over = null;
  }

  close() {
    this.ws?.close();
  }
}

/** 建立一个 2 人对局，返回 { a, b, idA, idB, roomId } */
async function setupMatch(nickA = '甲', nickB = '乙') {
  const a = new Client('A');
  const b = new Client('B');
  await a.connect();
  a.send(C2S.JOIN, { nickname: nickA });
  const jA = await a.wait(S2C.JOINED);

  await b.connect();
  b.send(C2S.JOIN, { nickname: nickB, roomId: jA.roomId });
  const jB = await b.wait(S2C.JOINED);

  a.send(C2S.START, {});
  await sleep(250);
  // 等倒计时结束，否则后续所有操作都会被服务端拒绝
  await waitCountdown(a);

  return { a, b, idA: jA.selfId, idB: jB.selfId, roomId: jA.roomId };
}

/**
 * 让 shooter 淘汰 target。
 *
 * ⚠️ 本测试须在空旷地图下运行（TANK_EMPTY_MAP=1，见 package.json）。
 *
 *    原因：随机地图会在两车之间插入掩体，导致测试脚本必须实现 AI 寻路
 *    才能命中对手 —— 那考察的是脚本寻路能力，而非"射击→命中→淘汰→结算"
 *    这条真正要验证的链路。曾尝试贪心移动与 BFS 寻路，均因坦克在格子边缘
 *    抖动而超时（实测 20s 仅推进 670px）。
 *
 *    地图随机性由 test/map.test.js 以 50 个种子独立覆盖，不会漏测。
 *
 * 策略：靶子朝射手直线靠近，射手对准开火。空旷地图下必然命中。
 */
async function shootUntilDead(shooter, target, shooterId, targetId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const me = shooter.tank(shooterId);
    const foe = shooter.tank(targetId);
    if (!foe || !foe.alive) return true;
    if (!me || !me.alive) return false;

    const dx = foe.x - me.x;
    const dy = foe.y - me.y;

    // 先在竖直方向对齐，再水平推进 —— 保证子弹沿轴线飞行
    if (Math.abs(dy) > 10) {
      target.send(C2S.INPUT, { dir: dy > 0 ? 'up' : 'down' });
      await sleep(90);
      continue;
    }
    target.send(C2S.INPUT, { dir: null });

    const aimDir = dx > 0 ? 'right' : 'left';
    shooter.send(C2S.INPUT, { dir: aimDir });
    await sleep(40);
    shooter.send(C2S.INPUT, { dir: null });
    shooter.send(C2S.FIRE, {});
    await sleep(110);
  }

  target.send(C2S.INPUT, { dir: null });
  return false;
}

async function main() {
  console.log(`\n连接目标：${URL}\n`);

  // ================= 1. 射击基础 =================
  console.log('1. 射击与冷却');
  {
    const { a, b, idA, idB } = await setupMatch();

    a.clearEvents();
    const snapsBefore = a.snapshots.length;
    a.send(C2S.FIRE, {});
    await sleep(120);

    const bulletsSeen = a.snapshots.some((s) => (s.bullets?.length ?? 0) > 0);
    check('射击后快照中出现子弹', bulletsSeen);
    check('B 也能看到子弹', b.snapshots.some((s) => (s.bullets?.length ?? 0) > 0));
    check('产生 fire 事件', a.evts(EVENT_KIND.FIRE).length >= 1);

    // 冷却 300ms：先等上一发的冷却彻底过去，再测连发
    await sleep(350);
    a.clearEvents();
    for (let i = 0; i < 5; i++) {
      a.send(C2S.FIRE, {});
      await sleep(10);
    }
    await sleep(150);
    const fires = a.evts(EVENT_KIND.FIRE).length;
    check('射击冷却生效（连发 5 次仅 1 发）', fires === 1, `实际 ${fires} 发`);

    await sleep(350);
    a.clearEvents();
    a.send(C2S.FIRE, {});
    await sleep(120);
    check('冷却结束后可再次射击', a.evts(EVENT_KIND.FIRE).length === 1);

    a.close();
    b.close();
    await sleep(120);
  }

  // ================= 2. 命中与淘汰 =================
  console.log('\n2. 命中扣血与淘汰');
  {
    const { a, b, idA, idB } = await setupMatch('射手', '靶子');

    // 无敌期从倒计时结束时开始计（RESPAWN_INVULN_MS），需等它走完才能扣血
    await sleep(2100);

    const hpBefore = a.tank(idB)?.hp;
    check('目标初始满血', hpBefore === MAX_HP, String(hpBefore));

    // 只清事件，保留快照 —— 否则随后 tank() 会读到 undefined
    a.clearEvents();
    b.clearEvents();

    const killed = await shootUntilDead(a, b, idA, idB);
    check('目标最终被淘汰', killed);

    const hits = a.evts(EVENT_KIND.HIT).filter((e) => !e.wall);
    check('产生命中事件', hits.length >= 1, `${hits.length} 次`);
    check('命中事件含攻击者昵称', hits[0]?.actor === '射手', hits[0]?.actor);
    check('命中事件含目标昵称', hits[0]?.target === '靶子', hits[0]?.target);
    check('命中事件含剩余血量', typeof hits[0]?.hp === 'number', String(hits[0]?.hp));

    const kills = a.evts(EVENT_KIND.KILL);
    check('产生击杀事件', kills.length === 1, `${kills.length} 次`);
    check('击杀事件归属正确', kills[0]?.actor === '射手' && kills[0]?.target === '靶子');

    // 双端一致性：这是最关键的断言
    check('A 端记录了 over', Boolean(a.over));
    check('B 端记录了 over', Boolean(b.over));
    check(
      '双端胜者一致',
      a.over?.winnerId === b.over?.winnerId,
      `${a.over?.winnerId} vs ${b.over?.winnerId}`
    );
    check('胜者为射手', a.over?.winnerId === idA, a.over?.winnerName);
    check('结束原因为仅剩一人', a.over?.reason === END_REASON.LAST_SURVIVOR, a.over?.reason);
    check(
      '双端结束原因一致',
      a.over?.reason === b.over?.reason,
      `${a.over?.reason} vs ${b.over?.reason}`
    );

    const scoreA = a.over?.scores?.find((s) => s.id === idA);
    const scoreB = a.over?.scores?.find((s) => s.id === idB);
    check('射手击杀数为 1', scoreA?.kills === 1, String(scoreA?.kills));
    check('靶子已淘汰', scoreB?.alive === false);
    check('靶子血量归零', scoreB?.hp === 0, String(scoreB?.hp));
    check(
      '双端计分板完全一致',
      JSON.stringify(a.over?.scores) === JSON.stringify(b.over?.scores)
    );

    a.close();
    b.close();
    await sleep(120);
  }

  // ================= 3. 不自伤 / 无敌保护 =================
  console.log('\n3. 不自伤与无敌保护');
  {
    const { a, b, idA, idB } = await setupMatch();

    // 无敌期内射击对方，不应扣血。
    // 无敌期仅 2s，且随机地图下不保证能立刻命中，
    // 因此这里只断言"未掉血"，不断言"必定命中"
    a.clearEvents();
    await shootUntilDead(a, b, idA, idB, 1200);
    const hpDuringInv = a.tank(idB)?.hp;
    check('无敌期内目标不掉血', hpDuringInv === MAX_HP, String(hpDuringInv));

    // 自己的血量始终不因自己射击而变化
    check('射击者未自伤', a.tank(idA)?.hp === MAX_HP, String(a.tank(idA)?.hp));

    a.close();
    b.close();
    await sleep(120);
  }

  // ================= 4. 对手退出 → 剩余者获胜 =================
  console.log('\n4. 对手中途退出');
  {
    const { a, b, idA, idB } = await setupMatch();
    a.clearEvents();
    a.over = null;

    b.send(C2S.LEAVE, {});
    await sleep(300);

    check('A 收到 over', Boolean(a.over));
    check('A 被判获胜', a.over?.winnerId === idA, a.over?.winnerName);
    check('原因为仅剩一人', a.over?.reason === END_REASON.LAST_SURVIVOR, a.over?.reason);

    const leaveEv = a.evts(EVENT_KIND.LEAVE);
    check('产生离开事件', leaveEv.length >= 1);

    a.close();
    await sleep(120);
  }

  // ================= 5. 对手掉线 → 剩余者获胜 =================
  console.log('\n5. 对手掉线');
  {
    const { a, b, idA } = await setupMatch();
    a.clearEvents();
    a.over = null;

    b.close(); // 模拟关闭浏览器
    await sleep(400);

    check('A 收到 over', Boolean(a.over));
    check('A 被判获胜', a.over?.winnerId === idA);
    const leaveEv = a.evts(EVENT_KIND.LEAVE);
    check('离开事件标记为掉线', leaveEv.some((e) => e.reason === 'disconnect'));

    a.close();
    await sleep(120);
  }

  // ================= 6. 结束后状态 =================
  console.log('\n6. 结束后行为');
  {
    const { a, b, idA, idB } = await setupMatch();
    // 先跑一会儿累积帧号，否则测不出"换局帧号回退"这个 bug
    await sleep(700);
    const lastSnapBefore = a.snapshots[a.snapshots.length - 1];
    const lastTickBefore = lastSnapBefore?.t ?? 0;
    const matchIdBefore = lastSnapBefore?.m ?? 0;
    check('换局前已有帧号累积', lastTickBefore > 10, `t=${lastTickBefore}`);

    b.send(C2S.LEAVE, {});
    await sleep(300);

    const room = await (async () => {
      // 取最近一条 room 消息
      const rooms = a.inbox.filter((m) => m.type === S2C.ROOM);
      return rooms[rooms.length - 1] ?? null;
    })();
    check('房间阶段变为 over', room?.phase === 'over', room?.phase);

    // 结束后射击不应再产生子弹
    a.reset();
    a.send(C2S.FIRE, {});
    a.send(C2S.INPUT, { dir: 'down' });
    await sleep(250);
    check('结束后不再广播快照', a.snapshots.length === 0, `${a.snapshots.length} 帧`);
    check('结束后射击无效', a.evts(EVENT_KIND.FIRE).length === 0);

    // 补一人后可开新局
    const c = new Client('C');
    await c.connect();
    c.send(C2S.JOIN, { nickname: '丙', roomId: room.roomId });
    check('结束后允许新玩家加入', Boolean(await c.wait(S2C.JOINED)));

    a.reset();
    a.send(C2S.START, {});
    await sleep(300);
    check('可以开始新一局', a.snapshots.length > 0, `${a.snapshots.length} 帧`);
    const freshA = a.tank(idA);
    check('新局血量已重置', freshA?.hp === MAX_HP, String(freshA?.hp));
    check('新局玩家复活', freshA?.alive === true);

    // ---- 回归：换局后帧号必须单调递增 ----
    // 曾因 startGame 把 tick 重置为 0，导致客户端防乱序逻辑
    // （t < 上一帧则丢弃）把新局前 N 帧全部丢掉，
    // 表现为"点了再来一局要等很久才开始"，等待时长≈上一局时长。
    const firstNew = a.snapshots[0];
    check('新局帧号未回退', firstNew?.t > lastTickBefore, `${lastTickBefore} → ${firstNew?.t}`);
    check('matchId 已递增', firstNew?.m > matchIdBefore, `${matchIdBefore} → ${firstNew?.m}`);

    const ticks = a.snapshots.map((s) => s.t);
    check('新局帧号严格递增', ticks.every((t, i) => i === 0 || t > ticks[i - 1]));

    // 复刻客户端防乱序判断，确认不会丢帧
    let prev = null;
    let dropped = 0;
    for (const snap of a.snapshots) {
      const sameMatch = prev && (prev.m ?? 0) === (snap.m ?? 0);
      if (sameMatch && snap.t < prev.t) {
        dropped++;
        continue;
      }
      prev = snap;
    }
    check('客户端防乱序逻辑不会丢帧', dropped === 0, `丢弃 ${dropped} 帧`);

    a.close();
    b.close();
    c.close();
    await sleep(150);
  }

  // ================= 7. 时限到 =================
  console.log('\n7. 时限结束（需 MATCH_DURATION_MS 较短才验证，此处仅验证倒计时递减）');
  {
    const { a, b } = await setupMatch();
    await sleep(200);
    const t1 = a.snap?.timeLeft;
    await sleep(600);
    const t2 = a.snap?.timeLeft;
    check('倒计时递减', t2 < t1, `${t1} → ${t2}`);
    check('倒计时不为负', t2 >= 0, String(t2));

    a.close();
    b.close();
    await sleep(120);
  }


  // ================= 8. 砖墙可击破 =================
  console.log('\n8. 砖墙可击破');
  {
    // 本项需要砖墙，空旷地图下无从验证。
    // 由 scripts/smoke-brick.js 在随机地图模式下单独覆盖
    if (process.env.TANK_EMPTY_MAP === '1') {
      console.log('  (空旷地图模式下无砖墙，由 smoke-brick 覆盖)');
    } else {
      const { a, b, idA } = await setupMatch('工兵', '旁观');
      const map = a.map;

      // 找一块与自己同行、右侧最近的砖墙
      const me = a.tank(idA);
      const row = Math.floor(me.y / TILE);
      let brickCol = -1;
      for (let c = Math.floor(me.x / TILE) + 1; c < map[row].length; c++) {
        const t = map[row][c];
        if (t === TILE_TYPE.BRICK) { brickCol = c; break; }
        if (BLOCKING_TILES.has(t)) break; // 遇到钢块/边界则放弃
      }

      if (brickCol < 0) {
        console.log('  (本局同行无砖墙，本项由 smoke-brick 覆盖)');
      } else {
        a.send(C2S.INPUT, { dir: 'right' });
        await sleep(60);
        a.send(C2S.INPUT, { dir: null });

        a.clearEvents();
        let broke = false;
        const patches = [];
        for (let i = 0; i < 12 && !broke; i++) {
          a.send(C2S.FIRE, {});
          await sleep(360);
          for (const snap of a.snapshots) {
            if (snap.mp) patches.push(...snap.mp);
          }
          broke = patches.some((p) => p.c === brickCol && p.r === row && p.v === TILE_TYPE.EMPTY);
        }

        const breakEvents = a.evts(EVENT_KIND.BRICK_BREAK);
        check('产生砖墙受损事件', breakEvents.length >= 1, `${breakEvents.length} 次`);
        check('事件含剩余耐久', breakEvents.some((e) => typeof e.hp === 'number'));
        check('砖墙最终被击破', broke, `补丁 ${patches.length} 条`);
        check('下发了地图增量', patches.length >= 1, `${patches.length} 条`);

        // 双端地图必须一致，否则一方能过另一方过不去
        const patchesB = [];
        for (const snap of b.snapshots) if (snap.mp) patchesB.push(...snap.mp);
        check('双端收到相同地图增量', patchesB.length === patches.length, `A${patches.length} B${patchesB.length}`);
      }

      a.close();
      b.close();
      await sleep(150);
    }
  }

  // ================= 9. 坦克相撞伤害 =================
  console.log('\n9. 坦克相撞伤害');
  {
    const { a, b, idA, idB } = await setupMatch('甲车', '乙车');
    // 等无敌期结束，否则相撞不扣血
    await sleep(2100);

    const hpA0 = a.tank(idA)?.hp;
    const hpB0 = a.tank(idB)?.hp;
    check('相撞前双方满血', hpA0 === MAX_HP && hpB0 === MAX_HP, `${hpA0}/${hpB0}`);

    a.clearEvents();

    // 两车相向而行直到相撞。
    // ⚠️ 方向必须每轮按**实时坐标**重算：
    //    出生点随机，一次性算出的方向可能让两车背向而行，
    //    各自撞到边界后彼此静止不动（实测踩过：20 秒间距反而拉大到 871px）。
    let ramSeen = false;
    for (let i = 0; i < 120; i++) {
      const A = a.tank(idA);
      const B = a.tank(idB);
      if (!A?.alive || !B?.alive) break;
      if (a.evts(EVENT_KIND.RAM).length > 0) {
        ramSeen = true;
        break;
      }

      const dx = B.x - A.x;
      const dy = B.y - A.y;
      // 先消除较大的那个轴的差距，双方同时朝对方靠拢
      if (Math.abs(dy) > 12) {
        a.send(C2S.INPUT, { dir: dy > 0 ? 'down' : 'up' });
        b.send(C2S.INPUT, { dir: dy > 0 ? 'up' : 'down' });
      } else {
        a.send(C2S.INPUT, { dir: dx > 0 ? 'right' : 'left' });
        b.send(C2S.INPUT, { dir: dx > 0 ? 'left' : 'right' });
      }
      await sleep(120);
    }
    a.send(C2S.INPUT, { dir: null });
    b.send(C2S.INPUT, { dir: null });
    await sleep(200);

    check('产生相撞事件', ramSeen, `${a.evts(EVENT_KIND.RAM).length} 次`);

    const ramHits = a.evts(EVENT_KIND.HIT).filter((e) => e.ram);
    check('相撞产生伤害事件', ramHits.length >= 1, `${ramHits.length} 次`);
    // 双方都应扣血 —— 撞人者不占便宜
    const victims = new Set(ramHits.map((e) => e.targetId));
    check('双方同时扣血', victims.size === 2, `受伤方 ${victims.size} 人`);

    const hpA1 = a.tank(idA)?.hp ?? 0;
    const hpB1 = a.tank(idB)?.hp ?? 0;
    check('A 血量下降', hpA1 < hpA0, `${hpA0} → ${hpA1}`);
    check('B 血量下降', hpB1 < hpB0, `${hpB0} → ${hpB1}`);

    // 冷却生效：贴在一起也不会瞬间掉光血
    check('相撞伤害有冷却（未瞬间清零）', hpA1 > 0 || hpB1 > 0, `${hpA1}/${hpB1}`);

    // 双端血量必须一致
    check(
      '双端血量一致',
      b.tank(idA)?.hp === hpA1 && b.tank(idB)?.hp === hpB1,
      `B端 ${b.tank(idA)?.hp}/${b.tank(idB)?.hp}`
    );

    a.close();
    b.close();
    await sleep(150);
  }

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  通过 \x1b[32m${pass}\x1b[0m · 失败 \x1b[31m${fail}\x1b[0m`);
  console.log(`${'─'.repeat(48)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err.message, err.stack);
  process.exit(1);
});
