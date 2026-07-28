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
import { END_REASON, MAX_HP } from '../shared/constants.js';

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

    // 等无敌期结束（2s），否则打不掉血
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

  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  通过 \x1b[32m${pass}\x1b[0m · 失败 \x1b[31m${fail}\x1b[0m`);
  console.log(`${'─'.repeat(48)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err.message, err.stack);
  process.exit(1);
});
