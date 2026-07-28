/**
 * 服务端入口
 *
 * 单进程同时承担三件事：
 *   1. HTTP 静态托管（client/ shared/ assets/）
 *   2. WebSocket 实时通信（/ws）
 *   3. 健康检查（/healthz）
 *
 * 静态与 WS 同源，客户端无需任何跨域或代理配置。
 *
 * S1.1 阶段仅实现 echo，用于验证端到端通路；
 * 房间与对局逻辑在 S1.2 起接入。
 */

import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import { ALLOWED_ORIGINS, HOST, NODE_ENV, PORT, WS_PATH } from './config.js';
import { logger } from './logger.js';
import { createStaticHandler } from './static.js';
import { HEARTBEAT_MS } from '../shared/constants.js';
import { C2S, ERR, S2C, decode, encode } from '../shared/protocol.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const startedAt = Date.now();

// ---------------- HTTP ----------------

// 挂载顺序即匹配顺序。/ 放最后，作为兜底
const handleStatic = createStaticHandler([
  { prefix: '/shared/', dir: join(ROOT, 'shared') },
  { prefix: '/assets/', dir: join(ROOT, 'assets') },
  { prefix: '/', dir: join(ROOT, 'client') },
]);

const server = createServer(async (req, res) => {
  try {
    // 健康检查。容器云存活/就绪探针依赖此接口，缺失会导致 Pod 反复重启
    if (req.url === '/healthz') {
      const body = {
        ok: true,
        uptime: Math.floor((Date.now() - startedAt) / 1000),
        connections: wss?.clients.size ?? 0,
        rooms: 0, // S1.2 接入 RoomManager 后填充
        players: 0,
      };
      res
        .writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        .end(JSON.stringify(body));
      return;
    }

    if (await handleStatic(req, res)) return;

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
  } catch (err) {
    // 任何请求处理异常都不得影响进程存活
    logger.error({ evt: 'http_error', url: req.url, err: err.message });
    if (!res.headersSent) res.writeHead(500).end('Internal Server Error');
  }
});

// ---------------- WebSocket ----------------

/**
 * noServer + 手动 upgrade：为了在握手阶段校验 Origin 与路径。
 * 直接传 { server } 无法拒绝非法来源。
 */
const wss = new WebSocketServer({ noServer: true });

/** Origin 白名单校验。'*' 表示不限制（本地开发默认） */
function isOriginAllowed(origin) {
  if (ALLOWED_ORIGINS.includes('*')) return true;
  return Boolean(origin) && ALLOWED_ORIGINS.includes(origin);
}

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (pathname !== WS_PATH) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!isOriginAllowed(req.headers.origin)) {
    logger.warn({ evt: 'ws_origin_rejected', origin: req.headers.origin });
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

let connSeq = 0;

wss.on('connection', (ws, req) => {
  const connId = `c${++connSeq}`;
  ws.connId = connId;
  ws.isAlive = true;

  logger.info({
    evt: 'ws_open',
    connId,
    ip: req.socket.remoteAddress,
    total: wss.clients.size,
  });

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    // 整体包裹 try-catch：任何畸形消息都不得导致进程崩溃
    try {
      const msg = decode(raw.toString());
      if (!msg) {
        ws.send(encode(S2C.ERROR, { code: ERR.BAD_MESSAGE, message: '无法解析的消息' }));
        return;
      }

      switch (msg.type) {
        case C2S.ECHO:
          ws.send(encode(S2C.ECHO, { payload: msg.payload ?? null, serverTime: Date.now() }));
          break;

        default:
          // S1.2 起由 RoomManager 接管其余消息类型
          logger.debug({ evt: 'ws_unhandled', connId, type: msg.type });
          ws.send(
            encode(S2C.ERROR, {
              code: ERR.BAD_MESSAGE,
              message: `暂不支持的消息类型: ${msg.type}`,
            })
          );
      }
    } catch (err) {
      logger.error({ evt: 'ws_message_error', connId, err: err.message });
      try {
        ws.send(encode(S2C.ERROR, { code: ERR.INTERNAL, message: '服务端处理异常' }));
      } catch {
        /* 连接已不可写，忽略 */
      }
    }
  });

  ws.on('close', (code) => {
    logger.info({ evt: 'ws_close', connId, code, total: wss.clients.size - 1 });
  });

  ws.on('error', (err) => {
    logger.warn({ evt: 'ws_error', connId, err: err.message });
  });
});

/**
 * 心跳。双重作用：
 *   1. 穿透代理的空闲超时（常见 30s/60s），防止长连接被静默切断
 *   2. 检测半开连接（客户端断网时不会发 close 帧）
 */
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      logger.warn({ evt: 'ws_heartbeat_timeout', connId: ws.connId });
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);

// ---------------- 启动与优雅退出 ----------------

server.listen(PORT, HOST, () => {
  logger.info({ evt: 'server_start', port: PORT, host: HOST, env: NODE_ENV });
  console.log(`\n  🎮 坦克竞技场已启动 →  http://localhost:${PORT}\n`);
});

/**
 * 优雅退出：先通知客户端再关闭。
 * 否则玩家只会看到连接莫名断开，无法区分是服务重启还是自己网络问题。
 */
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ evt: 'server_shutdown', signal });

  clearInterval(heartbeat);

  for (const ws of wss.clients) {
    try {
      ws.send(encode(S2C.SHUTDOWN, { message: '服务端正在重启，请稍后刷新' }));
      ws.close(1001, 'Server shutting down');
    } catch {
      /* 忽略已断开的连接 */
    }
  }

  server.close(() => process.exit(0));
  // 兜底：3s 内未能正常关闭则强制退出，避免挂起的长连接卡住进程
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
  logger.error({ evt: 'uncaught_exception', err: err.message, stack: err.stack });
});
process.on('unhandledRejection', (reason) => {
  logger.error({ evt: 'unhandled_rejection', reason: String(reason) });
});
