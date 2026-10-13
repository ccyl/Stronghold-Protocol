// server/http/routes.js — the node:http request listener. Every response gets the security headers (common.js), then:
// (i18n-ignore-file: the error pages are bilingual by design, 中文 · English — docs/I18N.md)
//
//   * a URL longer than 4096 characters → 414; one that does not parse → 400;
//   * any method but GET / HEAD → 405 with `Allow: GET, HEAD`;
//   * GET /healthz → JSON status (protocol `version`, release `app`, uptime, the served `build`, sockets, sessions,
//     rooms, matches), never cached; `?traffic=1` adds the traffic counters (traffic.js: bytes by category since the
//     start, WebSocket wire and payload bytes) for a loopback or private-network client only — the maintainer's
//     decision of 2026-10-12: the figures are the host's, so any other client, also one a tunnel or proxy on this
//     machine forwards, gets the plain report (net.js clientAddress, honouring TRUST_PROXY like the WebSocket limits);
//   * everything else → the static files (static.js).
// Every response's body bytes count in the traffic counters (traffic.js meter). A route that throws is logged and
// answers 500.

import { PROTOCOL_VERSION, APP_VERSION } from '../../shared/constants.js';
import { buildTag } from './buildTag.js';
import { setSecurityHeaders, sendError, sendJson, splitUrl } from './common.js';
import { clientAddress, isLocalIp } from '../net.js';

const MAX_URL_LENGTH = 4096;

/** Read and parse a JSON request body (the admin API's POSTs); rejects past `limit` bytes. */
function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > limit) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

/**
 * Whether a socket peer is this machine or a private network (Paper-Yuan fusion, `/lan/room`). `/lan/room` answers only
 * to these, so a client reaching the server through a tunnel or a public interface cannot probe which room codes exist.
 */
function isPrivateAddress(addr) {
  if (!addr) return false;
  const a = String(addr).toLowerCase().replace(/^::ffff:/, '');
  if (a === '::1') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (v4) {
    const o1 = +v4[1];
    const o2 = +v4[2];
    return o1 === 10 || o1 === 127 || (o1 === 192 && o2 === 168) || (o1 === 172 && o2 >= 16 && o2 <= 31)
      || (o1 === 100 && o2 >= 64 && o2 <= 127) // RFC 6598 CGNAT (Tailscale, ZeroTier, UU 等虚拟专网)
      || (o1 === 169 && o2 === 254);
  }
  return /^f[cd][0-9a-f]{1,2}:/.test(a); // IPv6 unique-local (fc00::/7)
}

/**
 * The GET /healthz body (`withTraffic`: plus the traffic counters and the asset index's state, `?traffic=1`).
 * @param {{ startedAt: number, network: import('../net.js').Network, registry: import('../net.js').SessionRegistry,
 *           lobby: import('../lobby.js').Lobby, traffic?: ReturnType<typeof import('./traffic.js').createTrafficCounter>,
 *           assetIndex?: ReturnType<typeof import('./assetIndex.js').createAssetIndex> | null,
 *           views?: ReturnType<typeof import('./assetViews.js').createManifestViews> | null }} health
 * @param {boolean} [withTraffic]
 */
export function healthReport({ startedAt, network, registry, lobby, traffic, assetIndex, views }, withTraffic = false) {
  const report = {
    ok: true, version: PROTOCOL_VERSION, app: APP_VERSION, uptimeSec: Math.round((Date.now() - startedAt) / 1000),
    // the runtime the server is serving right now (public/js/ui/buildGuard.js): a page whose own build is
    // older than this reloads itself, so a deploy reaches clients that never reload
    build: buildTag(),
    sockets: network.connectionCount, sessions: registry.size, ...lobby.stats(),
  };
  if (withTraffic && traffic) report.traffic = traffic.snapshot();
  // content-hashed asset URLs (assetIndex.js / assetViews.js): off, building, or ready with how many files and URLs
  if (withTraffic) report.assetHashes = assetIndex ? { ...assetIndex.stats(), views: views ? views.stats() : null } : null;
  return report;
}

/** Does the query ask for the traffic counters (`traffic`, `traffic=1`, `traffic=true`)? */
const wantsTraffic = (query) => /(?:^|&)traffic(?:=(?:1|true|yes))?(?:&|$)/i.test(query || '');

/**
 * The request listener for `http.createServer`.
 * @param {{ serveStatic: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>,
 *           health: Parameters<typeof healthReport>[0], log: object,
 *           admin?: import('../admin.js').AdminService | null,
 *           update?: ((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse,
 *             rawPath: string, query: string) => Promise<void>) | null,
 *           trustProxy?: 'auto' | boolean }} deps
 *   trustProxy: whose forwarding headers name the client (net.js clientAddress; the server's TRUST_PROXY)
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void}
 */
export function createRequestHandler({ serveStatic, health, log, admin = null, update = null, trustProxy = 'auto' }) {
  async function handleRequest(req, res) {
    const url = req.url || '/';
    if (url.length > MAX_URL_LENGTH) { sendError(req, res, 414, '请求地址过长 · URI too long'); return; }
    const parts = splitUrl(url);
    if (!parts) { sendError(req, res, 400, '请求地址无效 · Bad request'); return; }
    // 更新源（版本自检 / 自更新，server/http/update.js）：/update/latest.json、/update/MANIFEST.json、
    // /update/<name>.zip、/update/file?path=<受管路径> —— 由 SP_UPDATE_DIR 指到发布目录，不在安装目录里。
    if (update && (parts.rawPath === '/update' || parts.rawPath.startsWith('/update/'))) {
      await update(req, res, parts.rawPath, parts.query);
      return;
    }
    // 管理端 (Paper-Yuan fusion): the dashboard page and its API live before the GET/HEAD-only gate (the API POSTs)
    if (admin && (parts.rawPath === '/admin' || parts.rawPath === '/admin/')) {
      await serveStatic(req, res, '/admin/index.html', parts.query);
      return;
    }
    if (admin && parts.rawPath.startsWith('/api/admin/')) {
      if (!admin.authenticate(req)) {
        sendJson(req, res, 401, { ok: false, error: 'Unauthorized' });
        return;
      }
      if (parts.rawPath === '/api/admin/overview' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(req, res, 200, admin.getOverview());
        return;
      }
      if (parts.rawPath === '/api/admin/rooms' && (req.method === 'GET' || req.method === 'HEAD')) {
        sendJson(req, res, 200, admin.getRooms());
        return;
      }
      if (parts.rawPath === '/api/admin/logs' && (req.method === 'GET' || req.method === 'HEAD')) {
        const since = Number(new URLSearchParams(parts.query).get('since')) || 0;
        sendJson(req, res, 200, admin.getLogs(since));
        return;
      }
      if (parts.rawPath === '/api/admin/broadcast' && req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const ok = admin.broadcast(body.message);
          sendJson(req, res, 200, { ok });
        } catch {
          sendJson(req, res, 400, { ok: false, error: 'Invalid JSON' });
        }
        return;
      }
      if (parts.rawPath === '/api/admin/drain' && req.method === 'POST') {
        admin.startDrain();
        sendJson(req, res, 200, { ok: true, draining: true });
        return;
      }
      sendJson(req, res, 404, { ok: false, error: 'Not found' });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      sendError(req, res, 405, '不支持的请求方法 · Method not allowed');
      return;
    }
    if (parts.rawPath === '/healthz') {
      const withTraffic = wantsTraffic(parts.query) && isLocalIp(clientAddress(req, trustProxy).ip);
      sendJson(req, res, 200, healthReport(health, withTraffic));
      return;
    }
    // LAN room probe, so a guest can join with only the 4-letter key: the phone sweeps its own /24 and asks each
    // server it finds whether that room is open. It answers with a yes/no plus seat counts — never a room list, and
    // nothing at all to a peer outside the private ranges, so a public or tunnelled client cannot enumerate codes.
    if (parts.rawPath === '/lan/room') {
      if (!isPrivateAddress(req.socket?.remoteAddress)) { sendError(req, res, 404, '未找到 · Not found'); return; }
      const code = String(new URLSearchParams(parts.query).get('code') || '').toUpperCase();
      const room = /^[A-Z0-9]{4}$/.test(code) ? health.lobby.getRoom(code) : null;
      if (!room || room.mode !== 'coop') { sendError(req, res, 404, '未找到 · Not found'); return; }
      sendJson(req, res, 200, {
        ok: true, code: room.code, mode: room.mode, difficulty: room.difficulty,
        seats: room.seats.length, humans: room.seats.filter((s) => s && !s.isBot).length, inMatch: !!room.match,
      });
      return;
    }
    await serveStatic(req, res, parts.rawPath, parts.query);
  }

  return (req, res) => {
    setSecurityHeaders(res);
    if (health.traffic) health.traffic.meter(res, splitUrl(req.url || '/')?.rawPath || '/');
    handleRequest(req, res).catch((e) => {
      log.error('[http] request failed', e);
      sendError(req, res, 500, '服务器内部错误 · Internal error');
    });
  };
}
