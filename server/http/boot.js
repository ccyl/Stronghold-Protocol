// server/http/boot.js — running the server as a process (`node server/index.js`, npm start, scripts/launch.mjs, the
// Windows service's scripts/run-server.cmd, NSSM, systemd):
//
//   * first, an update package extracted over the install (UPDATE.json) is finished — old files deleted, the install
//     verified (server/update.js); one that does not match its MANIFEST.json keeps the server from starting (exit 1);
//   * the boot banner: release version, the Local URL, the LAN URLs when listening on every interface, the
//     cloudflared command for internet play;
//   * a server that cannot start exits 1 (with a hint when the port is in use); unhandled rejections and uncaught
//     exceptions are logged, not fatal;
//   * graceful shutdown on SIGINT/SIGTERM (rooms get room.closed{reason:'shutdown'}, sockets close 1001); a second
//     signal exits at once, and the process exits anyway 5 s after the first.

import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { APP_VERSION, DEV_BUILD } from '../../shared/constants.js';
import { applyPendingUpdate } from '../update.js';
import { ROOT } from './config.js';

/** Non-internal IPv4 addresses as http URLs. @param {number} port */
export function lanUrls(port) {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`http://${a.address}:${port}`);
    }
  }
  return out;
}

/** Is the module whose `import.meta.url` is `metaUrl` the file node was started with? */
export function isProcessEntry(metaUrl) {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** Print the boot banner of a started server. @param {{ url: string, host: string, port: number }} srv */
export function printBanner(srv) {
  console.log(`\n  卫戍协议：盟约 · Stronghold Protocol: Alliance v${APP_VERSION}`);
  if (DEV_BUILD) console.log('  ! 开发版（dev 分支）：不稳定，请勿用于公开服务器 · development build — unstable, not for public servers');
  console.log(`  Local:   ${srv.url}`);
  if (srv.host === '0.0.0.0' || srv.host === '::') {
    for (const u of lanUrls(srv.port)) console.log(`  LAN:     ${u}`);
  }
  console.log('  Internet: cloudflared tunnel --url ' + `http://localhost:${srv.port}` + '\n');
}

/**
 * The process main: finish a pending update package, start the server, print the banner, stop gracefully on SIGINT /
 * SIGTERM.
 * @param {() => Promise<{ url: string, host: string, port: number, close: () => Promise<void> }>} start index.js startServer
 */
export async function runMain(start) {
  process.on('unhandledRejection', (e) => console.error('[process] unhandled rejection', e));
  process.on('uncaughtException', (e) => console.error('[process] uncaught exception', e));
  // before the data, the packs or the browser runtime are read: the files must be the new version's (server/update.js).
  // Nothing is listening yet, so returning ends the process with exit code 1 once the message is written.
  if (applyPendingUpdate(ROOT).state === 'failed') { process.exitCode = 1; return; }
  let srv;
  try {
    srv = await start();
  } catch (e) {
    if (e && e.code === 'EADDRINUSE') console.error(`端口已被占用 / port in use: ${e.port ?? process.env.PORT ?? 3000}. Try PORT=3001 npm start`);
    else console.error('[boot] failed to start', e);
    process.exit(1);
  }
  printBanner(srv);
  // 管理端 (Paper-Yuan fusion): the terminal maintenance console
  console.log('  [提示] 输入 "m 60" 即可向全服广播 60 秒维护倒计时；按 Ctrl+C 亦会自动触发。\n');

  let stopping = false;
  const stop = (signal) => {
    if (stopping) { console.log('forced exit'); process.exit(1); }
    stopping = true;
    console.log(`\n[${signal}] shutting down…`);
    setTimeout(() => process.exit(0), 5000).unref();
    srv.close().then(() => process.exit(0), () => process.exit(1));
  };

  // Interactive maintenance commands in terminal
  if (process.stdin.isTTY) {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      const line = String(chunk).trim();
      if (!line) return;
      const parts = line.split(/\s+/);
      const cmd = parts[0];
      const arg1 = parts[1];
      const rest = parts.slice(2).join(' ');
      if (cmd === 'm' || cmd === 'maintain') {
        if (arg1 === 'cancel') {
          const ok = srv.lobby.cancelMaintenance();
          console.log(ok ? '  [运维] 已取消停服维护通知' : '  [运维] 当前未处于维护状态');
        } else if (arg1 === 'now') {
          console.log('  [运维] 立即停机退出');
          stop('MAINTENANCE_NOW');
        } else {
          const sec = Number(arg1) > 0 ? Number(arg1) : 60;
          const reason = rest || '系统例行维护'; // i18n-ignore: server-sent text; the client translates msg.reason (main.js)
          console.log(`  [运维] 已向全服广播维护通知：${sec} 秒后停机 (${reason})`);
          srv.lobby.startMaintenance(sec, reason, () => stop('MAINTENANCE_DEADLINE'));
        }
      } else if (cmd === 'help') {
        console.log('  运维指令:');
        console.log('    m 60 [原因]   - 广播 60 秒停服维护倒计时');
        console.log('    m cancel      - 取消维护倒计时');
        console.log('    m now         - 立即停机退出');
      }
    });
  }

  process.on('SIGINT', () => {
    if (stopping) { stop('SIGINT'); return; }
    if (srv.lobby.maintenance) {
      console.log('\n[SIGINT] 再次按下 Ctrl+C，立即强制退出！');
      stop('SIGINT');
      return;
    }
    console.log('\n[SIGINT] ⚠ 收到退出信号，已向全服广播 60 秒停服维护倒计时！');
    console.log('         如需立即强制退出，请再次按下 Ctrl+C。');
    srv.lobby.startMaintenance(60, '服务器即将关闭维护', () => stop('MAINTENANCE')); // i18n-ignore: server-sent text; the client translates msg.reason (main.js)
  });
  process.on('SIGTERM', () => stop('SIGTERM'));
}
