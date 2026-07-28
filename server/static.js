/**
 * 极简静态文件服务
 *
 * 不引入 express，因为需求只有"按前缀映射目录 + 正确 Content-Type"。
 *
 * 关键设计：Node 同时托管页面与 WebSocket，使前端连接与页面同源，
 * 彻底绕开跨域、混合内容、dev proxy 三类问题。
 */

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * 创建静态资源处理器。
 *
 * @param {Array<{prefix: string, dir: string}>} mounts
 *        挂载表，按顺序匹配。prefix 以 / 开头，dir 为绝对路径。
 * @returns {(req, res) => Promise<boolean>} 命中并已响应返回 true，未命中返回 false
 */
export function createStaticHandler(mounts) {
  const resolved = mounts.map((m) => ({ prefix: m.prefix, dir: resolve(m.dir) }));

  return async function handleStatic(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;

    // 去掉 query / hash，仅保留路径部分
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      return false; // URL 编码非法，交由上层返回 404
    }

    for (const { prefix, dir } of resolved) {
      if (!urlPath.startsWith(prefix)) continue;

      let rel = urlPath.slice(prefix.length);
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';

      // 目录穿越防护：normalize 后必须仍在挂载目录内。
      // 否则 /shared/../../.env 之类的请求可读到仓库外任意文件。
      const filePath = normalize(join(dir, rel));
      if (filePath !== dir && !filePath.startsWith(dir + sep)) {
        res.writeHead(403).end('Forbidden');
        return true;
      }

      try {
        const info = await stat(filePath);
        if (!info.isFile()) continue;

        res.writeHead(200, {
          'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'Content-Length': info.size,
          // 开发阶段禁用缓存，避免改完代码刷新还是旧版本
          'Cache-Control': 'no-cache',
        });

        if (req.method === 'HEAD') {
          res.end();
        } else {
          createReadStream(filePath).pipe(res);
        }
        return true;
      } catch {
        continue; // 该挂载点下无此文件，尝试下一个
      }
    }

    return false;
  };
}
