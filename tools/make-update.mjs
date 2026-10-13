#!/usr/bin/env node
// tools/make-update.mjs — 发布侧：从"新版本树"生成更新源产物（版本自检 / 自更新的另一半）。
//
//   node tools/make-update.mjs --to <新版本目录> --from <旧安装目录或旧包.zip>[,<…>] --out <目录>
//        [--url-base https://主机:端口/update] [--key <ed25519 私钥.pem>] [--line fusion-20p]
//        [--order <整数>] [--notes <文字>] [--no-zip] [--json]
//
// 产物（写进 --out，再把整个目录放到服务端的 SP_UPDATE_DIR，就是 /update/ 下的那些地址）：
//   latest.json          发布信息：版本、order、内容摘要 digest、适用版本 from、更新包名/sha256/大小、撤销文件列表
//   latest.json.sig      latest.json 的 ed25519 签名（客户端内置公钥校验；自签证书的链路上这是必须的）
//   MANIFEST.json        受管文件的 size+sha256（客户端逐文件比对、服务端 /update/file?path= 的准入表）
//   Stronghold-Protocol-v<版本>-update.zip   更新包（相对 --from 的差异；离线/手动覆盖也用这个）
//
// 不依赖 git：`git ls-files` 那套（tools/package.mjs）要求 git 工作副本，这里按目录树自己走，方便从"服务器全量树"
// 直接发版。受管集合、摘要、latest.json 的格式与签名规则全在 server/updateSet.js（与客户端逐字一致）。
//
// 注意：--from 必须是你**自己渠道发出去的包**（客户端 app 目录，或解压出来的目录）。上游 Releases 的 zip 装出来的
// 目录与服务端全量树的 sha256 基线不同（素材/本地素材清单差异），拿它当基线会算出成百上千个"改动"。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { diffBases, manifestText, readBase, updateText } from './package-update.mjs';
import {
  FEED_FILE, FEED_FORMAT, FEED_SIG_FILE, MANIFEST_FILE, UPDATE_FILE, isPerMachine, isSetupArt,
  artState, feedText, orderFor, readVersion, signFeed, stateBytes, stateDigest, stateOf,
} from '../server/updateSet.js';

const USAGE = 'usage: node tools/make-update.mjs --to <新版本目录> --from <旧安装目录或旧包.zip>[,<…>] --out <目录> '
  + '[--url-base <http(s)://主机/update>] [--key <ed25519 私钥.pem>] [--line <分支名>] [--order <整数>] '
  + '[--notes <文字>] [--keep <不删的路径前缀>[,…]] [--no-art] [--no-zip] [--json]';

// ---------------------------------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { from: [], to: null, out: null, urlBase: '/update', key: null, line: null, order: null, notes: null, zip: true, art: true, keep: [], json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i];
    if (a === '--to') o.to = val();
    else if (a.startsWith('--to=')) o.to = a.slice(5);
    else if (a === '--from') o.from.push(...String(val()).split(',').filter(Boolean));
    else if (a.startsWith('--from=')) o.from.push(...a.slice(7).split(',').filter(Boolean));
    else if (a === '--out') o.out = val();
    else if (a.startsWith('--out=')) o.out = a.slice(6);
    else if (a === '--url-base') o.urlBase = val();
    else if (a.startsWith('--url-base=')) o.urlBase = a.slice(11);
    else if (a === '--key') o.key = val();
    else if (a.startsWith('--key=')) o.key = a.slice(6);
    else if (a === '--line') o.line = val();
    else if (a.startsWith('--line=')) o.line = a.slice(7);
    else if (a === '--order') o.order = Number(val());
    else if (a.startsWith('--order=')) o.order = Number(a.slice(8));
    else if (a === '--notes') o.notes = val();
    else if (a.startsWith('--notes=')) o.notes = a.slice(8);
    else if (a === '--keep') o.keep.push(...String(val()).split(',').filter(Boolean));
    else if (a.startsWith('--keep=')) o.keep.push(...a.slice(7).split(',').filter(Boolean));
    else if (a === '--no-zip') o.zip = false;
    else if (a === '--no-art') o.art = false;
    else if (a === '--json') o.json = true;
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

/** latest.json 里的分支线：0.2.4-fusion-20p → fusion-20p。 */
function lineOf(version) {
  const m = /^[\d.]+-(.+)$/.exec(String(version));
  return m ? m[1] : 'main';
}

// ---------------------------------------------------------------------------------------------------
// 最小 zip 写入（只写文件条目，deflate；不带 zip64 —— 更新包远小于 4 GB、条目远少于 65535）
// ---------------------------------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/**
 * Write a zip of `entries` ([{name, buf}] — forward slashes in `name`) to `out`.
 * @param {{ name: string, buf: Buffer }[]} entries
 * @param {string} out
 * @returns {{ size: number, bytes: number }}
 */
export function writeZip(entries, out) {
  const chunks = [];
  const central = [];
  let offset = 0;
  let bytes = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const deflated = zlib.deflateRawSync(e.buf, { level: 9 });
    const useDeflate = deflated.length < e.buf.length;
    const body = useDeflate ? deflated : e.buf;
    const crc = crc32(e.buf);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);                    // version needed
    local.writeUInt16LE(0x0800, 6);                // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);    // method
    local.writeUInt16LE(0, 10);                    // time
    local.writeUInt16LE(0x21, 12);                 // date (1980-01-01, fixed → 同样的输入给出同样的 zip)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(e.buf.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, body);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0x21, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(e.buf.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
    bytes += body.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const full = Buffer.concat([...chunks, centralBuf, eocd]);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, full);
  return { size: full.length, bytes };
}

// ---------------------------------------------------------------------------------------------------
// 生成产物
// ---------------------------------------------------------------------------------------------------

/** 打更新包时不进差异比较的东西（元文件、每台机器自己的、node_modules 不参与 —— 服务端树本来就没有它）。
 * `--no-art` 再把素材也排掉（只发程序/数据，素材交给 tools/setup.mjs；回环测试与精简包用得上）。 */
const baseSkip = (rel) => rel === MANIFEST_FILE || rel === UPDATE_FILE || rel === '.update-applied.json'
  || isPerMachine(rel) || rel.split('/').includes('node_modules') || rel.split('/')[0] === 'updates'
  || rel.split('/')[0] === 'logs' || rel.split('/')[0] === '.cache';

const skipFor = (art) => (rel) => baseSkip(rel) || (art === false && isSetupArt(rel));

/** `--keep a/,b` 里列到的路径（含其下所有文件）：更新绝不删。 */
export function keptPath(rel, keep = []) {
  return keep.some((k) => {
    const p = String(k).replace(/^\.\/+/, '').replace(/\/+$/, '');
    return p && (rel === p || rel.startsWith(`${p}/`));
  });
}

const sha256Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Build every artifact of one release into `out`.
 * @param {{ to: string, from: string[], out: string, urlBase?: string, key?: string, line?: string, order?: number,
 *           notes?: string, zip?: boolean, log?: (s: string) => void }} o
 */
export function buildUpdate(o) {
  const log = o.log || (() => {});
  const to = path.resolve(o.to);
  const out = path.resolve(o.out);
  const { version, declared, mismatch } = readVersion(to);
  if (!version) throw new Error(`${to}: package.json 里没有 version`);
  if (mismatch) log(`! ${version} 与 shared/constants.js 的 APP_VERSION（${declared}）不一致 —— 发布前先对齐`);

  const next = readBase(to, { skip: skipFor(o.art) });
  log(`新版本树：v${version}，${next.files.size} 个文件（含素材），${next.art} 个素材文件`);

  const bases = o.from.map((f) => {
    const b = readBase(f, { skip: skipFor(o.art) });
    log(`基线：${b.source} → v${b.version}，${b.files.size} 个文件`);
    return b;
  });

  const diff = diffBases(next.files, bases, { removable: (rel) => !isPerMachine(rel) && !keptPath(rel, o.keep) });
  const ship = new Set(diff.ship);
  if (o.keep?.length) log(`--keep：${o.keep.join('、')} 只保留不删除（客户端渠道里服务端树没有的开发文件靠它）`);

  // 受管集合的清单 + 摘要（客户端逐文件比对、服务端 /update/file 的准入表）
  const controlled = stateOf(to);
  const digest = stateDigest(controlled);
  const manifest = { app: version, files: controlled };

  // 更新包：差异文件 + 清单 + UPDATE.json
  let zip = null;
  if (o.zip !== false) {
    const zipName = `Stronghold-Protocol-v${version}-update.zip`;
    const entries = [];
    const shipped = new Map();
    for (const rel of [...ship].sort()) {
      const p = path.join(to, ...rel.split('/'));
      let buf;
      try { buf = fs.readFileSync(p); } catch { continue; }
      entries.push({ name: rel, buf });
      shipped.set(rel, { size: buf.length, sha256: sha256Of(buf) });
    }
    const updateJson = updateText({ app: version, from: bases.map((b) => b.version), files: shipped, removed: diff.removed });
    entries.push({ name: MANIFEST_FILE, buf: Buffer.from(manifestText(manifest), 'utf8') });
    entries.push({ name: UPDATE_FILE, buf: Buffer.from(updateJson, 'utf8') });
    const abs = path.join(out, zipName);
    const w = writeZip(entries, abs);
    zip = { name: zipName, size: w.size, sha256: sha256Of(fs.readFileSync(abs)), bytes: w.bytes, entries: entries.length };
    log(`更新包：${zipName}，${entries.length} 个文件（含清单），${zip.size} 字节，sha256 ${zip.sha256.slice(0, 12)}…`);
  }

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, MANIFEST_FILE), manifestText(manifest));

  const urlBase = String(o.urlBase || '/update').replace(/\/+$/, '');
  const url = (name) => (/^https?:/.test(urlBase) ? `${urlBase}/${name}` : `${urlBase}/${name}`);
  const feed = {
    format: FEED_FORMAT,
    line: o.line || lineOf(version),
    app: version,
    order: Number.isFinite(o.order) ? o.order : orderFor(version),
    publishedAt: new Date().toISOString(),
    digest,
    files: controlled.size,
    bytes: stateBytes(controlled),
    art: artState(to),
    from: bases.map((b) => b.version),
    manifest: { name: MANIFEST_FILE, url: url(MANIFEST_FILE) },
    removed: diff.removed,
    notes: o.notes || '',
    minLauncher: 1,
  };
  if (zip) feed.zip = { name: zip.name, url: url(zip.name), size: zip.size, sha256: zip.sha256 };
  if (o.key) {
    feed.sig = signFeed(feed, fs.readFileSync(o.key, 'utf8'));
    fs.writeFileSync(path.join(out, FEED_SIG_FILE), `${feed.sig}\n`);
  }
  fs.writeFileSync(path.join(out, FEED_FILE), feedText(feed));
  log(`发布信息：${FEED_FILE}（v${version}，order ${feed.order}，digest ${digest.slice(0, 12)}…，from ${feed.from.join('/') || '—'}）`
    + (feed.sig ? '，已签名' : '，未签名'));

  return {
    out, app: version, order: feed.order, digest, files: controlled.size, bytes: feed.bytes,
    from: feed.from, removed: diff.removed.length, ship: ship.size,
    zip: zip ? { name: zip.name, size: zip.size, sha256: zip.sha256 } : null,
    perBase: diff.perBase, signed: !!feed.sig, feed,
  };
}

// ---------------------------------------------------------------------------------------------------

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`make-update: ${e.message}\n${USAGE}`); return 2; }
  if (o.help || !o.to || !o.out) { console.log(USAGE); return o.help ? 0 : 2; }
  const log = o.json ? () => {} : (s) => console.log(s);
  let r;
  try {
    r = buildUpdate({ ...o, log });
  } catch (e) {
    console.error(`make-update: ${e?.message || e}`);
    return 1;
  }
  if (o.json) console.log(JSON.stringify({ ok: true, out: r.out, app: r.app, order: r.order, digest: r.digest, files: r.files, bytes: r.bytes, from: r.from, removed: r.removed, ship: r.ship, zip: r.zip, signed: r.signed }));
  else {
    console.log(`\n产物目录：${r.out}`);
    for (const b of r.perBase) console.log(`  相对 v${b.version}：改动 ${b.changed}，新增 ${b.added}，删除 ${b.removed}`);
  }
  return 0;
}

// 只有直接运行这个文件才生成产物（被 import 时只导出函数）。
const invoked = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invoked === import.meta.url) process.exitCode = main(process.argv.slice(2));