#!/usr/bin/env node
/**
 * 一键全量冒烟
 *
 * 自动管理服务端生命周期，并为不同测试切换地图模式：
 *   - room / move：随机地图（move 需验证图块类型与生成比例）
 *   - combat：空旷地图（TANK_EMPTY_MAP=1）
 *
 * 为何 combat 需要空旷地图见 scripts/smoke-combat.js 中 shootUntilDead 的说明。
 *
 *   npm run smoke:all
 */

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const PORT = process.env.PORT || 8080;

/** 启动服务端并等待 /healthz 就绪 */
async function startServer(env) {
  // 端口被占时必须立即报错。
  // 否则会静默连到那个已有实例 —— 而它的地图模式可能与本组要求相反，
  // 导致测试莫名失败且极难定位（实测踩过：114/128 而非 128/128）。
  try {
    const res = await fetch(`http://localhost:${PORT}/healthz`);
    if (res.ok) {
      throw new Error(
        `端口 ${PORT} 已被占用。请先停止已有服务：lsof -ti :${PORT} | xargs kill`
      );
    }
  } catch (err) {
    if (err.message.includes('已被占用')) throw err;
    // 连接失败属预期，说明端口空闲
  }

  const proc = spawn('node', ['server/index.js'], {
    env: { ...process.env, ...env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/healthz`);
      if (res.ok) return proc;
    } catch {
      // 尚未就绪，继续等
    }
    await delay(150);
  }
  proc.kill('SIGKILL');
  throw new Error('服务端启动超时');
}

async function stopServer(proc) {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  // 等优雅退出，超时则强杀，避免端口占用影响下一组
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline && proc.exitCode === null) await delay(100);
  if (proc.exitCode === null) proc.kill('SIGKILL');
  await delay(300);
}

/** 运行一个冒烟脚本，返回 { pass, fail } */
function runScript(file) {
  return new Promise((resolve) => {
    const proc = spawn('node', [file], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    proc.stdout.on('data', (d) => {
      const text = d.toString();
      out += text;
      process.stdout.write(text);
    });
    proc.on('close', (code) => {
      // 从输出末尾解析统计行
      const m = out.match(/通过 \x1b\[32m(\d+)\x1b\[0m · 失败 \x1b\[31m(\d+)\x1b\[0m/);
      resolve({
        pass: m ? Number(m[1]) : 0,
        fail: m ? Number(m[2]) : code === 0 ? 0 : 1,
        code,
      });
    });
  });
}

const GROUPS = [
  {
    label: '随机地图模式',
    env: {},
    scripts: ['scripts/smoke-room.js', 'scripts/smoke-move.js', 'scripts/smoke-brick.js'],
  },
  {
    label: '空旷地图模式（TANK_EMPTY_MAP=1，战斗测试需无掩体）',
    env: { TANK_EMPTY_MAP: '1' },
    scripts: ['scripts/smoke-combat.js'],
  },
];

async function main() {
  let totalPass = 0;
  let totalFail = 0;

  for (const group of GROUPS) {
    console.log(`\n${'═'.repeat(52)}`);
    console.log(`  ${group.label}`);
    console.log(`${'═'.repeat(52)}`);

    const server = await startServer(group.env);
    try {
      for (const file of group.scripts) {
        const r = await runScript(file);
        totalPass += r.pass;
        totalFail += r.fail;
      }
    } finally {
      await stopServer(server);
    }
  }

  console.log(`\n${'═'.repeat(52)}`);
  console.log(`  全量合计：通过 \x1b[32m${totalPass}\x1b[0m · 失败 \x1b[31m${totalFail}\x1b[0m`);
  console.log(`${'═'.repeat(52)}\n`);
  process.exit(totalFail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('全量冒烟异常：', err.message);
  process.exit(1);
});
