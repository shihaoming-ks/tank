/**
 * 结构化日志
 *
 * 为什么一开始就用单行 JSON 而不是 console.log 拼字符串：
 * S5 上容器云后，日志平台需要按字段检索（roomId / playerId / evt）。
 * 若前期随手写 `console.log('player joined ' + id)`，上线时必须回头重构一遍。
 * 因此格式在项目第一天就固定下来。
 *
 * 输出示例：
 * {"ts":"2026-07-28T09:00:00.000Z","level":"info","evt":"player_join","roomId":"1234"}
 */

import { LOG_LEVEL, NODE_ENV } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[LOG_LEVEL] ?? LEVELS.info;

/** 开发环境用彩色单行文本，便于肉眼扫；生产环境用纯 JSON，便于机器采集 */
const PRETTY = NODE_ENV === 'development';

const COLOR = {
  debug: '\x1b[90m', // 灰
  info: '\x1b[36m', // 青
  warn: '\x1b[33m', // 黄
  error: '\x1b[31m', // 红
  reset: '\x1b[0m',
};

function emit(level, fields) {
  if (LEVELS[level] < threshold) return;

  const ts = new Date().toISOString();
  const record = { ts, level, ...fields };

  if (PRETTY) {
    const { evt, msg, ...rest } = fields;
    const extra = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
    const time = ts.slice(11, 23); // 只留 HH:mm:ss.SSS
    console.log(
      `${COLOR[level]}${time} ${level.toUpperCase().padEnd(5)}${COLOR.reset} ` +
        `${evt ?? ''}${msg ? ` ${msg}` : ''}${extra}`
    );
  } else {
    console.log(JSON.stringify(record));
  }
}

export const logger = {
  debug: (fields) => emit('debug', fields),
  info: (fields) => emit('info', fields),
  warn: (fields) => emit('warn', fields),
  error: (fields) => emit('error', fields),
};
