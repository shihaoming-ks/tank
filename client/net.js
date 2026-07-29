/**
 * WebSocket 连接管理
 *
 * 职责：建连、收发、断线感知、消息分发。
 * 不含任何游戏规则判定 —— 客户端只是表现层。
 */

import { C2S, decode, encode } from '/shared/protocol.js';

/**
 * WS 地址从当前页面协议推导，不硬编码。
 *
 * ⚠️ 这一行决定了线上能否跑起来：
 *    https 页面若连 ws:// 会被浏览器以 Mixed Content 拦截，直接白屏。
 *    从 location 推导可让本地 ws:// 与线上 wss:// 零配置切换。
 */
function resolveWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

export class Net {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    /** 消息处理器表：type → handler[] */
    this.handlers = new Map();
    /** 连接状态变化回调 */
    this.onStatus = null;
    /** 服务端主动关闭时下发的原因，用于区分"服务重启"与"网络异常" */
    this.shutdownMessage = null;
    this.url = resolveWsUrl();
    /** 自动重连定时器 */
    this._reconnectTimer = null;
    /** 当前重连尝试次数 */
    this._retryCount = 0;
    /** 重连回调：外部设置，每次触发前调用（用于更新 UI 状态） */
    this.onReconnectAttempt = null;
    /** 是否允许自动重连（断线时若有 token 则允许） */
    this.autoReconnect = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.setStatus('connecting');
      const ws = new WebSocket(this.url);
      this.ws = ws;

      ws.addEventListener('open', () => {
        this.setStatus('open');
        console.info('[net] 已连接', this.url);
        resolve();
      });

      ws.addEventListener('message', (ev) => {
        const msg = decode(ev.data);
        if (!msg) {
          console.warn('[net] 收到无法解析的消息', ev.data);
          return;
        }
        // 记住服务端主动关闭的原因，close 事件本身不携带业务语义
        if (msg.type === 'shutdown') this.shutdownMessage = msg.message;
        this.dispatch(msg);
      });

      ws.addEventListener('close', (ev) => {
        this.setStatus('closed', {
          code: ev.code,
          reason: ev.reason,
          shutdownMessage: this.shutdownMessage,
        });
        console.warn('[net] 连接关闭', ev.code, ev.reason);
        // 自动重连：非正常关闭（code !== 1000）且开启了重连时触发
        if (this.autoReconnect && ev.code !== 1000) {
          this._scheduleReconnect();
        }
      });

      ws.addEventListener('error', () => {
        // error 事件不携带原因，具体信息只能靠随后的 close 事件
        this.setStatus('error');
        reject(new Error('WebSocket 连接失败'));
      });
    });
  }

  /** 注册消息处理器，同一 type 可注册多个 */
  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(handler);
    return this;
  }

  dispatch(msg) {
    const list = this.handlers.get(msg.type);
    if (!list || list.length === 0) {
      console.debug('[net] 未处理的消息类型', msg.type, msg);
      return;
    }
    for (const fn of list) {
      // 单个处理器异常不应中断其余处理器
      try {
        fn(msg);
      } catch (err) {
        console.error('[net] 处理器异常', msg.type, err);
      }
    }
  }

  send(type, data) {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      console.warn('[net] 连接未就绪，丢弃消息', type);
      return false;
    }
    this.ws.send(encode(type, data));
    return true;
  }

  /** 连通性自测，用于 S1.1 阶段验证端到端通路 */
  echo(payload) {
    return this.send(C2S.ECHO, { payload });
  }

  setStatus(status, detail) {
    this.status = status;
    this.onStatus?.(status, detail);
  }

  /** 计划一次指数退避重连（最长 16s） */
  _scheduleReconnect() {
    clearTimeout(this._reconnectTimer);
    const delay = Math.min(1000 * 2 ** this._retryCount, 16000);
    this._retryCount++;
    this.onReconnectAttempt?.(this._retryCount, delay);
    this._reconnectTimer = setTimeout(async () => {
      try {
        await this.connect();
        this._retryCount = 0;
        this.setStatus('reconnected');
      } catch {
        // connect 失败会触发 close，从而再次调用 _scheduleReconnect
      }
    }, delay);
  }

  /** 停止自动重连 */
  cancelReconnect() {
    this.autoReconnect = false;
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    this._retryCount = 0;
  }
}
