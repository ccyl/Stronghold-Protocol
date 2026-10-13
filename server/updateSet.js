// server/updateSet.js — 版本自检与自更新共用的规则：受管集合（controlled set）、内容摘要、发布信息（latest.json）的
// 格式与签名。发布侧（tools/make-update.mjs）、服务端端点（server/http/update.js）与客户端（tools/update.mjs）用同一套
// 口径 —— 只有这一处实现，摘要才对得上。
//
// 受管集合：安装目录里"更新负责"的文件 —— 排掉
//   * 元文件（MANIFEST.json / UPDATE.json / .update-applied.json / latest.json / *.sig）；
//   * 素材（server/update.js isSetupArt：public/assets/、public/fonts/、data/assets.json、data/local-assets.json）
//     —— 归 tools/setup.mjs 管，不进摘要、不进清单，更新后缺了只警告；
//   * node_modules/（官方 MANIFEST 含它，但服务端发布树不带 node_modules，两边算不出同一个摘要）；
//   * 缓存 / 日志 / 每台机器自己的东西（.cache、logs、updates、.git、.venv*、handoff、.claude、点开头的文件）。
//
// 摘要 digest = sha256(按路径排序的每条 "path\0size\0sha256\n")。它回答的是"版本号一样、内容一样吗" ——
// 0.2.4-fusion-20p 的两份安装今天就有 71 处不同（server/http/files.js 与 70 个 spine atlas），版本号看不出来。
//
// 版本比较：order（整数，发布脚本按 YYYYMMDDNN 生成）优先，缺失时回落 x.y.z[-pre] 的字符串比较
// （规则与 tools/package-update.mjs compareVersions 相同；这里自带一份是为了不把 server/ 反向依赖到 tools/）。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APPLIED_FILE, MANIFEST_FILE, UPDATE_FILE, isSetupArt } from './update.js';

export { MANIFEST_FILE, UPDATE_FILE, APPLIED_FILE, isSetupArt };

export const FEED_FILE = 'latest.json';
export const FEED_SIG_FILE = 'latest.json.sig';
/** latest.json 的格式号。 */
export const FEED_FORMAT = 1;
/** 更新源的地址（服务端 server/http/update.js 提供）。 */
export const FEED_URL = '/update/latest.json';
export const MANIFEST_URL = '/update/MANIFEST.json';
export const FILE_URL = '/update/file';

const META = new Set([UPDATE_FILE, MANIFEST_FILE, APPLIED_FILE, FEED_FILE, FEED_SIG_FILE]);
const SKIP_SEGMENTS = new Set(['node_modules', '.cache', '.git', 'logs', 'updates', 'handoff', '.claude', 'pv', 'review']);
const PER_MACHINE = /(?:^|\/)(?:\.env(?:\..*)?|service\.env\.cmd)$|(?:^|\/)\.venv[^/]*\//;

/** 一台机器自己的东西：更新既不写、也不删，也不进摘要。 */
export const isPerMachine = (rel) => PER_MACHINE.test(rel);

/** 路径是否属于受管集合（进摘要与 MANIFEST.json 的覆盖面）。 */
export function isControlled(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (META.has(rel) || isSetupArt(rel) || isPerMachine(rel)) return false;
  const parts = rel.split('/');
  if (parts.some((s) => SKIP_SEGMENTS.has(s))) return false;
  if (parts.some((s) => s.startsWith('.'))) return false;
  return true;
}

/** 受管集合的默认"排除"过滤器（walkTree / stateOf 用：true = 不进结果）。 */
export const skipNonControlled = (rel) => !isControlled(rel);

/**
 * 目录下的文件，posix 相对路径，按路径排序。符号链接跟随（与 tools/package-update.mjs 的 walk 一致）。
 * @param {string} root
 * @param {{ skip?: (rel: string) => boolean, rel?: string, out?: string[] }} [o]
 * @returns {string[]}
 */
export function walkTree(root, { skip = skipNonControlled, rel = '', out = [] } = {}) {
  let names;
  try { names = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = rel ? `${rel}/${e.name}` : e.name;
    let st;
    try { st = fs.statSync(path.join(root, child)); } catch { continue; }
    if (st.isDirectory()) walkTree(root, { skip, rel: child, out });
    else if (st.isFile() && !skip(child)) out.push(child);
  }
  return out;
}

/** 一个文件的 {size, sha256}（读不到 → null）。 */
export function digestFile(abs) {
  let buf;
  try { buf = fs.readFileSync(abs); } catch { return null; }
  return { size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/**
 * 受管集合的逐文件状态 {path → {size, sha256}}。
 * @param {string} root
 * @param {{ skip?: (rel: string) => boolean, onEach?: ((n: number) => void) | null }} [o]
 * @returns {Map<string, { size: number, sha256: string }>}
 */
export function stateOf(root, { skip = skipNonControlled, onEach = null } = {}) {
  const out = new Map();
  let n = 0;
  for (const rel of walkTree(root, { skip })) {
    const d = digestFile(path.join(root, ...rel.split('/')));
    if (!d) continue;
    out.set(rel, d);
    if (++n % 500 === 0) onEach?.(n);
  }
  onEach?.(n);
  return out;
}

/**
 * 按**发布清单给出的路径表**算本机状态：文件不在 → {size: -1, sha256: 'missing'}。
 *
 * 摘要必须按"发布方管的那些文件"算，不能按"本机受管集合"算 —— 客户端渠道里多出来的开发文件
 * （android/、docs/design…）不在清单里，就不会影响摘要，两份装的摘要有可比性。
 * 发布侧同一套规则：stateOf(新树) 的所有条目都是存在的文件。
 * @param {string} root
 * @param {Iterable<string>} paths
 */
export function localStateFor(root, paths) {
  const out = new Map();
  for (const rel of paths) {
    const d = digestFile(path.join(root, ...rel.split('/')));
    out.set(rel, d || { size: -1, sha256: 'missing' });
  }
  return out;
}

/** 受管集合的摘要：路径排序后的 "path\0size\0sha256\n" 的 sha256。 */
export function stateDigest(state) {
  const h = crypto.createHash('sha256');
  for (const rel of [...state.keys()].sort()) {
    const d = state.get(rel);
    h.update(`${rel}\0${d.size}\0${d.sha256}\n`);
  }
  return h.digest('hex');
}

/** 受管集合的总字节数（发布信息里给客户端参考）。 */
export const stateBytes = (state) => { let n = 0; for (const d of state.values()) n += d.size; return n; };

/**
 * 素材的指纹：只按 (路径, 大小) 算，**不读内容**（834 MB 读一遍太慢），够用来发现"素材集合不一样"
 * —— 0.2.4 那 70 个 atlas 就是每个多了 14 字节的 `size:` 行，大小对不上就露出来了。
 * 素材归 tools/setup.mjs 管：这里只报"漂移 / 不漂移"，不修、不进摘要。
 * @param {string} root
 * @returns {{ files: number, bytes: number, digest: string }}
 */
export function artState(root) {
  const h = crypto.createHash('sha256');
  let files = 0;
  let bytes = 0;
  for (const rel of walkTree(root, { skip: (r) => !isSetupArt(r) })) {
    let size = -1;
    try { size = fs.statSync(path.join(root, ...rel.split('/'))).size; } catch { /* ignore */ }
    h.update(`${rel}\0${size}\n`);
    files++;
    bytes += Math.max(0, size);
  }
  return { files, bytes, digest: h.digest('hex') };
}

/** 安装目录声明的版本：package.json 与 shared/constants.js 的 APP_VERSION。 */
export function readVersion(root) {
  let version = null;
  try { version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null; } catch { version = null; }
  let declared = null;
  try {
    const src = fs.readFileSync(path.join(root, 'shared', 'constants.js'), 'utf8');
    declared = /APP_VERSION\s*=\s*'([^']+)'/.exec(src)?.[1] ?? null;
  } catch { declared = null; }
  return { version, declared, mismatch: !!version && !!declared && version !== declared };
}

/** x.y.z[-pre] 的比较（-1 / 0 / 1；预发布排在同号正式版之前）。 */
export function compareRelease(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v));
    if (!m) throw new Error(`not a version: ${v}`);
    return { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (x.pre === y.pre) return 0;
  if (x.pre === null) return 1;
  if (y.pre === null) return -1;
  return x.pre < y.pre ? -1 : 1;
}

/** candidate（发布方）是否比 current（本机）新：order 优先，其次版本号。 */
export function isNewer(candidate = {}, current = {}) {
  if (Number.isFinite(candidate.order) && Number.isFinite(current.order) && candidate.order !== current.order) {
    return candidate.order > current.order;
  }
  if (candidate.app && current.app) {
    try { return compareRelease(candidate.app, current.app) > 0; } catch { return false; }
  }
  return false;
}

/** order：YYYYMMDDNN（同日多次发布由尾部递增），只为排序用。 */
export function orderFor(version, when = new Date()) {
  const d = when instanceof Date ? when : new Date(when);
  const day = Number(`${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`);
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  const tail = m ? Number(m[3]) : 0;
  return day * 100 + Math.min(99, Math.max(1, tail % 100 || 1));
}

/** latest.json 的规范文本：键序固定（签名对它算，两个工具必须逐字一致）。 */
export function feedText(feed) {
  const keys = ['format', 'line', 'app', 'order', 'publishedAt', 'digest', 'files', 'bytes', 'art', 'from', 'zip', 'manifest', 'removed', 'notes', 'minLauncher', 'sig'];
  const o = {};
  for (const k of keys) if (feed[k] !== undefined) o[k] = feed[k];
  return `${JSON.stringify(o, null, 2)}\n`;
}

/** 签名对象：sig 置空后的规范文本。 */
export const feedSignatureText = (feed) => feedText({ ...feed, sig: '' });

/** ed25519 签名（PKCS#8 PEM 或私钥文件内容）→ base64。 */
export function signFeed(feed, privateKey) {
  const key = crypto.createPrivateKey(privateKey);
  return crypto.sign(null, Buffer.from(feedSignatureText(feed), 'utf8'), key).toString('base64');
}

/** 校验最新发布信息的签名（公钥 PEM）。 */
export function verifyFeed(feed, publicKey) {
  if (!feed || typeof feed.sig !== 'string' || !feed.sig) return false;
  try {
    const key = crypto.createPublicKey(publicKey);
    return crypto.verify(null, Buffer.from(feedSignatureText(feed), 'utf8'), key, Buffer.from(feed.sig, 'base64'));
  } catch { return false; }
}

/** latest.json 的文本 → 校验过的对象，或抛出原因。 */
export function loadFeed(text) {
  const j = JSON.parse(text);
  if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('latest.json 不是一个对象');
  if (j.format !== FEED_FORMAT) throw new Error(`latest.json 的 format 是 ${JSON.stringify(j.format)}，本客户端读 ${FEED_FORMAT}`);
  if (typeof j.app !== 'string' || !j.app) throw new Error('latest.json 没有版本号 app');
  if (typeof j.digest !== 'string' || !/^[0-9a-f]{64}$/.test(j.digest)) throw new Error('latest.json 没有内容摘要 digest');
  if (j.zip && (typeof j.zip.name !== 'string' || !/^[0-9a-f]{64}$/.test(String(j.zip.sha256 || '')))) {
    throw new Error('latest.json 的 zip 没有 name / sha256');
  }
  return j;
}

/** 本地状态与目标状态的逐文件比对（extra = 本机多出来的，不动，只报数）。 */
export function diffState(local, want) {
  const missing = [];
  const changed = [];
  for (const [rel, d] of want) {
    const have = local.get(rel);
    if (!have) missing.push(rel);
    else if (have.size !== d.size || have.sha256 !== d.sha256) changed.push(rel);
  }
  const extra = [...local.keys()].filter((rel) => !want.has(rel));
  return { missing, changed, extra };
}

/** 人能读的字节数。 */
export function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1073741824) return `${(n / 1048576).toFixed(1)} MB`;
  return `${(n / 1073741824).toFixed(2)} GB`;
}

/** 写文件：先写同目录的 .sp-tmp 再改名（原子替换，失败不留半个文件）。 */
export function writeFileAtomic(abs, buf) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.sp-tmp`;
  fs.writeFileSync(tmp, buf);
  try { fs.renameSync(tmp, abs); } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    throw e;
  }
}