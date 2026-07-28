/**
 * S1.2 房间逻辑冒烟测试
 *
 * 用真实 WebSocket 客户端模拟多个玩家，验证房间生命周期与边界情况。
 * 需要服务端已在 localhost:8080 运行。
 *
 *   node scripts/smoke-room.js
 *
 * 与 test/ 下的单元测试不同：这里测的是端到端行为，需要真实服务进程。
 */

import { WebSocket } from 'ws';
import { C2S, S2C, encode, decode } from '../shared/protocol.js';

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

/** 一个测试用客户端，把收到的消息按 type 缓存，便于断言 */
class Client {
  constructor(name) {
    this.name = name;
    this.inbox = [];
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(URL, { origin: 'http://localhost:8080' });
      this.ws.on('open', resolve);
      this.ws.on('error', reject);
      this.ws.on('message', (raw) => {
        const msg = decode(raw.toString());
        if (msg) this.inbox.push(msg);
      });
    });
  }

  send(type, data) {
    this.ws.send(encode(type, data));
  }

  /** 等待指定类型的消息到达 */
  async wait(type, timeout = 1000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const idx = this.inbox.findIndex((m) => m.type === type);
      if (idx !== -1) return this.inbox.splice(idx, 1)[0];
      await sleep(20);
    }
    return null;
  }

  /** 取最后一条指定类型的消息（用于取最新房间状态） */
  last(type) {
    return [...this.inbox].reverse().find((m) => m.type === type) ?? null;
  }

  clear() {
    this.inbox = [];
  }

  close() {
    this.ws?.close();
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const HTTP_BASE = URL.replace(/^ws/, 'http').replace(/\/ws$/, '');
const health = () => fetch(`${HTTP_BASE}/healthz`).then((r) => r.json());

async function main() {
  console.log(`\n连接目标：${URL}\n`);

  /**
   * 记录基线。绝不能假设服务端此刻是空的 ——
   * 开着的浏览器标签页也会占用房间，导致断言 rooms===0 失败。
   * 因此所有全局计数断言都测「增量归零」而非「绝对值为零」。
   */
  const base = await health();
  if (base.rooms > 0) {
    console.log(`  \x1b[90m注：已有 ${base.rooms} 个房间 / ${base.players} 名玩家在线，将按增量校验\x1b[0m\n`);
  }

  // ---------- 1. 创建房间 ----------
  console.log('1. 创建房间');
  const a = new Client('A');
  await a.connect();
  a.send(C2S.JOIN, { nickname: '阿尔法' });

  const joined = await a.wait(S2C.JOINED);
  check('收到 joined 消息', Boolean(joined));
  check('分配了 selfId', Boolean(joined?.selfId), joined?.selfId);
  check('房间号为 4 位数字', /^\d{4}$/.test(joined?.roomId ?? ''), joined?.roomId);
  check('创建者为房主', joined?.isHost === true);
  check('分配了颜色', Boolean(joined?.color), joined?.color);

  const roomId = joined.roomId;
  const roomA1 = await a.wait(S2C.ROOM);
  check('收到 room 消息', Boolean(roomA1));
  check('房间内 1 人', roomA1?.players?.length === 1);
  check('阶段为 waiting', roomA1?.phase === 'waiting');

  // ---------- 2. 加入房间 ----------
  console.log('\n2. 第二名玩家加入');
  a.clear();
  const b = new Client('B');
  await b.connect();
  b.send(C2S.JOIN, { nickname: '布拉沃', roomId });

  const joinedB = await b.wait(S2C.JOINED);
  check('B 成功加入', Boolean(joinedB));
  check('B 不是房主', joinedB?.isHost === false);
  check('B 与 A 房间号相同', joinedB?.roomId === roomId);
  check('B 颜色与 A 不同', joinedB?.color !== joined.color, `${joined.color} vs ${joinedB?.color}`);

  const roomA2 = await a.wait(S2C.ROOM);
  check('A 收到房间更新广播', Boolean(roomA2));
  check('A 看到房间内 2 人', roomA2?.players?.length === 2);
  // 用集合比较而非数组：广播顺序不保证，且中文 sort 按 UTF-16 码位排序
  const namesA = new Set(roomA2?.players?.map((p) => p.nickname));
  check(
    'A 看到双方昵称',
    namesA.size === 2 && namesA.has('阿尔法') && namesA.has('布拉沃'),
    [...namesA].join(',')
  );

  // ---------- 3. 非房主不能开局 ----------
  console.log('\n3. 权限校验');
  b.clear();
  b.send(C2S.START, {});
  const errNotHost = await b.wait(S2C.ERROR);
  check('非房主开局被拒', errNotHost?.code === 'NOT_HOST', errNotHost?.code);

  // ---------- 4. 无效输入 ----------
  console.log('\n4. 无效输入校验');
  const c = new Client('C');
  await c.connect();

  c.send(C2S.JOIN, { nickname: '   ' });
  check('空昵称被拒', (await c.wait(S2C.ERROR))?.code === 'BAD_NICKNAME');

  c.clear();
  c.send(C2S.JOIN, { nickname: '测试', roomId: 'abcd' });
  check('非法房间号被拒', (await c.wait(S2C.ERROR))?.code === 'BAD_ROOM_ID');

  c.clear();
  c.send(C2S.JOIN, { nickname: '测试', roomId: '9999' });
  check('不存在的房间被拒', (await c.wait(S2C.ERROR))?.code === 'ROOM_NOT_FOUND');

  c.clear();
  c.send(C2S.JOIN, { nickname: '这个昵称明显超过了十二个字符的限制' });
  check('超长昵称被拒', (await c.wait(S2C.ERROR))?.code === 'BAD_NICKNAME');

  c.clear();
  c.ws.send('这不是合法的 JSON');
  check('畸形消息被拒且服务存活', (await c.wait(S2C.ERROR))?.code === 'BAD_MESSAGE');

  c.clear();
  c.send('unknown_type', {});
  check('未知消息类型被拒', (await c.wait(S2C.ERROR))?.code === 'BAD_MESSAGE');

  // ---------- 5. 房间容量 ----------
  console.log('\n5. 房间容量上限');
  c.clear();
  c.send(C2S.JOIN, { nickname: '查理', roomId });
  check('第 3 人加入成功', Boolean(await c.wait(S2C.JOINED)));

  const d = new Client('D');
  await d.connect();
  d.send(C2S.JOIN, { nickname: '德尔塔', roomId });
  check('第 4 人加入成功', Boolean(await d.wait(S2C.JOINED)));

  const e = new Client('E');
  await e.connect();
  e.send(C2S.JOIN, { nickname: '艾可', roomId });
  check('第 5 人被拒（房间已满）', (await e.wait(S2C.ERROR))?.code === 'ROOM_FULL');

  const roomFull = a.last(S2C.ROOM);
  check('房间人数为 4', roomFull?.players?.length === 4, String(roomFull?.players?.length));
  const slots = roomFull?.players?.map((p) => p.slot).sort();
  check('槽位无重复 0~3', JSON.stringify(slots) === JSON.stringify([0, 1, 2, 3]), String(slots));
  const colors = new Set(roomFull?.players?.map((p) => p.color));
  check('4 人颜色互不相同', colors.size === 4);

  // ---------- 6. 主动离开 ----------
  console.log('\n6. 主动离开');
  a.clear();
  d.send(C2S.LEAVE, {});
  await sleep(150);
  const afterLeave = a.last(S2C.ROOM);
  check('A 感知到 D 离开', afterLeave?.players?.length === 3, String(afterLeave?.players?.length));
  check(
    'D 已不在列表中',
    !afterLeave?.players?.some((p) => p.nickname === '德尔塔')
  );

  // ---------- 7. 断线检测 ----------
  console.log('\n7. 断线自动移除');
  a.clear();
  c.close(); // 模拟关闭浏览器窗口
  await sleep(200);
  const afterDisconnect = a.last(S2C.ROOM);
  check(
    'A 感知到 C 断线',
    afterDisconnect?.players?.length === 2,
    String(afterDisconnect?.players?.length)
  );

  // ---------- 8. 房主移交 ----------
  console.log('\n8. 房主移交');
  b.clear();
  a.close(); // 房主断线
  await sleep(200);
  const afterHostLeft = b.last(S2C.ROOM);
  check('房主离开后房间仍存在', Boolean(afterHostLeft));
  check('房主已移交给 B', afterHostLeft?.hostId === joinedB.selfId, afterHostLeft?.hostId);
  check('房间剩 1 人', afterHostLeft?.players?.length === 1);

  // ---------- 9. 人数不足不能开局 ----------
  console.log('\n9. 人数不足不能开局');
  b.clear();
  b.send(C2S.START, {});
  const errNotEnough = await b.wait(S2C.ERROR);
  check('1 人开局被拒', errNotEnough?.code === 'NOT_ENOUGH_PLAYERS', errNotEnough?.code);

  // ---------- 10. 成功开局 ----------
  console.log('\n10. 成功开局与对局中拒绝加入');
  const f = new Client('F');
  await f.connect();
  f.send(C2S.JOIN, { nickname: '福克斯', roomId });
  await f.wait(S2C.JOINED);

  b.clear();
  b.send(C2S.START, {});
  await sleep(150);
  const playing = b.last(S2C.ROOM);
  // 开局先进入倒计时阶段（3 秒准备期），倒计时结束后才转 playing
  check('阶段切换为 countdown', playing?.phase === 'countdown', playing?.phase);

  const g = new Client('G');
  await g.connect();
  g.send(C2S.JOIN, { nickname: '高尔夫', roomId });
  const joinedG = await g.wait(S2C.JOINED);
  check('对局中以观战者身份加入', joinedG?.spectator === true);
  check('观战者收到当前快照', Boolean(await g.wait(S2C.SNAPSHOT)));

  // ---------- 11. 房间回收 ----------
  console.log('\n11. 房间空置自动回收');
  for (const cl of [b, f, d, e, g]) { cl.send(C2S.LEAVE, {}); cl.close(); }
  await sleep(400);

  const after = await health();
  check(
    '本次创建的房间已被销毁',
    after.rooms === base.rooms,
    `rooms ${base.rooms} → ${after.rooms}`
  );
  check(
    '本次加入的玩家已全部清理',
    after.players === base.players,
    `players ${base.players} → ${after.players}`
  );

  await sleep(100);

  // ---------- 汇总 ----------
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`  通过 \x1b[32m${pass}\x1b[0m · 失败 \x1b[31m${fail}\x1b[0m`);
  console.log(`${'─'.repeat(48)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\n冒烟测试异常：', err.message);
  process.exit(1);
});
