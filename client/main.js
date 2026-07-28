/**
 * S1.1 阶段客户端入口
 *
 * 当前只做一件事：验证 HTTP 静态托管 + WebSocket 端到端通路。
 * 房间、大厅、渲染在 S1.2 / S1.3 接入。
 */

import { S2C } from '/shared/protocol.js';
import { MAP_H, MAP_W, TICK_HZ } from '/shared/constants.js';
import { Net } from './net.js';

const $ = (sel) => document.querySelector(sel);

const els = {
  status: $('#status'),
  statusDot: $('#status-dot'),
  log: $('#log'),
  btnEcho: $('#btn-echo'),
  meta: $('#meta'),
};

/** 把日志同时写到页面与 Console，便于不开 DevTools 也能验证 */
function log(text, kind = 'info') {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.className = `log-line log-${kind}`;
  line.textContent = `[${time}] ${text}`;
  els.log.prepend(line);
  console.log(`[app] ${text}`);
}

function setStatus(status, detail) {
  const map = {
    connecting: ['连接中…', 'pending'],
    open: ['已连接', 'ok'],
    closed: ['连接已断开', 'bad'],
    error: ['连接失败', 'bad'],
  };
  const [text, cls] = map[status] ?? [status, 'pending'];
  els.status.textContent = text;
  els.statusDot.className = `dot dot-${cls}`;

  if (status === 'closed') {
    log(`连接关闭（code=${detail?.code ?? '?'}）`, 'warn');
    els.btnEcho.disabled = true;
  }
  if (status === 'open') els.btnEcho.disabled = false;
}

async function main() {
  els.meta.textContent = `地图 ${MAP_W}×${MAP_H} · tick ${TICK_HZ}Hz`;
  log(`已从 /shared/constants.js 读取参数：地图 ${MAP_W}×${MAP_H}，tick ${TICK_HZ}Hz`, 'ok');

  const net = new Net();
  net.onStatus = setStatus;

  net.on(S2C.ECHO, (msg) => {
    const rtt = Date.now() - msg.payload?.sentAt;
    log(`收到 echo 回包，往返 ${rtt}ms，服务端时间 ${new Date(msg.serverTime).toLocaleTimeString('zh-CN', { hour12: false })}`, 'ok');
  });

  net.on(S2C.ERROR, (msg) => log(`服务端错误：${msg.message}（${msg.code}）`, 'bad'));

  net.on(S2C.SHUTDOWN, (msg) => log(`服务端通知：${msg.message}`, 'warn'));

  try {
    log(`正在连接 ${net.url} …`);
    await net.connect();
    log('WebSocket 通路已建立', 'ok');
    // 自动发一次，无需手动点击即可确认通路
    net.echo({ sentAt: Date.now(), hello: 'tank-arena' });
  } catch (err) {
    log(`连接失败：${err.message}`, 'bad');
    return;
  }

  els.btnEcho.addEventListener('click', () => {
    net.echo({ sentAt: Date.now(), hello: 'manual' });
    log('已发送 echo 请求…');
  });
}

main();
