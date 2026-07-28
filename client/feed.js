/**
 * 战报（事件流）
 *
 * 把服务端下发的 event 消息翻译成人类可读的一行文字。
 *
 * ⚠️ 只做展示，不参与任何判定。文案生成依赖服务端给的 actor / target 字段，
 *    客户端不自行推断"谁打了谁"。
 */

import { END_REASON } from '/shared/constants.js';
import { EVENT_KIND } from '/shared/protocol.js';

/** 最多保留的条目数。过多会拖慢 DOM 且无人回看 */
const MAX_ENTRIES = 60;

export class Feed {
  /** @param {HTMLElement} listEl */
  constructor(listEl) {
    this.el = listEl;
  }

  /**
   * 追加一条战报。
   * @param {string} text 正文
   * @param {object} opt  { color, tone }
   */
  push(text, opt = {}) {
    const li = document.createElement('li');
    li.className = `feed-item${opt.tone ? ` feed-${opt.tone}` : ''}`;

    const time = document.createElement('span');
    time.className = 'feed-time';
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });

    const body = document.createElement('span');
    body.className = 'feed-text';
    body.textContent = text;
    if (opt.color) body.style.color = opt.color;

    li.append(time, body);
    // 最新在上，避免用户需要手动滚到底部
    this.el.prepend(li);

    while (this.el.children.length > MAX_ENTRIES) {
      this.el.lastElementChild.remove();
    }
  }

  clear() {
    this.el.innerHTML = '';
  }

  /**
   * 处理一批服务端事件。
   * @param {Array<object>} events
   */
  handleEvents(events) {
    for (const ev of events) {
      switch (ev.kind) {
        case EVENT_KIND.JOIN:
          this.push(`${ev.actor} 进入房间`, { color: ev.color, tone: 'join' });
          break;

        case EVENT_KIND.LEAVE:
          this.push(
            ev.reason === 'disconnect' ? `${ev.actor} 掉线离开` : `${ev.actor} 退出房间`,
            { color: ev.color, tone: 'leave' }
          );
          break;

        case EVENT_KIND.START:
          this.push('对局开始', { tone: 'system' });
          break;

        case EVENT_KIND.HIT:
          // 撞墙的命中事件只用于特效，不写战报，否则会被刷屏
          if (ev.wall) break;
          const verb = ev.ram ? '撞上了' : '击中了';
        this.push(`${ev.actor} ${verb} ${ev.target}（剩余 ${ev.hp} 血）`, {
            color: ev.color,
            tone: 'hit',
          });
          break;

        case EVENT_KIND.KILL:
          this.push(ev.ram ? `${ev.target} 因撞击被淘汰` : `${ev.actor} 淘汰了 ${ev.target}`, { color: ev.color, tone: 'kill' });
          break;

        case EVENT_KIND.RESPAWN:
          this.push(`${ev.actor} 已复活`, { color: ev.color, tone: 'system' });
          break;

        case EVENT_KIND.HOST:
          this.push(`${ev.actor} 成为房主`, { color: ev.color, tone: 'system' });
          break;

        default:
          break;
      }
    }
  }

  /** 对局结束的战报文案 */
  handleOver(result) {
    const text =
      result.reason === END_REASON.ABORTED
        ? '对局中止：玩家不足'
        : result.winnerName
          ? `${result.winnerName} 获得胜利`
          : '对局结束：平局';
    this.push(text, { tone: 'over' });
  }
}
