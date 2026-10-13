// server/http/update.js — 更新源端点（版本自检 / 自更新）：由 routes.js 在 /update/ 前缀上转进来。
// (i18n-ignore-file: 调试文本按项目惯例双语 —— docs/I18N.md)
//
//   GET /update/latest.json        发布信息（tools/make-update.mjs 写进 SP_UPDATE_DIR）：版本、order、内容摘要、
//                                  更新包名与 sha256、适用版本 from、说明
//   GET /update/latest.json.sig    上面那份的 ed25519 签名（客户端内置公钥校验）
//   GET /update/MANIFEST.json      受管文件的 size+sha256（逐文件同步用；客户端按它比对本地）
//   GET /update/<name>.zip         更新包（Range 续传由 files.js serveFile 提供）
//   GET /update/file?path=<rel>    服务端这份安装里某个受管文件的字节（逐文件同步用）
//   GET /update/                  一份自述 JSON（排障用）
//
// 一致性：/update/latest.json 与 MANIFEST.json 是**发布脚本的产物**（不是运行时现算的），运行目录里的文件必须与
// MANIFEST.json 的 sha256 一致才发得出去 —— 半途部署的服务端只会让客户端校验失败重试，不会下发错字节。
// 目录来自 SP_UPDATE_DIR（默认 <ROOT>/updates）。空的更新目录不算错误：只有 /update/ 自述可用，其余 404。
//
// 逐文件同步只对**受管路径**开（MANIFEST.json 里列出的），并再挡一次目录穿越 —— 绝不把整个安装目录暴露出去。

import fs from 'node:fs';
import path from 'node:path';
import { sendError, sendJson } from './common.js';
import { GzipCache, serveFile } from './files.js';
import { MANIFEST_FILE, isControlled, loadFeed } from '../updateSet.js';

/** 允许静态下发的后缀（发布目录里只该有这些）。 */
const ONLY = new Set(['.json', '.zip', '.sig', '.txt', '.sha256']);

/** 一个可缓存的 JSON 文件（按 mtime+size 失效）。 @param {string} abs */
function readJsonCached(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return { state: 'missing' }; }
  const tag = `${st.size}-${st.mtimeMs}`;
  const cached = readJsonCached.cache?.get(abs);
  if (cached && cached.tag === tag) return cached.value;
  let value;
  try {
    const json = JSON.parse(fs.readFileSync(abs, 'utf8'));
    value = json && typeof json === 'object' ? { state: 'ok', json, size: st.size } : { state: 'bad' };
  } catch (e) {
    value = { state: 'bad', error: e?.message || String(e) };
  }
  (readJsonCached.cache ||= new Map()).set(abs, { tag, value });
  return value;
}

/**
 * Create the /update/ handler.
 * @param {{ dir: string, root: string, log?: import('./config.js').noopLog }} o
 *   dir: the published update folder (SP_UPDATE_DIR); root: the install tree the per-file endpoint serves from
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, rawPath: string, query: string) => Promise<void>}
 */
export function createUpdateHandler({ dir, root, log = console }) {
  const updateDir = path.resolve(dir);
  const treeRoot = path.resolve(root);
  const manifestPath = path.join(updateDir, MANIFEST_FILE);
  const gzipCache = new GzipCache();   // 与静态服务同一套：json / js 走内存 gzip 缓存，zip 不是可压缩类型 → 原样流式（Range 续传）

  return async function serveUpdate(req, res, rawPath, query) {
    const rel = decodeURIComponent(rawPath.slice('/update/'.length));
    const q = new URLSearchParams(query || '');

    // 自述（排障：更新源有没有配好、里面有什么）
    if (rel === '' || rel === '/') {
      const feed = readJsonCached(path.join(updateDir, 'latest.json'));
      let files = [];
      try { files = fs.readdirSync(updateDir).sort(); } catch { files = []; }
      sendJson(req, res, 200, {
        ok: true, service: 'stronghold-update', dir: updateDir, tree: treeRoot,
        feed: feed.state === 'ok' ? { app: feed.json.app, order: feed.json.order, digest: feed.json.digest, from: feed.json.from } : feed.state,
        files,
        endpoints: ['/update/latest.json', '/update/latest.json.sig', `/update/${MANIFEST_FILE}`, '/update/<name>.zip', '/update/file?path=<rel>'],
      });
      return;
    }

    // 逐文件同步：受管路径才给，且必须在本发布清单里
    if (rel === 'file') {
      const want = String(q.get('path') || '');
      if (!want || !isControlled(want)) { sendError(req, res, 403, '不是受管路径 · Not a managed path'); return; }
      const m = readJsonCached(manifestPath);
      if (m.state !== 'ok') { sendError(req, res, 404, '服务端没有发布清单 · no MANIFEST.json'); return; }
      const entry = m.json.files?.[want];
      if (!entry) { sendError(req, res, 404, '这个文件不在发布清单里 · not in MANIFEST.json'); return; }
      const abs = path.join(treeRoot, ...want.split('/'));
      if (!abs.startsWith(treeRoot + path.sep)) { sendError(req, res, 403, '禁止访问 · Forbidden'); return; }
      let st;
      try { st = fs.statSync(abs); } catch { sendError(req, res, 404, '服务端没有这个文件 · not found'); return; }
      if (!st.isFile()) { sendError(req, res, 404, '不是文件 · not a file'); return; }
      if (st.size !== entry.size) {
        // 运行目录与发布清单对不上（部署做到一半）：宁可不给，让客户端重试
        sendError(req, res, 503, '服务端文件与发布清单不一致，稍后重试 · the server disagrees with its MANIFEST.json');
        return;
      }
      await serveFile(req, res, abs, st, 'update', ['file'], query, gzipCache, log);
      return;
    }

    // 发布目录里的静态文件（latest.json / *.sig / MANIFEST.json / *.zip）
    const name = rel.replace(/^\/+/, '');
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
      sendError(req, res, 404, '页面不存在 · Not found');
      return;
    }
    if (!ONLY.has(path.extname(name).toLowerCase())) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
    const abs = path.join(updateDir, name);
    let st;
    try { st = fs.statSync(abs); } catch { sendError(req, res, 404, '更新源里还没有这个文件 · not published yet'); return; }
    if (!st.isFile()) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
    // latest.json 每次都要新（客户端缓存里过期的版本号比没有更糟）
    if (name === 'latest.json') { await serveFile(req, res, abs, st, 'update', ['latest.json'], 'no-cache=1', gzipCache, log); return; }
    await serveFile(req, res, abs, st, 'update', [name], query, gzipCache, log);
  };
}

/** 校验一份 latest.json 是否是本服务端能读的（启动时自检用，失败只告警不拦启动）。 */
export function checkUpdateFeed(dir) {
  const p = path.join(dir, 'latest.json');
  const r = readJsonCached(p);
  if (r.state === 'missing') return { state: 'none' };
  if (r.state !== 'ok') return { state: 'broken', error: r.error };
  try { return { state: 'ok', feed: loadFeed(JSON.stringify(r.json)) }; } catch (e) { return { state: 'broken', error: e?.message || String(e) }; }
}