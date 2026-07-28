/**
 * 客户端入口 —— 视图状态机
 *
 * 视图流转：lobby → room → game
 *
 * ⚠️ 本文件不含任何游戏规则判定。
 *    房间阶段、玩家列表、坦克坐标、生命值全部以服务端下行为唯一依据，
 *    绝不在本地推断或预测。
 */

import { END_REASON, MATCH_DURATION_MS, MAX_HP, PHASE, ROOM_MAX } from '/shared/constants.js';
import { C2S, S2C, isValidRoomId, normalizeNickname } from '/shared/protocol.js';
import { Feed } from './feed.js';
import { InputController } from './input.js';
import { Net } from './net.js';
import { Renderer } from './render.js';

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
  canvas: $('#canvas'),
  hudPlayers: $('#hud-players'),
  hudTimer: $('#hud-timer'),
  feed: $('#feed'),
  btnFeedClear: $('#btn-feed-clear'),
  btnRestart: $('#btn-restart'),
  // 结算
  overlayOver: $('#overlay-over'),
  overTitle: $('#over-title'),
  overReason: $('#over-reason'),
  scoreBody: $('#score-body'),
  btnAgain: $('#btn-again'),
  btnBackLobby: $('#btn-back-lobby'),
  overHint: $('#over-hint'),
  // 遮罩
  overlay: $('#overlay-disconnect'),
  disconnectReason: $('#disconnect-reason'),
  toast: $('#toast'),
};

/** 本地会话状态。仅缓存服务端下发的数据，不做任何推断 */
const state = {
  selfId: null,
  roomId: null,
  room: null,
  /** 最新快照。渲染循环读它，收到新的就整体替换 */
  snapshot: null,
  /** 最近一次对局结算结果 */
  result: null,
  spectator: false,
};

const net = new Net();
const renderer = new Renderer(els.canvas);
const input = new InputController(net);
const feed = new Feed(els.feed);

// ---------------- 视图切换 ----------------

function showView(name) {
  for (const [key, el] of Object.entries(els.views)) {
    el.hidden = key !== name;
  }
  syncInputEnabled();
  // 切入对战视图后立即画一帧，不等下一个快照到达
  if (name === 'game') drawFrame();
}

/**
 * 同步键盘输入开关。
 *
 * 三个条件须同时满足才接收输入：
 *   1. 处于对战视图 —— 避免在大厅输入昵称时误触发移动
 *   2. 结算面板已关闭 —— 否则玩家会对着已结束的对局操作
 *   3. 阶段为 PLAYING —— 倒计时期间服务端会拦下操作，本地也禁用，
 *      否则玩家按键无反应却看不出原因
 */
function syncInputEnabled() {
  const onGame = !els.views.game.hidden;
  const canPlay = state.room?.phase === PHASE.PLAYING;
  input.setEnabled(onGame && els.overlayOver.hidden && canPlay && !state.spectator);
}

/** 错误提示（3.5s 后自动消失） */
let errorTimer = null;
function showError(el, text) {
  el.textContent = text;
  el.hidden = false;
  clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    el.hidden = true;
  }, 3500);
}

/**
 * 全局 Toast。
 *
 * 为何不再用"按当前视图挑选错误元素"的做法：
 * 那种写法一旦出现新视图（如结算面板处于 game 视图），
 * 错误就会被写进**当前隐藏的**元素里，表现为"点击毫无反应"，且极难定位。
 * 固定定位的全局 Toast 从结构上消除这类问题。
 */
let toastTimer = null;
function toast(text, tone = 'error') {
  els.toast.textContent = text;
  els.toast.className = `toast toast-${tone}`;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 3000);
}

// ---------------- 昵称持久化 ----------------

/**
 * 只持久化昵称，**绝不持久化 playerId**。
 * 身份完全由服务端分配，否则同浏览器多标签页会串号。
 */
const NICK_KEY = 'tank:nickname';
// 关闭标签页后仍可恢复；主动离开时会显式清除。
const RESUME_KEY = 'tank:resume';

function loadResume() {
  try {
    const saved = JSON.parse(localStorage.getItem(RESUME_KEY) ?? 'null');
    return saved && typeof saved.roomId === 'string' && typeof saved.resumeToken === 'string' ? saved : null;
  } catch {
    return null;
  }
}

function saveResume(msg) {
  if (!msg.resumeToken || !msg.roomId) return;
  localStorage.setItem(RESUME_KEY, JSON.stringify({ roomId: msg.roomId, resumeToken: msg.resumeToken }));
}
els.nickname.value = localStorage.getItem(NICK_KEY) ?? '';
els.nickname.addEventListener('change', () => {
  localStorage.setItem(NICK_KEY, els.nickname.value.trim());
});

// ---------------- 房间渲染 ----------------

function renderRoom(room) {
  const prevPhase = state.room?.phase;
  state.room = room;
  state.roomId = room.roomId;
  renderer.setPlayers(room.players);

  // 新一局开始（进入倒计时即视为开始）：清掉上一局的结算面板与残留特效
  const started = room.phase === PHASE.COUNTDOWN || room.phase === PHASE.PLAYING;
  const wasStarted = prevPhase === PHASE.COUNTDOWN || prevPhase === PHASE.PLAYING;
  if (!wasStarted && started) {
    state.result = null;
    renderer.clearEffects();
    hideResult();
  }

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
    if (p.spectator) tags.append(tag('观战', 'tag-spectator'));
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

  renderHud(room);

  // 阶段切换完全由服务端驱动。
  // OVER 阶段保持在战场视图：结算面板叠加在战场之上，
  // 让玩家能看到最后一刻的局面，而不是被弹回等待区
  // 倒计时阶段就切入战场：玩家需要提前看清地图与自己的位置
  const onField =
    room.phase === PHASE.COUNTDOWN || room.phase === PHASE.PLAYING || room.phase === PHASE.OVER;
  showView(onField ? 'game' : 'room');

  // 输入开关必须在 showView 之后再刷一次：
  // showView 读的是 state.room（此处已更新），但阶段从 COUNTDOWN → PLAYING
  // 时视图名不变，不会触发 showView，需在此显式同步
  syncInputEnabled();

  // 结算面板开着时，房主/人数变化会影响"再来一局"是否可点
  if (!els.overlayOver.hidden && state.result) showResult(state.result);

  // 结算后房主可用底部按钮直接开新局，无需重开面板
  els.btnRestart.hidden = !(
    room.phase === PHASE.OVER &&
    room.hostId === state.selfId &&
    room.players.length >= (room.minPlayers ?? 2)
  );
}

function tag(text, cls) {
  const s = document.createElement('span');
  s.className = `tag ${cls}`;
  s.textContent = text;
  return s;
}

/** HUD 玩家条：颜色 + 昵称 + 血条 */
function renderHud(room) {
  els.hudPlayers.innerHTML = '';
  for (const p of room.players) {
    const box = document.createElement('div');
    box.className = 'hud-player';
    if (p.id === state.selfId) box.classList.add('is-self');
    if (!p.alive) box.classList.add('is-dead');

    const swatch = document.createElement('i');
    swatch.className = 'swatch';
    swatch.style.background = p.color;

    const name = document.createElement('span');
    name.className = 'hud-name';
    name.textContent = p.nickname;

    const hp = document.createElement('span');
    hp.className = 'hud-hp';
    if (p.spectator) {
      box.classList.add('is-spectator');
      hp.textContent = '观战';
    } else {
      hp.dataset.playerId = p.id;
    }

    box.append(swatch, name, hp);
    els.hudPlayers.append(box);
  }
}

/**
 * 血量与存活状态每帧从快照更新。
 * 不走 room 消息是因为 room 只在房间变更时下发，
 * 而血量在对战中高频变化。
 */
function updateHudFromSnapshot(snap) {
  for (const t of snap.tanks ?? []) {
    const el = els.hudPlayers.querySelector(`[data-player-id="${t.id}"]`);
    if (!el) continue;

    if (!t.alive) {
      el.textContent = '淘汰';
      el.classList.add('is-dead');
      el.classList.remove('is-low');
      continue;
    }
    el.classList.remove('is-dead');
    // 用分段方块而非小号心形字符：字符受字体渲染影响大且太细，
    // 方块能在余光里一眼数清还剩几格
    el.innerHTML = '';
    for (let i = 0; i < MAX_HP; i++) {
      const pip = document.createElement('i');
      pip.className = i < t.hp ? 'pip' : 'pip is-empty';
      el.append(pip);
    }
    // 残血高亮：1 血时整条转红并轻微脉动，这是最需要被注意到的状态
    el.classList.toggle('is-low', t.hp <= 1);
  }

  const left = snap.timeLeft ?? MATCH_DURATION_MS;
  const sec = Math.ceil(left / 1000);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  els.hudTimer.textContent = `${mm}:${ss}`;
  els.hudTimer.classList.toggle('is-urgent', sec <= 30);
}

// ---------------- 渲染循环 ----------------

/**
 * 绘制一帧。
 * 教训：曾只依赖 requestAnimationFrame 驱动渲染，但在部分环境
 * （无头浏览器、某些自动化容器、后台标签页）rAF 会被节流至完全不触发，
 * 导致画面永久空白且**无任何报错**，极难定位。
 * 因此渲染采用双驱动：
 *   1. rAF —— 跟随屏幕刷新率，保证时间驱动动画（如无敌闪烁）平滑
 *   2. 快照到达 —— 服务端 30Hz 保底，即使 rAF 完全失效仍有画面
 * 重复绘制成本极低，但可用性提升显著。
 */
function drawFrame() {
  if (els.views.game.hidden) return;
  renderer.draw(state.snapshot);
}

function loop() {
  drawFrame();
  requestAnimationFrame(loop);
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
    input.setEnabled(false);
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
  state.spectator = Boolean(msg.spectator);
  saveResume(msg);
  renderer.setSelfId(msg.selfId);
  console.info('[app] 已加入房间', msg.roomId, '身份', msg.selfId);
});

net.on(S2C.ROOM, (msg) => renderRoom(msg));

net.on(S2C.SNAPSHOT, (msg) => {
  // 地图只在首帧下发，需缓存
  if (msg.map) renderer.setMap(msg.map);
  // 砖墙被击破的增量更新
  if (msg.mp) renderer.applyMapPatches(msg.mp);

  // 丢弃乱序到达的旧帧，否则画面会出现回跳。
  // ⚠️ 必须先比对 matchId：换局时帧号基准会变，
  //    只比 t 会把新局的帧全部误判为"旧帧"而丢弃，
  //    导致画面冻结在上一局最后一帧。
  const prev = state.snapshot;
  const sameMatch = prev && (prev.m ?? 0) === (msg.m ?? 0);
  if (sameMatch && msg.t < prev.t) return;

  state.snapshot = msg;
  updateHudFromSnapshot(msg);
  // 保底绘制：不依赖 rAF 是否可用
  drawFrame();
});

net.on(S2C.EVENT, (msg) => {
  const events = msg.events ?? [];
  // 特效与战报是同一批事件的两种消费方式
  renderer.handleEvents(events);
  feed.handleEvents(events);
  drawFrame();
});

net.on(S2C.OVER, (msg) => {
  state.result = msg;
  feed.handleOver(msg);
  showResult(msg);
});

net.on(S2C.ERROR, (msg) => {
  console.warn('[app] 服务端错误', msg.code, msg.message);
  // 统一走全局 Toast，保证任何视图下都可见
  toast(msg.message);
});

net.on(S2C.SHUTDOWN, (msg) => {
  els.disconnectReason.textContent = msg.message;
  els.overlay.hidden = false;
});

// ---------------- 结算 ----------------

const REASON_TEXT = {
  [END_REASON.LAST_SURVIVOR]: '仅剩一名存活玩家',
  [END_REASON.TIMEOUT]: '时间到',
  [END_REASON.ABORTED]: '玩家不足，对局中止',
};

function showResult(result) {
  els.overReason.textContent = REASON_TEXT[result.reason] ?? '对局结束';

  if (result.reason === END_REASON.ABORTED) {
    els.overTitle.textContent = '对局中止';
    els.overTitle.style.color = '';
  } else if (result.winnerName) {
    const isSelf = result.winnerId === state.selfId;
    els.overTitle.textContent = isSelf ? '你赢了' : `${result.winnerName} 获胜`;
    els.overTitle.style.color = isSelf ? 'var(--green)' : 'var(--amber)';
  } else {
    els.overTitle.textContent = '平局';
    els.overTitle.style.color = '';
  }

  els.scoreBody.innerHTML = '';
  for (const s of result.scores ?? []) {
    const tr = document.createElement('tr');
    if (s.id === result.winnerId) tr.className = 'is-winner';

    const name = document.createElement('td');
    const dot = document.createElement('i');
    dot.className = 'swatch';
    dot.style.background = s.color;
    name.append(dot, document.createTextNode(s.nickname));
    if (s.id === state.selfId) name.append(tag('你', 'tag-self'));

    const kills = document.createElement('td');
    kills.textContent = String(s.kills);

    const hp = document.createElement('td');
    hp.textContent = s.spectator ? '观战' : s.alive ? String(s.hp) : '淘汰';

    tr.append(name, kills, hp);
    els.scoreBody.append(tr);
  }

  // 按身份区分结算面板的可操作性：
  // 非房主看到的是"等待房主"，而不是一个点了没反应的按钮
  const room = state.room;
  const isHost = room?.hostId === state.selfId;
  const count = room?.players?.length ?? 0;
  const enough = count >= (room?.minPlayers ?? 2);
  const hostName = room?.players?.find((p) => p.id === room.hostId)?.nickname;

  els.btnAgain.hidden = !isHost;
  els.btnAgain.disabled = !enough;

  if (!enough) {
    els.overHint.textContent = `等待玩家加入（当前 ${count} 人，至少需要 2 人）`;
  } else if (isHost) {
    els.overHint.textContent = '';
  } else {
    els.overHint.textContent = `等待房主${hostName ? `（${hostName}）` : ''}开始新对局…`;
  }

  els.overlayOver.hidden = false;
  input.setEnabled(false);
}

function hideResult() {
  els.overlayOver.hidden = true;
  syncInputEnabled();
}

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

/**
 * 请求开新一局。
 *
 * 非房主在本地就拦掉并给出提示：否则用户点了按钮，
 * 服务端静默拒绝（NOT_HOST），界面毫无变化，
 * 直到房主真正开局才动 —— 主观感受就是"等了很久才开始"。
 */
function requestRestart() {
  const room = state.room;
  if (!room) return;

  if (room.hostId !== state.selfId) {
    const host = room.players.find((p) => p.id === room.hostId);
    toast(`只有房主${host ? `（${host.nickname}）` : ''}可以开始新对局`, 'warn');
    return;
  }
  if (room.players.length < (room.minPlayers ?? 2)) {
    toast('至少需要 2 名玩家才能开始', 'warn');
    return;
  }

  // 不再弹 Toast：开局有 3-2-1 倒计时与「开始！」提示，
  // 顶部再叠一层浮层反而干扰视线
  net.send(C2S.START, {});
}
els.btnAgain.addEventListener('click', requestRestart);
els.btnRestart.addEventListener('click', requestRestart);

els.btnBackLobby.addEventListener('click', () => {
  hideResult();
  leaveRoom();
});

els.btnFeedClear.addEventListener('click', () => feed.clear());

function leaveRoom() {
  net.send(C2S.LEAVE, {});
  state.selfId = null;
  state.roomId = null;
  state.room = null;
  state.snapshot = null;
  state.result = null;
  state.spectator = false;
  localStorage.removeItem(RESUME_KEY);
  renderer.clearEffects();
  els.roomIdInput.value = '';
  els.overlayOver.hidden = true;
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
  input.attach();
  requestAnimationFrame(loop);

  try {
    await net.connect();
    const resume = loadResume();
    if (resume) net.send(C2S.RESUME, resume);
  } catch (err) {
    console.error('[app] 连接失败', err);
  }
}

main();
