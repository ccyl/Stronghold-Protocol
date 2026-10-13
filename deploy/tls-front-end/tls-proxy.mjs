// tls-proxy.mjs —— SakuraFrp 的免费节点会拦截**明文 HTTP**（返回 501：机房合规要求），但 TCP 隧道本身是通的、
// 非 HTTP 的字节能正常穿过去。所以这里做一个极小的 TLS 前端：把隧道来的 HTTPS/WSS 解开，按原样管道给明文的
// 游戏服务端（127.0.0.1:3000）。HTTP、WebSocket 升级都走同一条管道，不需要任何协议感知。
//
//   TLS_PORT=3443 TARGET_HOST=127.0.0.1 TARGET_PORT=3000 node tls-proxy.mjs
//
// 证书用自签（见同目录 tls.crt）：客户端会提示一次不受信任 —— 浏览器可以点继续，启动器会问一次（已有那套流程），
// 命令行 tools/update.mjs 用 --insecure 时必须同时给 --pubkey（签名才是内容可信的那道门）。

import fs from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const PORTS = String(process.env.TLS_PORT || 3443).split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
const HOST = process.env.TLS_BIND || '0.0.0.0';
const TARGET_HOST = process.env.TARGET_HOST || '127.0.0.1';
const TARGET_PORT = Number(process.env.TARGET_PORT || 3000);
const CERT = process.env.TLS_CERT || '/home/gyx/stronghold-tls/tls.crt';
const KEY = process.env.TLS_KEY || '/home/gyx/stronghold-tls/tls.key';

const log = (...a) => console.log(new Date().toISOString(), ...a);

let KEY_PEM;
let CERT_PEM;
try {
  KEY_PEM = fs.readFileSync(KEY);
  CERT_PEM = fs.readFileSync(CERT);
} catch (e) {
  log('读不到证书/私钥：', e.message);
  process.exit(1);
}

/** 一条隧道连接：TLS 解开后原样管道给后端（明文 HTTP/WS）。 */
function onConnection(socket) {
  const up = net.connect({ host: TARGET_HOST, port: TARGET_PORT });
  const done = (why, err) => {
    if (err && err.code !== 'ECONNRESET' && err.code !== 'EPIPE') log(why, err.code || err.message);
    try { socket.destroy(); } catch { /* ignore */ }
    try { up.destroy(); } catch { /* ignore */ }
  };
  socket.on('error', (e) => done('客户端侧出错', e));
  up.on('error', (e) => done('后端连不上', e));
  up.on('connect', () => log(`进入连接 ${socket.remoteAddress} → ${TARGET_HOST}:${TARGET_PORT}`));
  // 双向管道：HTTP 响应、WebSocket 升级与帧都按字节透传；任一侧正常结束会把另一侧也 end 掉
  socket.pipe(up);
  up.pipe(socket);
}

// 注意：tls.createServer 要的是 key / cert，不能把 SecureContext 展开进去（那个对象没有可枚举属性，
// 展开等于空对象 → 握手时没有证书，客户端报 SSL connect error）。
const servers = [];
for (const port of PORTS) {
  const server = tls.createServer({ key: KEY_PEM, cert: CERT_PEM, minVersion: 'TLSv1.2', ALPNProtocols: ['http/1.1'] }, onConnection);
  server.on('tlsClientError', (e) => log(`:${port} TLS 握手失败（可能是直接拿 HTTP 打这个端口）：`, e.code || e.message));
  server.on('error', (e) => log(`:${port} 监听失败：`, e.code || e.message));
  server.listen(port, HOST, () => log(`TLS 前端已监听 ${HOST}:${port} → ${TARGET_HOST}:${TARGET_PORT}（证书 ${CERT}）`));
  servers.push(server);
}

if (!servers.length) { log('没有可监听的端口（TLS_PORT 写错了？）'); process.exit(1); }

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log(`收到 ${sig}，退出`);
    for (const s of servers) { try { s.close(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(0), 1500).unref();
  });
}