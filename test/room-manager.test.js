/**
 * RoomManager 单元测试
 *
 * 重点覆盖**重连凭证（resumeToken）的生命周期**。
 * 这类"Map 只增不减"的缺陷不会让任何功能出错，
 * 因此不可能被冒烟测试发现 —— 只能靠直接断言容器大小。
 */

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { RoomManager } from '../server/RoomManager.js';
import { C2S, S2C, decode } from '../shared/protocol.js';
import { PHASE, ROOM_MAX } from '../shared/constants.js';

/** 最小可用的假连接：只记录收到的消息 */
function fakeWs() {
  const ws = {
    sent: [],
    send(raw) {
      ws.sent.push(decode(raw));
    },
    /** 取最近一条指定类型的消息 */
    last(type) {
      return [...ws.sent].reverse().find((m) => m?.type === type) ?? null;
    },
  };
  return ws;
}

/** 建房并返回 { ws, roomId, selfId, resumeToken } */
function join(rm, nickname, roomId) {
  const ws = fakeWs();
  rm.handleMessage(ws, { type: C2S.JOIN, nickname, roomId });
  const joined = ws.last(S2C.JOINED);
  return {
    ws,
    roomId: joined?.roomId,
    selfId: joined?.selfId,
    resumeToken: joined?.resumeToken,
    spectator: joined?.spectator,
  };
}

test('加入时签发 resumeToken，且一人只对应一个凭证', () => {
  const rm = new RoomManager();
  const a = join(rm, '甲');

  assert.ok(a.resumeToken, '应下发 resumeToken');
  assert.equal(rm.resumeBindings.size, 1);

  const binding = rm.resumeBindings.get(a.resumeToken);
  assert.deepEqual(binding, { roomId: a.roomId, playerId: a.selfId });
});

test('主动离开后凭证立即作废（否则 Map 只增不减）', () => {
  const rm = new RoomManager();
  const a = join(rm, '甲');
  join(rm, '乙', a.roomId);

  assert.equal(rm.resumeBindings.size, 2);

  rm.handleMessage(a.ws, { type: C2S.LEAVE });
  assert.equal(rm.resumeBindings.size, 1, '离开者的凭证应被回收');
});

test('房间销毁时回收其下全部凭证', () => {
  const rm = new RoomManager();
  const a = join(rm, '甲');
  const b = join(rm, '乙', a.roomId);

  assert.equal(rm.resumeBindings.size, 2);

  // 只走一人：房间还在，另一人的凭证应保留
  rm.handleDisconnect(a.ws);
  assert.equal(rm.rooms.size, 1, '仍有玩家，房间不应销毁');
  assert.equal(rm.resumeBindings.size, 1, '仅回收离开者的凭证');

  // 两人都走 → 房间空置 → 销毁
  rm.handleDisconnect(b.ws);
  assert.equal(rm.rooms.size, 0, '房间应已销毁');
  assert.equal(rm.resumeBindings.size, 0, '房间销毁后不应残留任何凭证');
});

test('反复建房与离开不会累积凭证（内存泄漏回归）', () => {
  const rm = new RoomManager();

  // 曾经的缺陷：建并离开 10 个房间后 rooms=0 但 resumeBindings=10
  for (let i = 0; i < 10; i++) {
    const p = join(rm, `玩家${i}`);
    rm.handleMessage(p.ws, { type: C2S.LEAVE });
  }
  assert.equal(rm.rooms.size, 0);
  assert.equal(rm.resumeBindings.size, 0);

  for (let i = 0; i < 10; i++) {
    const p = join(rm, `断线${i}`);
    rm.handleDisconnect(p.ws);
  }
  assert.equal(rm.rooms.size, 0);
  assert.equal(rm.resumeBindings.size, 0);
});

test('凭证无效或跨房间使用时被拒绝', () => {
  const rm = new RoomManager();
  const a = join(rm, '甲');

  const ws2 = fakeWs();
  // 伪造 token
  rm.handleMessage(ws2, { type: C2S.RESUME, roomId: a.roomId, resumeToken: 'forged-token' });
  assert.equal(ws2.last(S2C.ERROR)?.code, 'BAD_RESUME');

  // token 正确但房间号不匹配 —— 双重校验必须同时通过
  const ws3 = fakeWs();
  rm.handleMessage(ws3, { type: C2S.RESUME, roomId: '0000', resumeToken: a.resumeToken });
  assert.equal(ws3.last(S2C.ERROR)?.code, 'BAD_RESUME');
});

test('对局中加入转为观战，且不占用玩家名额', () => {
  const rm = new RoomManager();
  const a = join(rm, '房主');
  join(rm, '乙', a.roomId);

  rm.handleMessage(a.ws, { type: C2S.START });
  const room = rm.rooms.get(a.roomId);
  assert.ok(
    room.phase === PHASE.COUNTDOWN || room.phase === PHASE.PLAYING,
    `对局应已开始，实际 ${room.phase}`
  );

  const watcher = join(rm, '看客', a.roomId);
  assert.equal(watcher.spectator, true, '对局中加入应成为观战者');
  assert.equal(room.size, 2, '观战者不应计入玩家数');

  const p = room.players.get(watcher.selfId);
  assert.equal(p.slot, -1, '观战者不占用颜色槽位');

  room.stopLoop();
});

test('观战者转正后旧凭证作废，只保留新凭证', () => {
  const rm = new RoomManager();
  const a = join(rm, '房主');
  join(rm, '乙', a.roomId);

  rm.handleMessage(a.ws, { type: C2S.START });
  const room = rm.rooms.get(a.roomId);

  const watcher = join(rm, '看客', a.roomId);
  const oldToken = watcher.resumeToken;
  assert.ok(rm.resumeBindings.has(oldToken));

  // 结束当前对局后再开一局，观战者应被转正
  room.stopLoop();
  room.phase = PHASE.OVER;
  const before = rm.resumeBindings.size;
  rm.handleMessage(a.ws, { type: C2S.START });

  assert.equal(rm.resumeBindings.has(oldToken), false, '转正后旧凭证必须作废');
  assert.equal(rm.resumeBindings.size, before, '凭证总数不应因转正而增长');
  assert.equal(room.size, 3, '观战者应已入场');

  const promoted = [...room.players.values()].find((p) => p.nickname === '看客');
  assert.equal(promoted.spectator, false);
  assert.notEqual(promoted.slot, -1, '转正后应分配到正式槽位');

  room.stopLoop();
});

test('满员且非对局中仍然拒绝加入', () => {
  const rm = new RoomManager();
  const a = join(rm, '玩家0');
  for (let i = 1; i < ROOM_MAX; i++) join(rm, `玩家${i}`, a.roomId);

  const room = rm.rooms.get(a.roomId);
  assert.equal(room.size, ROOM_MAX);
  assert.equal(room.phase, PHASE.WAITING);

  const extra = fakeWs();
  rm.handleMessage(extra, { type: C2S.JOIN, nickname: '多余', roomId: a.roomId });
  assert.equal(extra.last(S2C.ERROR)?.code, 'ROOM_FULL');
});

test('结算的 scores 每个字段只出现一次', () => {
  const rm = new RoomManager();
  const a = join(rm, '甲');
  const b = join(rm, '乙', a.roomId);
  const room = rm.rooms.get(a.roomId);

  rm.handleMessage(a.ws, { type: C2S.START });
  room.stopLoop();

  const players = [...room.players.values()];
  room.endGame(players[0], 'last_survivor');

  const score = room.result.scores[0];
  const keys = Object.keys(score);
  assert.equal(
    keys.length,
    new Set(keys).size,
    `scores 存在重复字段：${keys.join(', ')}`
  );
  // 观战标记必须真实反映玩家身份，而非被重复键覆盖成固定值
  for (const s of room.result.scores) {
    const p = room.players.get(s.id);
    assert.equal(s.spectator, p.spectator);
    assert.equal(s.connected, p.connected);
  }
  assert.ok(b.selfId);
});
