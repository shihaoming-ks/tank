/**
 * 音效系统 —— 纯 Web Audio API 程序化合成，无需加载任何音频文件。
 *
 * 设计原则：
 *  - 首次用户交互后才创建 AudioContext（浏览器自动播放策略要求）
 *  - 每个音效独立短函数，内部 connect → destination → 自动释放
 *  - 支持全局静音（muted 属性），不影响逻辑
 */

export class AudioSystem {
  constructor() {
    /** @type {AudioContext|null} */
    this._ctx = null;
    this.muted = false;
    // 首次用户交互时解锁（点击/键盘）
    this._unlocked = false;
    const unlock = () => {
      if (!this._unlocked) {
        this._getCtx(); // 创建并可能 resume
        this._unlocked = true;
      }
    };
    document.addEventListener('keydown', unlock, { once: true });
    document.addEventListener('pointerdown', unlock, { once: true });
  }

  _getCtx() {
    if (!this._ctx) {
      this._ctx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (this._ctx.state === 'suspended') this._ctx.resume();
    return this._ctx;
  }

  _play(fn) {
    if (this.muted) return;
    try {
      const ctx = this._getCtx();
      fn(ctx);
    } catch (e) {
      // 音效不是核心功能，静默忽略错误
    }
  }

  // ── 工具函数 ─────────────────────────────────────────────────────────────

  _osc(ctx, type, freq, startTime, duration, gainPeak, gainEnd = 0) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, startTime);
    gain.gain.setValueAtTime(gainPeak, startTime);
    gain.gain.linearRampToValueAtTime(gainEnd, startTime + duration);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  _noise(ctx, startTime, duration, gainPeak, gainEnd = 0, filterFreq = 4000) {
    const bufLen = Math.ceil(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(1, bufLen, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufLen; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = filterFreq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(gainPeak, startTime);
    gain.gain.exponentialRampToValueAtTime(Math.max(gainEnd, 0.0001), startTime + duration);
    src.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    src.start(startTime);
    src.stop(startTime + duration);
  }

  // ── 音效定义 ──────────────────────────────────────────────────────────────

  /** 射击：短促高频脉冲 */
  fire() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      this._osc(ctx, 'square', 380, t, 0.08, 0.18, 0);
      this._noise(ctx, t, 0.06, 0.08, 0, 3000);
    });
  }

  /** 命中：低沉噪声冲击 */
  hit() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      this._noise(ctx, t, 0.12, 0.35, 0, 800);
      this._osc(ctx, 'sawtooth', 160, t, 0.1, 0.12, 0);
    });
  }

  /** 爆炸（被击杀）：较长的低频轰鸣 */
  explode() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      this._noise(ctx, t, 0.45, 0.55, 0, 300);
      this._osc(ctx, 'sawtooth', 80, t, 0.35, 0.25, 0);
      this._osc(ctx, 'sine', 50, t + 0.05, 0.3, 0.15, 0);
    });
  }

  /** 倒计时 tick（3/2/1）：清脆短促 */
  countTick() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      this._osc(ctx, 'sine', 880, t, 0.1, 0.4, 0);
    });
  }

  /** 开始！：上升两音 */
  countGo() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      this._osc(ctx, 'sine', 660, t, 0.12, 0.5, 0);
      this._osc(ctx, 'sine', 990, t + 0.1, 0.18, 0.6, 0);
    });
  }

  /** 道具拾取：轻快上扫音 */
  pickup() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, t);
      osc.frequency.linearRampToValueAtTime(880, t + 0.15);
      gain.gain.setValueAtTime(0.35, t);
      gain.gain.linearRampToValueAtTime(0, t + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
    });
  }

  /** 升级：三音上升，带光泽感 */
  upgrade() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      const freqs = [523, 659, 784]; // C5 E5 G5
      freqs.forEach((f, i) => {
        this._osc(ctx, 'sine', f, t + i * 0.1, 0.22, 0.45, 0);
      });
    });
  }

  /** 复活甲触发：神秘低沉脉冲 */
  reviveArmor() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      this._osc(ctx, 'sine', 220, t, 0.4, 0.4, 0);
      this._osc(ctx, 'sine', 440, t + 0.05, 0.3, 0.3, 0);
      this._noise(ctx, t, 0.3, 0.12, 0, 1200);
    });
  }

  /** 游戏结束 */
  over() {
    this._play((ctx) => {
      const t = ctx.currentTime;
      const freqs = [784, 659, 523, 392]; // G E C G4 下行
      freqs.forEach((f, i) => {
        this._osc(ctx, 'sine', f, t + i * 0.15, 0.25, 0.3, 0);
      });
    });
  }
}

export const audio = new AudioSystem();
