#!/usr/bin/env node
// tools/update.mjs — 客户端：版本自检 + 一键更新（服务端一侧是 server/http/update.js 的 /update/ 端点）。
//
//   node tools/update.mjs check [--root <安装目录>] [--source <http(s)://主机:端口 | 本地目录>] [--json] [--deep]
//   node tools/update.mjs apply [--root <安装目录>] [--source <…>] [--json] [--mode auto|zip|files]
//        [--zip <本地更新包.zip>] [--pubkey <公钥.pem|目录>]… [--insecure] [--no-setup] [--force] [--progress]
//
// 干什么：
//   check —— 读本机版本 + 受管集合的内容摘要（server/updateSet.js），拉 <source>/update/latest.json，给出四种结论：
//     current        版本与内容都与发布方一致
//     outdated       发布方版本更新（同时说清本机版本在不在 from 列表里 —— 在就能用更新包，不在就走逐文件同步）
//     drifted        **版本号一样但内容不一样**（今天 0.2.4-fusion-20p 的两份安装就有 71 处不同：版本号看不出来）
//     server-behind  本机比发布方还新（不更新，只提示）
//   apply —— 一键更新到发布方版本：
//     * 能用更新包（本机版本在 from 列表里）→ 下载 zip（断点续传）→ 校验 sha256 → 解压（工具自带 readZip，
//       逐条 pathProblem 防目录穿越，先写 .sp-tmp 再改名）→ 再由 server/update.js 的 applyPendingUpdate 收尾：
//       按新版本的 MANIFEST.json 核对整个安装、删掉新版本不再用的旧文件、把 UPDATE.json 改名；
//     * 用不了更新包（版本对不上 / 内容漂移）→ **逐文件同步**：按发布方 MANIFEST.json 只取缺的与内容不对的文件
//       （/update/file?path=，每个文件校验 sha256），再按发布方的 removed 列表删旧文件（只删内容与旧版本一致的）。
//   收尾：重算摘要与发布方比对；然后（默认）跑 node tools/setup.mjs --quiet 补素材 —— 素材不进摘要，
//   更新包与逐文件同步都不搬 public/assets（那是 setup 的活）。
//
// 安全：latest.json 用发布方的 ed25519 公钥验签；每个文件另有 sha256 校验。**公钥可放多把（多信任根，
// 任一把验过即通过）**，按这个顺序取：`--pubkey`（可重复，文件或目录）→ `SP_UPDATE_PUBKEY`（可多个，用
// 路径分隔符）→ **安装目录之外**的 `update-pubkey.d/*.pem` 与 `update-pubkey.pem`（app 的上一级 = 客户端包
// 根目录）。自签证书（SakuraFrp 之类的隧道）要用 --insecure 时必须同时给公钥 —— 传输不可信就只剩签名这一道门。
// （--insecure 只影响 TLS 校验，不改任何其它行为。）
//
// 不用 --root 时，安装目录 = 本文件所在目录的上一级（tools/ 在安装根里）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readZip } from './package-update.mjs';
import { applyPendingUpdate, deleteRemoved, parseManifest, pathProblem } from '../server/update.js';
import {
  FEED_URL, MANIFEST_URL, FILE_URL,
  artState, diffState, fmtBytes, isNewer, keyFingerprint, loadFeed, localStateFor, readVersion, stateDigest, verifyFeedBy, walkTree, writeFileAtomic,
} from '../server/updateSet.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const USAGE = `usage:
  node tools/update.mjs check [--root <安装目录>] [--source <http(s)://主机:端口|目录>] [--json] [--deep]
  node tools/update.mjs apply [--root <安装目录>] [--source …] [--mode auto|zip|files] [--zip <更新包.zip>]
       [--pubkey <公钥.pem|目录>]… [--insecure] [--no-setup] [--force] [--json]`;

export function parseArgs(argv) {
  const o = {
    cmd: argv[0] && !argv[0].startsWith('-') ? argv[0] : 'check',
    root: null, source: null, pubkey: [], zip: null, mode: 'auto', json: false, deep: false,
    force: false, insecure: false, setup: true, progress: false, timeout: 20000, keepZip: null, help: false,
  };
  const rest = o.cmd === argv[0] ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    const val = () => rest[++i];
    if (a === '--root') o.root = val();
    else if (a.startsWith('--root=')) o.root = a.slice(7);
    else if (a === '--source') o.source = val();
    else if (a.startsWith('--source=')) o.source = a.slice(9);
    else if (a === '--pubkey') o.pubkey.push(val());
    else if (a.startsWith('--pubkey=')) o.pubkey.push(a.slice(9));
    else if (a === '--zip') o.zip = val();
    else if (a.startsWith('--zip=')) o.zip = a.slice(6);
    else if (a === '--mode') o.mode = val();
    else if (a.startsWith('--mode=')) o.mode = a.slice(7);
    else if (a === '--keep-zip') o.keepZip = val();
    else if (a === '--no-setup') o.setup = false;
    else if (a === '--json') o.json = true;
    else if (a === '--deep') o.deep = true;
    else if (a === '--dry-run' || a === '--dry') o.dryRun = true;
    else if (a === '--force') o.force = true;
    else if (a === '--insecure') o.insecure = true;
    else if (a === '--progress') o.progress = true;
    else if (a === '--timeout') o.timeout = Number(val()) || o.timeout;
    else if (a.startsWith('--timeout=')) o.timeout = Number(a.slice(10)) || o.timeout;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

// ---------------------------------------------------------------------------------------------------
// 更新源与取数（http(s) 或本地目录 —— 后者用于离线/回环测试）
// ---------------------------------------------------------------------------------------------------

const isHttp = (s) => /^https?:\/\//i.test(String(s));

/** 找更新源：--source > SP_UPDATE_SOURCE > 启动器 shell.json 的 updateSource > shell-state.json 的 defaultServer > shell.json 的 server。 */
export function resolveSource(root, cli) {
  const norm = (s) => {
    if (!s) return null;
    let v = String(s).trim().replace(/\/+$/, '');
    if (!v) return null;
    if (/\/update$/i.test(v)) v = v.slice(0, -'/update'.length);        // 两种写法都行：主机:端口 或 主机:端口/update
    if (!isHttp(v) && !path.isAbsolute(v) && !/^[a-zA-Z]:[\\/]/.test(v) && !v.startsWith('.')) v = `http://${v}`;
    return v;
  };
  if (cli) return norm(cli);
  if (process.env.SP_UPDATE_SOURCE) return norm(process.env.SP_UPDATE_SOURCE);
  const shellDir = path.join(path.dirname(root), '');
  const readKey = (file, key) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8'))[key]; } catch { return null; }
  };
  const candidates = [
    [path.join(shellDir, 'shell.json'), 'updateSource'],
    [path.join(shellDir, 'shell-state.json'), 'updateSource'],
    [path.join(shellDir, 'shell-state.json'), 'defaultServer'],
    [path.join(shellDir, 'shell.json'), 'server'],
    [path.join(root, '..', 'shell.json'), 'updateSource'],
  ];
  for (const [file, key] of candidates) {
    const v = norm(readKey(file, key));
    if (v) return v;
  }
  return null;
}

function fetchUrl(url, { timeout, insecure }) {
  const args = insecure ? { headers: { 'Cache-Control': 'no-cache' } } : {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  return fetch(url, { ...args, signal: ctrl.signal, cache: 'no-store' }).finally(() => {
    clearTimeout(timer);
    if (insecure) {
      if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
    }
  });
}

/** 取一个相对路径（/update/latest.json 这类）：http(s) 直接 GET，本地目录直接读。relPath 本身是完整 http(s) 地址时按它取。 */
export async function readSource(source, relPath, { timeout = 20000, insecure = false, binary = false } = {}) {
  if (isHttp(relPath)) {
    const res = await fetchUrl(relPath, { timeout, insecure });
    if (!res.ok) throw new Error(`${relPath}: HTTP ${res.status} ${res.statusText}`);
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  }
  if (isHttp(source)) {
    const res = await fetchUrl(`${source}${relPath}`, { timeout, insecure });
    if (!res.ok) throw new Error(`${relPath}: HTTP ${res.status} ${res.statusText}`);
    return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
  }
  // 本地目录更新源：/update/latest.json → <目录>/latest.json（逐文件同步不支持，apply 里另有拦截）
  const rel = String(relPath).replace(/^\/?update\//, '').replace(/^\/+/, '').split('?')[0];
  const abs = path.join(source, ...rel.split('/'));
  return binary ? fs.readFileSync(abs) : fs.readFileSync(abs, 'utf8');
}

/** 下载到文件（http：支持断点续传 —— 半截文件留着，下次带 Range 接着要；每次都校验 sha256）。 */
export async function downloadTo(source, relPath, destAbs, { sha256 = null, size = null, timeout = 60000, insecure = false, tries = 3, log = () => {} } = {}) {
  const url = isHttp(relPath) ? relPath : `${source}${relPath}`;
  if (!isHttp(url)) {
    const buf = await readSource(source, relPath, { binary: true });
    if (size != null && buf.length !== size) throw new Error(`${relPath}: 大小不符（要 ${size}，得 ${buf.length}）`);
    if (sha256 && crypto.createHash('sha256').update(buf).digest('hex') !== sha256) throw new Error(`${relPath}: sha256 不符`);
    writeFileAtomic(destAbs, buf);
    return { bytes: buf.length, resumed: false };
  }
  const part = `${destAbs}.part`;
  let resumed = false;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const have = fs.existsSync(part) ? fs.statSync(part).size : 0;
    const req = have > 0 ? { headers: { Range: `bytes=${have}-` } } : {};
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    const prev = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    if (insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      const res = await fetch(url, { ...req, signal: ctrl.signal });
      if (res.status === 206 && have > 0) resumed = true;
      else if (have > 0 && res.status === 200) fs.rmSync(part, { force: true });      // 服务端不支持续传 → 重头下
      if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      fs.mkdirSync(path.dirname(part), { recursive: true });
      fs.appendFileSync(part, Buffer.from(await res.arrayBuffer()));
      const got = fs.statSync(part).size;
      if (size != null && got !== size) throw new Error(`大小不符（要 ${size}，得 ${got}）`);
      if (sha256) {
        const h = crypto.createHash('sha256');
        h.update(fs.readFileSync(part));
        if (h.digest('hex') !== sha256) { fs.rmSync(part, { force: true }); throw new Error('sha256 不符'); }
      }
      fs.renameSync(part, destAbs);
      return { bytes: got, resumed };
    } catch (e) {
      if (attempt === tries) throw new Error(`${relPath}: ${e?.message || e}`);
      log(`  下载失败（第 ${attempt}/${tries} 次）：${e?.message || e} —— 重试`);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    } finally {
      clearTimeout(timer);
      if (insecure) {
        if (prev === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
        else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prev;
      }
    }
  }
  throw new Error(`${relPath}: 下载失败`);
}

/**
 * 公钥（信任根，可多把）：`--pubkey`（可重复，文件或目录）/ `SP_UPDATE_PUBKEY`（可多个，用路径分隔符）/
 * **安装目录之外**的 `update-pubkey.d/*.pem` 与 `update-pubkey.pem`（app 的上一级 = 客户端包根目录）。
 * 刻意不读安装目录（app）里的那一份：那份会被更新本身覆盖，等于让更新源自己给自己发通行证。
 * 多把时**任一把验过即通过**（自己的服 + 上游/官方服各一把，互不影响）。
 * @param {string} root 安装目录（app 目录）
 * @param {string|string[]|null} [cli] --pubkey 的值（文件或目录，可多个）
 * @returns {Array<{ path: string, pem: string }>} 按内容去重后的公钥列表
 */
export function readPubkeys(root, cli) {
  const out = [];
  const seen = new Set();
  const add = (p) => {
    if (!p) return;
    try {
      if (fs.statSync(p).isDirectory()) {
        for (const f of fs.readdirSync(p).filter((n) => n.toLowerCase().endsWith('.pem')).sort()) add(path.join(p, f));
        return;
      }
    } catch { return; }                        // 路径不存在：跳过
    try {
      const pem = fs.readFileSync(p, 'utf8');
      if (!seen.has(pem)) { seen.add(pem); out.push({ path: p, pem }); }
    } catch { /* 读不了：跳过 */ }
  };
  for (const c of Array.isArray(cli) ? cli : [cli].filter(Boolean)) add(c);
  for (const c of String(process.env.SP_UPDATE_PUBKEY || '').split(path.delimiter).filter(Boolean)) add(c);
  const parent = path.dirname(root);
  add(path.join(parent, 'update-pubkey.d'));
  add(path.join(parent, 'update-pubkey.pem'));
  return out;
}

/** 兼容旧签名：只要第一把。新代码用 readPubkeys()。 */
export const readPubkey = (root, cli) => readPubkeys(root, cli)[0]?.pem ?? null;

// ---------------------------------------------------------------------------------------------------
// 自检
// ---------------------------------------------------------------------------------------------------

/** 本机服务端是否在跑（更新要先停服：Windows 上正被加载的模块文件换不掉，换掉也会让跑着的服务读到半个版本）。 */
export async function localServerAlive(root, { timeout = 800 } = {}) {
  const ports = [];
  for (const file of ['shell.json', 'shell-state.json']) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(path.dirname(root), file), 'utf8'));
      if (Number(j.port)) ports.push(Number(j.port));
    } catch { /* ignore */ }
  }
  ports.push(3000, 3001, 3002);
  for (const p of [...new Set(ports)]) {
    try {
      const res = await fetch(`http://127.0.0.1:${p}/healthz`, { signal: AbortSignal.timeout(timeout) });
      if (res.ok) return p;
    } catch { /* not ours */ }
  }
  return 0;
}

/**
 * 一次版本自检。
 * @param {{ root: string, source: string, pubkeys?: Array<{path: string, pem: string}>|string|null, timeout?: number, insecure?: boolean, deep?: boolean }} o
 * @returns {Promise<object>} 扁平结果（每个值都是字符串 / 数字 / 布尔 —— 启动器的简易 JSON 解析就能读）
 */
export async function check({ root, source, pubkeys = null, timeout = 20000, insecure = false, deep = false }) {
  const { version, declared, mismatch } = readVersion(root);
  const out = {
    ok: true, state: 'unknown', app: version || '', declared: declared || '', versionMismatch: !!mismatch,
    digest: '', files: 0, bytes: 0, latest: '', order: 0, from: '', inFrom: false,
    zipCovers: false, zipName: '', zipSize: 0, zipUrl: '', manifestUrl: '', source, signed: false, signatureOk: false,
    signatureKeys: 0, signatureBy: '', signatureKeyPath: '',
    missing: 0, changed: 0, extra: 0, samples: '', notes: '', drift: 0,
    artFiles: 0, artBytes: 0, artDrift: 0,
  };
  if (!version) { out.ok = false; out.state = 'error'; out.notes = `${root} 里没有 package.json`; return out; }
  if (!source) { out.ok = false; out.state = 'error'; out.notes = '没有更新源（--source / SP_UPDATE_SOURCE / shell.json）'; return out; }

  let feed;
  try {
    feed = loadFeed(await readSource(source, FEED_URL, { timeout, insecure }));
  } catch (e) {
    out.ok = false; out.state = 'error'; out.notes = `读发布信息失败：${e?.message || e}`;
    return out;
  }
  out.latest = feed.app;
  out.order = feed.order ?? 0;
  out.notes = String(feed.notes || '').slice(0, 500);
  out.from = (feed.from || []).join(',');
  out.inFrom = (feed.from || []).includes(version);
  out.zipCovers = !!(feed.zip && out.inFrom);
  if (feed.zip) { out.zipName = feed.zip.name; out.zipSize = feed.zip.size || 0; out.zipUrl = feed.zip.url || ''; }
  out.manifestUrl = manifestRef(feed);
  out.bytes = feed.bytes || 0;
  out.signed = !!feed.sig;
  if (pubkeys) {
    // 多信任根：包内可以放多把公钥，任一把验过即通过（并报告是哪一把、指纹是多少）
    const list = (Array.isArray(pubkeys) ? pubkeys : [{ path: '', pem: pubkeys }]).filter((k) => k && k.pem);
    out.signatureKeys = list.length;
    const matched = verifyFeedBy(feed, list.map((k) => k.pem));
    if (!matched) { out.ok = false; out.state = 'error'; out.notes = '发布信息的签名不对（更新源不可信或公钥不匹配）'; return out; }
    out.signatureOk = true;
    out.signatureBy = keyFingerprint(matched);
    const hit = list.find((k) => k.pem === matched);
    out.signatureKeyPath = hit ? hit.path : '';
  } else if (feed.sig) {
    out.signatureOk = false;
  }

  const sameVersion = feed.app === version;
  // 版本号一样时"内容一样吗"只能对发布清单算；--deep 时版本不同也顺手算一次（看要动多少文件）
  let want = null;
  if (sameVersion || deep) {
    try {
      want = parseManifest(await readSource(source, out.manifestUrl, { timeout, insecure })).files;
    } catch (e) {
      out.notes = `${out.notes ? `${out.notes} · ` : ''}读发布清单失败：${e?.message || e}`.slice(0, 500);
    }
  }

  if (sameVersion) {
    if (!want) { out.state = 'unknown'; return out; }
    const localFor = localStateFor(root, want.keys());
    out.digest = stateDigest(localFor);
    out.files = want.size;
    const d = diffState(localFor, want);
    out.missing = d.missing.length;
    out.changed = d.changed.length;
    out.drift = d.missing.length + d.changed.length;
    out.samples = [...d.missing, ...d.changed].slice(0, 5).join(' ');
    // 本机多出来的受管文件（发布方不管的那些：客户端渠道里的开发文件等）—— 只是报告，不删也不算错
    out.extra = walkTree(root).filter((rel) => !want.has(rel)).length;
    // 素材：只比 (路径, 大小) 指纹（不读内容），报告"素材集合是否与发布方一致"
    if (feed.art) {
      const a = artState(root);
      out.artFiles = a.files;
      out.artBytes = a.bytes;
      out.artDrift = a.digest === feed.art.digest ? 0 : 1;
    }
    out.state = out.digest === feed.digest ? 'current' : 'drifted';
    return out;
  }

  out.state = isNewer({ app: feed.app, order: feed.order }, { app: version }) ? 'outdated' : 'server-behind';
  if (deep && want) {
    const localFor = localStateFor(root, want.keys());
    const d = diffState(localFor, want);
    out.files = want.size;
    out.missing = d.missing.length;
    out.changed = d.changed.length;
    out.drift = d.missing.length + d.changed.length;
    out.samples = [...d.missing, ...d.changed].slice(0, 5).join(' ');
  }
  return out;
}

/** 发布清单的相对地址（feed.manifest.url 可能是绝对地址）。 */
function manifestRef(feed) {
  const u = feed?.manifest?.url;
  if (!u) return MANIFEST_URL;
  return /^https?:/i.test(u) ? u : (u.startsWith('/') ? u : `/${u}`);
}

// ---------------------------------------------------------------------------------------------------
// 一键更新
// ---------------------------------------------------------------------------------------------------

/**
 * Apply the published version to the install at `root`.
 * @param {object} o see check() plus { zip, mode, setup, force, dryRun }
 */
export async function apply(o) {
  const { root, source, pubkeys = null, timeout = 20000, insecure = false, log = () => {} } = o;
  const before = await check({ root, source, pubkeys, timeout, insecure });
  const res = { ...before, applied: false, mode: '', wrote: 0, removed: 0, setup: 'skipped', after: '', error: '' };
  if (!before.ok) return res;
  if (before.state === 'current') { res.notes = '已经是最新，什么都不做'; return res; }
  if (before.state === 'server-behind') { res.ok = false; res.error = `本机 v${before.app} 比发布方 v${before.latest} 还新，不自动降级`; return res; }

  const alive = await localServerAlive(root);
  if (alive && !o.force) {
    res.ok = false;
    res.error = `本机服务端还在跑（127.0.0.1:${alive}）：先停掉它再更新（启动器会自动停；命令行加 --force 可强制）`;
    return res;
  }

  const feed = loadFeed(await readSource(source, FEED_URL, { timeout, insecure }));
  const want = parseManifest(await readSource(source, manifestRef(feed), { timeout, insecure })).files;
  const plan = diffState(localStateFor(root, want.keys()), want);

  const useZip = o.zip || (o.mode !== 'files' && o.mode !== 'files-only' && feed.zip && before.inFrom);
  if (!useZip && !isHttp(source)) {
    res.ok = false;
    res.error = '本地目录更新源只能用更新包（逐文件同步要服务器的 /update/file）：加 --zip <更新包.zip>，或把 --source 换成服务端地址';
    return res;
  }
  if (o.dryRun) {
    res.mode = useZip ? 'zip' : 'files';
    res.missing = plan.missing.length; res.changed = plan.changed.length;
    res.notes = `计划：${useZip ? `更新包 ${feed.zip?.name}` : `逐文件同步（缺 ${plan.missing.length}，改 ${plan.changed.length}）`}`;
    return res;
  }

  const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || process.env.TMPDIR || path.dirname(root), 'sp-update-'));
  try {
    if (useZip) {
      const zipAbs = o.zip ? path.resolve(o.zip) : path.join(tmpDir, feed.zip.name);
      if (!o.zip) {
        log(`下载更新包 ${feed.zip.name}（${fmtBytes(feed.zip.size)}）…`);
        await downloadTo(source, zipRel(feed.zip, source), zipAbs, { sha256: feed.zip.sha256, size: feed.zip.size, timeout: Math.max(timeout, 300000), insecure, log });
      }
      const got = crypto.createHash('sha256').update(fs.readFileSync(zipAbs)).digest('hex');
      if (got !== feed.zip.sha256) throw new Error(`更新包 sha256 不符（要 ${feed.zip.sha256}，得 ${got}）`);
      log(`解压更新包…`);
      const wrote = extractZipInto(zipAbs, root, log);
      res.mode = 'zip';
      res.wrote = wrote.wrote;
      // server/update.js 收尾：按新版本 MANIFEST.json 核对安装、删旧文件、UPDATE.json → .update-applied.json
      const r = applyPendingUpdate(root, { log: quietLog(log) });
      if (r.state === 'failed') throw new Error(`更新包应用失败（${r.reason || '安装与清单不一致'}）：请下载完整包重新安装`);
      res.removed = (r.deleted || []).length;
      if (feed.removed?.length) res.removed = Math.max(res.removed, r.deleted?.length || 0);
    } else {
      const todo = [...plan.missing, ...plan.changed];
      log(`逐文件同步：${todo.length} 个文件（缺 ${plan.missing.length}，内容不同 ${plan.changed.length}），共 ${fmtBytes(todo.reduce((n, rel) => n + (want.get(rel)?.size || 0), 0))}…`);
      let i = 0;
      for (const rel of todo) {
        const d = want.get(rel);
        const buf = await readSource(source, `${FILE_URL}?path=${encodeURIComponent(rel)}`, { binary: true, timeout, insecure });
        if (buf.length !== d.size) throw new Error(`${rel}: 大小不符（要 ${d.size}，得 ${buf.length}）`);
        if (crypto.createHash('sha256').update(buf).digest('hex') !== d.sha256) throw new Error(`${rel}: sha256 不符`);
        writeFileAtomic(path.join(root, ...rel.split('/')), buf);
        if (o.progress && ++i % 25 === 0) log(`  … ${i}/${todo.length}`);
      }
      res.mode = 'files';
      res.wrote = todo.length;
      if (feed.removed?.length) {
        const keep = new Set([...want.keys()].map((r) => r.toLowerCase()));
        const del = deleteRemoved(root, feed.removed, keep);
        res.removed = del.deleted.length;
        if (del.deleted.length) log(`删掉 ${del.deleted.length} 个新版本不再使用的旧文件`);
      }
    }

    const afterDigest = stateDigest(localStateFor(root, want.keys()));
    res.after = readVersion(root).version || '';
    if (afterDigest !== feed.digest) {
      const d = diffState(localStateFor(root, want.keys()), want);
      res.ok = false;
      res.error = `更新后内容仍与发布方不一致（缺 ${d.missing.length}，不同 ${d.changed.length}）`;
    }
    res.applied = res.ok;

    if (o.setup !== false && res.ok) {
      const setup = path.join(root, 'tools', 'setup.mjs');
      if (fs.existsSync(setup)) {
        log('补素材：node tools/setup.mjs --quiet …');
        const r = spawnSync(process.execPath, [setup, '--quiet'], { cwd: root, stdio: 'inherit' });
        res.setup = r.status === 0 ? 'ok' : `exit ${r.status}`;
      } else res.setup = 'missing';
    }
    const after2 = await check({ root, source, pubkeys, timeout, insecure });
    // 报告里的"本机状态"要反映更新之后（否则 app / digest 会自相矛盾：版本还是旧的、摘要却是新的）
    res.state = after2.state;
    res.digest = after2.digest;
    res.app = after2.app;
    res.declared = after2.declared;
    res.versionMismatch = after2.versionMismatch;
    res.artDrift = after2.artDrift;
    res.artFiles = after2.artFiles;
    if (o.keepZip && fs.existsSync(path.join(tmpDir, feed.zip?.name || ''))) {
      fs.copyFileSync(path.join(tmpDir, feed.zip.name), path.resolve(o.keepZip));
    }
    return res;
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/** feed.zip.url（可能是绝对地址，也可能是 /update/xxx.zip）→ 相对 source 的路径。 */
function zipRel(zip, source) {
  const u = String(zip.url || `${FILE_URL}/../${zip.name}`);
  if (/^https?:/i.test(u)) return u.replace(source, '') || `/${zip.name}`;
  return u.startsWith('/') ? u : `/${u}`;
}

/** 解压更新包到 root：路径一律过 pathProblem（防目录穿越），先 .sp-tmp 再改名。 */
export function extractZipInto(zipAbs, root, log = () => {}) {
  let wrote = 0;
  const seen = [];
  readZip(zipAbs, (name, data) => {
    if (name.endsWith('/')) return;
    const bad = pathProblem(name);
    if (bad) throw new Error(`更新包里的路径有问题：${name}（${bad}）`);
    if (name === 'MANIFEST.json' || name === 'UPDATE.json' || name === '.update-applied.json') {
      writeFileAtomic(path.join(root, name), data);
      seen.push(name);
      return;
    }
    writeFileAtomic(path.join(root, ...name.split('/')), data);
    wrote++;
  });
  log(`  写入 ${wrote} 个文件（+ ${seen.length} 个清单文件）`);
  return { wrote, meta: seen };
}

function quietLog(log) {
  return {
    log: (s) => log(String(s).replace(/^\[update\]\s*/, '  · ').split(' · ')[0]),
    warn: (s) => log(String(s).replace(/^\[update\]\s*/, '  ! ').split(' · ')[0]),
    error: (s) => log(String(s).replace(/^\[update\]\s*/, '  ! ').split(' · ')[0]),
  };
}

// ---------------------------------------------------------------------------------------------------

async function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`update: ${e.message}\n${USAGE}`); return 2; }
  if (o.help) { console.log(USAGE); return 0; }
  const root = path.resolve(o.root || path.join(HERE, '..'));
  const source = resolveSource(root, o.source);
  const pubkeys = readPubkeys(root, o.pubkey);
  if (o.insecure && !pubkeys.length) { console.error('update: --insecure 必须至少配一把公钥（--pubkey，或包内 update-pubkey.d/*.pem）—— 传输不可信时只剩签名这道门'); return 2; }
  const log = (s) => { if (!o.json) console.log(s); };

  try {
    if (o.cmd === 'apply') {
      const r = await apply({ ...o, root, source, pubkeys, log });
      if (o.json) console.log(JSON.stringify(flat(r)));
      else {
        console.log(r.error ? `\n✗ ${r.error}` : `\n✓ v${r.after || r.app}（${r.mode === 'zip' ? '更新包' : '逐文件同步'}：写入 ${r.wrote} 个文件，删除 ${r.removed} 个）`);
        if (r.notes && !r.error) console.log(`  ${r.notes}`);
        if (r.setup !== 'skipped') console.log(`  素材：${r.setup}`);
      }
      return r.ok ? 0 : 1;
    }
    const r = await check({ ...o, root, source, pubkeys });
    if (o.json) console.log(JSON.stringify(flat(r)));
    else printCheck(r, root, source);
    return r.ok ? 0 : 1;
  } catch (e) {
    const err = { ok: false, state: 'error', error: e?.message || String(e) };
    if (o.json) console.log(JSON.stringify(err));
    else console.error(`\n✗ ${err.error}`);
    return 1;
  }
}

/** 输出成"扁平"对象（每个值都是字符串/数字/布尔），启动器的简易 JSON 解析就能读。 */
function flat(r) {
  const o = {};
  for (const [k, v] of Object.entries(r)) {
    if (v === undefined || v === null) continue;
    o[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return o;
}

function printCheck(r, root, source) {
  const label = { current: '已是最新', outdated: '有新版本', drifted: '内容漂移', 'server-behind': '本机更新', unknown: '内容未知', error: '检查失败' }[r.state] || r.state;
  console.log(`本机：v${r.app}${r.versionMismatch ? `（package.json 与 APP_VERSION 不一致：${r.declared}）` : ''}  受管文件 ${r.files} 个 ${fmtBytes(r.bytes)}`);
  console.log(`发布方：v${r.latest}  适用版本 from ${r.from || '—'}${r.zipCovers ? '（含本机 → 可用更新包）' : ''}`);
  if (r.signatureOk) console.log(`签名：通过（公钥 ${r.signatureKeyPath || '（内联）'}，指纹 ${r.signatureBy || '—'}；候选 ${r.signatureKeys} 把）`);
  else if (r.signed) console.log('签名：未校验（没有配公钥 ⇒ 只剩 sha256 这一道门；建议在包内放 update-pubkey.d/*.pem）');
  console.log(`更新源：${source}`);
  console.log(`结论：${label}${r.drift ? `（缺 ${r.missing}，内容不同 ${r.changed}${r.extra ? `，本机多出 ${r.extra}` : ''}）` : ''}`);
  if (r.artDrift) console.log(`  素材：与发布方不一致（本机 ${r.artFiles} 个 / 指纹不同）—— 素材归 setup 管，更新包不会搬 public/assets`);
  if (r.samples) console.log(`  例：${r.samples}`);
  if (r.notes) console.log(`  说明：${r.notes}`);
  if (r.state === 'outdated' || r.state === 'drifted') console.log(`\n一键更新：node tools/update.mjs apply --root "${root}"`);
}

const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e?.stack || e); process.exitCode = 1; });
}