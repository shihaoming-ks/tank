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
        if (msg.type === S2C.SNAPSHOT) this.snapshots.push(msg);
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
 * 让 shooter 面向 target 并持续射击，直到 target 被淘汰或超时。
 * 两人分别在左上、右上角，故 A 朝右、B 朝左即可互指。
 */
async function shootUntilDead(shooter, shooterId, targetId, dir, timeoutMs = 12000) {
  // 先转向目标
  shooter.send(C2S.INPUT, { dir });
  await sleep(60);
  shooter.send(C2S.INPUT, { dir: null });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const t = shooter.tank(targetId);
    if (!t || !t.alive) return true;
    shooter.send(C2S.FIRE, {});
    await sleep(120);
  }
  return false;
}

async function main() {
  console.log(`\n连接目标：${URL}\n`);

  // ================= 1. 射击基础 =================
  console.log('1. 射击与冷却');
  {
    const { a, b, idA, idB } = await setupMatch();

    a.reset();
    a.send(C2S.FIRE, {});
    await sleep(120);

    const bulletsSeen = a.snapshots.some((s) => (s.bullets?.length ?? 0) > 0);
    check('射击后快照中出现子弹', bulletsSeen);
    check('B 也能看到子弹', b.snapshots.some((s) => (s.bullets?.length ?? 0) > 0));
    check('产生 fire 事件', a.evts(EVENT_KIND.FIRE).length >= 1);

    // 冷却 300ms：先等上一发的冷却彻底过去，再测连发
    await sleep(350);
    a.reset();
    for (let i = 0; i < 5; i++) {
      a.send(C2S.FIRE, {});
      await sleep(10);
    }
    await sleep(150);
    const fires = a.evts(EVENT_KIND.FIRE).length;
    check('射击冷却生效（连发 5 次仅 1 发）', fires === 1, `实际 ${fires} 发`);

    await sleep(350);
    a.reset();
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

    // 先读血量再清事件：reset() 会清空快照，立即读 snap 会得到 null
    const hpBefore = a.tank(idB)?.hp;
    check('目标初始满血', hpBefore === MAX_HP, String(hpBefore));

    a.reset();
    b.reset();

    const killed = await shootUntilDead(a, idA, idB, 'right');
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

    // 无敌期内射击对方，不应扣血
    a.reset();
    await shootUntilDead(a, idA, idB, 'right', 1200);
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
    a.reset();

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
    a.reset();

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
