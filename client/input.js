/**
 * 键盘输入 → 移动意图
 *
 * 关键设计：**仅在意图发生变化时发送**，而非每帧发送。
 * 30Hz × 4 人的无脑上报会产生大量无意义流量，
 * 而移动意图本质是离散事件（开始移动 / 改变方向 / 停止）。
 */

import { C2S } from '/shared/protocol.js';
import { DIR } from '/shared/constants.js';
import { audio } from './audio.js';

const KEY_MAP = {
  ArrowUp: DIR.UP,
  ArrowDown: DIR.DOWN,
  ArrowLeft: DIR.LEFT,
  ArrowRight: DIR.RIGHT,
  KeyW: DIR.UP,
  KeyS: DIR.DOWN,
  KeyA: DIR.LEFT,
  KeyD: DIR.RIGHT,
};

const FIRE_KEYS = new Set(['Space', 'KeyJ', 'Enter']);

export class InputController {
  constructor(net) {
    this.net = net;
    /** 当前按下的方向键，按按下顺序排列 */
    this.pressed = [];
    /** 上次已发送的方向，用于去重 */
    this.sentDir = null;
    this.enabled = false;

    this.onKeyDown = this.onKeyDown.bind(this);
    this.onKeyUp = this.onKeyUp.bind(this);
    this.onBlur = this.onBlur.bind(this);
  }

  attach() {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    // 切换标签页/失焦时必须清空按键，否则回来时坦克会一直朝原方向走
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onBlur);
  }

  detach() {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onBlur);
    this.reset();
  }

  setEnabled(on) {
    this.enabled = on;
    if (!on) this.reset();
  }

  reset() {
    this.pressed = [];
    if (this.sentDir !== null) {
      this.sentDir = null;
      this.net.send(C2S.INPUT, { dir: null });
    }
  }

  onKeyDown(e) {
    if (!this.enabled) return;
    // 输入框获得焦点时不应拦截按键
    if (e.target instanceof HTMLInputElement) return;

    if (FIRE_KEYS.has(e.code)) {
      e.preventDefault();
      // 射击冷却由服务端裁决，客户端无脑上报即可
      this.net.send(C2S.FIRE, {});
      audio.fire();
      return;
    }

    const dir = KEY_MAP[e.code];
    if (!dir) return;
    e.preventDefault();

    // 忽略操作系统的按键重复事件
    if (e.repeat) return;

    // 后按的方向优先，符合"最后操作即当前意图"的直觉
    if (!this.pressed.includes(dir)) this.pressed.push(dir);
    this.flush();
  }

  onKeyUp(e) {
    if (!this.enabled) return;
    const dir = KEY_MAP[e.code];
    if (!dir) return;

    this.pressed = this.pressed.filter((d) => d !== dir);
    this.flush();
  }

  onBlur() {
    if (document.visibilityState === 'visible') return;
    this.reset();
  }

  /** 计算当前意图并在变化时上报 */
  flush() {
    const dir = this.pressed.length ? this.pressed[this.pressed.length - 1] : null;
    if (dir === this.sentDir) return;
    this.sentDir = dir;
    this.net.send(C2S.INPUT, { dir });
  }
}
