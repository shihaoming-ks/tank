/**
 * 服务端运行配置
 *
 * 全部来自环境变量，带安全默认值。
 * 复制 .env.example 为 .env 可覆盖（S4 阶段会接入 dotenv，当前直接读 process.env）。
 */

/** HTTP + WebSocket 监听端口 */
export const PORT = Number(process.env.PORT) || 8080;

/** 监听地址。0.0.0.0 允许局域网其他设备访问，便于多设备联调 */
export const HOST = process.env.HOST || '0.0.0.0';

/** 运行环境 */
export const NODE_ENV = process.env.NODE_ENV || 'development';

/** 日志级别：debug | info | warn | error */
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

/**
 * WebSocket 来源白名单。
 * '*' 表示不校验 Origin（本地开发默认）。
 * S5 上线后应收敛为具体域名，防止其他站点盗连。
 */
export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

/** WebSocket 服务挂载路径 */
export const WS_PATH = '/ws';
