/**
 * 客户端入口 —— 视图状态机
 *
 * 视图流转：lobby → room → game
 *
 * ⚠️ 本文件不含任何游戏规则判定。
 *    房间阶段、玩家列表、房主身份全部以服务端下行为唯一依据，
 *    绝不在本地推断（例如"我人数够了就自己切到 game"）。
 */

import { PHASE, ROOM_MAX } from '/shared/constants.js';
import { C2S, S2C, isValidRoomId, normalizeNickname } from '/shared/protocol.js';
import { Net } from './net.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $('#status'),
  statusDot: $('#status-dot'),
  views: {
    lobby: $('#view-lobby'),
    room: $('#view-room'),
    game: $('#view-game'),
  },
  // 大厅
  nickname: $('#input-nickname'),
  roomIdInput: $('#input-roomid'),
  btnCreate: $('#btn-create'),
  btnJoin: $('#btn-join'),
  lobbyError: $('#lobby-error'),
  // 房间
  roomId: $('#room-id'),
  btnCopy: $('#btn-copy'),
  roster: $('#roster'),
  rosterCount: $('#roster-count'),
  roomHint: $('#room-hint'),
  btnStart: $('#btn-start'),
  btnLeave: $('#btn-leave'),
  roomError: $('#room-error'),
  // 对战
  gameRoomId: $('#game-room-id'),
  btnLeaveGame: $('#btn-leave-game'),
  // 遮罩
  overlay: $('#overlay-disconnect'),
  disconnectReason: $('#disconnect-reason'),
};

/** 本地会话状态。仅缓存服务端下发的数据，不做任何推断 */
const state = {
  selfId: null,
  roomId: null,
  room: null,
};

const net = new Net();

// ---------------- 视图切换 ----------------

function showView(name) {
  for (const [key, el] of Object.entries(els.views)) {
    el.hidden = key !== name;
  }
}

/** 错误提示，3.5s 后自动消失 */
let errorTimer = null;
function showError(el, text) {
  el.textContent = text;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

function currentErrorEl() {
  if (!els.views.room.hidden) return els.roomError;
  return els.lobbyError;
}

// ---------------- 昵称持久化 ----------------

/**
 * 只持久化昵称，**绝不持久化 playerId**。
 * 身份完全由服务端分配，否则同浏览器多标签页会串号。
 */
const NICK_KEY = 'tank:nickname';
els.nickname.value = localStorage.getItem(NICK_KEY) ?? '';
els.nickname.addEventListener('change', () => {
  localStorage.setItem(NICK_KEY, els.nickname.value.trim());
});

// ---------------- 房间渲染 ----------------

function renderRoom(room) {
  state.room = room;
  state.roomId = room.roomId;

  els.roomId.textContent = room.roomId;
  els.gameRoomId.textContent = room.roomId;
  els.rosterCount.textContent = `${room.players.length} / ${room.maxPlayers ?? ROOM_MAX}`;

  els.roster.innerHTML = '';
  for (const p of room.players) {
    const li = document.createElement('li');
    li.className = 'roster-item';

    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = p.color;

    const name = document.createElement('span');
    name.className = 'roster-name';
    name.textContent = p.nickname;

    const tags = document.createElement('span');
    tags.className = 'roster-tags';
    if (p.id === room.hostId) tags.append(tag('房主', 'tag-host'));
    if (p.id === state.selfId) tags.append(tag('你', 'tag-self'));

    li.append(swatch, name, tags);
    els.roster.append(li);
  }

  const isHost = room.hostId === state.selfId;
  const enough = room.players.length >= (room.minPlayers ?? 2);

  // 开始按钮只对房主可见；人数不足时禁用而非隐藏，让房主知道差多少人
  els.btnStart.hidden = !isHost || room.phase !== PHASE.WAITING;
  els.btnStart.disabled = !enough;

  if (room.phase === PHASE.WAITING) {
    if (!enough) {
      els.roomHint.textContent = `等待玩家加入，至少需要 ${room.minPlayers ?? 2} 人`;
    } else {
      els.roomHint.textContent = isHost ? '人数已满足，可以开始对战' : '等待房主开始对战…';
    }
  } else {
    els.roomHint.textContent = '';
  }

  // 阶段切换完全由服务端驱动
  showView(room.phase === PHASE.PLAYING ? 'game' : 'room');
}

function tag(text, cls) {
  const s = document.createElement('span');
  s.className = `tag ${cls}`;
  s.textContent = text;
  return s;
}

// ---------------- 连接状态 ----------------

net.onStatus = (status, detail) => {
  const map = {
    connecting: ['连接中…', 'pending'],
    open: ['已连接', 'ok'],
    closed: ['已断开', 'bad'],
    error: ['连接失败', 'bad'],
  };
  const [text, cls] = map[status] ?? [status, 'pending'];
  els.status.textContent = text;
  els.statusDot.className = `dot dot-${cls}`;

  if (status === 'closed' || status === 'error') {
    // 断连是致命状态：直接遮罩，避免用户在失效界面上继续操作
    els.overlay.hidden = false;
    if (detail?.shutdownMessage) {
      els.disconnectReason.textContent = detail.shutdownMessage;
    }
  }
};

// ---------------- 消息处理 ----------------

net.on(S2C.JOINED, (msg) => {
  state.selfId = msg.selfId;
  state.roomId = msg.roomId;
  console.info('[app] 已加入房间', msg.roomId, '身份', msg.selfId);
});

net.on(S2C.ROOM, (msg) => renderRoom(msg));

net.on(S2C.ERROR, (msg) => {
  console.warn('[app] 服务端错误', msg.code, msg.message);
  showError(currentErrorEl(), msg.message);
});

net.on(S2C.SHUTDOWN, (msg) => {
  els.disconnectReason.textContent = msg.message;
  els.overlay.hidden = false;
});

// ---------------- 交互 ----------------

/** 加入前先做本地校验，避免无意义的往返；服务端仍会独立再校验一次 */
function readNickname() {
  const nickname = normalizeNickname(els.nickname.value);
  if (!nickname) {
    showError(els.lobbyError, '请输入 1 ~ 12 个字符的昵称');
    els.nickname.focus();
    return null;
  }
  localStorage.setItem(NICK_KEY, nickname);
  return nickname;
}

els.btnCreate.addEventListener('click', () => {
  const nickname = readNickname();
  if (!nickname) return;
  net.send(C2S.JOIN, { nickname });
});

els.btnJoin.addEventListener('click', () => {
  const nickname = readNickname();
  if (!nickname) return;

  const roomId = els.roomIdInput.value.trim();
  if (!isValidRoomId(roomId)) {
    showError(els.lobbyError, '房间号需为 4 位数字');
    els.roomIdInput.focus();
    return;
  }
  net.send(C2S.JOIN, { nickname, roomId });
});

// 回车即加入，减少鼠标操作
els.roomIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.btnJoin.click();
});
els.nickname.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    els.roomIdInput.value.trim() ? els.btnJoin.click() : els.btnCreate.click();
  }
});

els.btnStart.addEventListener('click', () => net.send(C2S.START, {}));

function leaveRoom() {
  net.send(C2S.LEAVE, {});
  state.selfId = null;
  state.roomId = null;
  state.room = null;
  els.roomIdInput.value = '';
  showView('lobby');
}
els.btnLeave.addEventListener('click', leaveRoom);
els.btnLeaveGame.addEventListener('click', leaveRoom);

els.btnCopy.addEventListener('click', async () => {
  if (!state.roomId) return;
  try {
    await navigator.clipboard.writeText(state.roomId);
    els.btnCopy.textContent = '已复制';
    setTimeout(() => (els.btnCopy.textContent = '复制'), 1500);
  } catch {
    // 非 HTTPS 或未授权时 clipboard 不可用，降级为选中提示
    showError(els.roomError, `请手动复制房间号：${state.roomId}`);
  }
});

// ---------------- 启动 ----------------

async function main() {
  showView('lobby');
  try {
    await net.connect();
  } catch (err) {
    console.error('[app] 连接失败', err);
  }
}

main();
