// server/accounts/store.js — the account store (this branch: 内部账号, docs/ACCOUNTS.md)
//
// One JSON file holds every account; a second, separate file holds the HMAC secret that indexes passphrases. The
// split is deliberate: the passphrase IS the login credential (unique per server), so a lookup index must exist to
// find an account by passphrase in O(1) — but an index derived with a secret stored beside the accounts would give
// an attacker with a copy of accounts.json a fast offline oracle that defeats the scrypt hashes. Keeping the secret
// in its own 0600 file means the accounts file alone yields only scrypt hashes.
//
// Storage: { v, nextUid, accounts: { [uid]: account } } — account = { uid, name, key (HMAC hex), salt, hash, createdAt,
// lastSeen, rev, profile: { keys: { [k]: { value, at } }, stats, at } }. Writes are atomic (tmp + rename) and keep
// one .bak of the previous file; a corrupt file falls back to the backup, never to a crash.
//
// Crypto: key = HMAC-SHA256(secret, NFC(pass)); hash = scrypt(NFC(pass), salt, 32). Login = find by key + verify the
// hash (defence in depth: a leaked secret still needs scrypt). Changing a passphrase re-checks uniqueness and swaps
// both atomically.
//
// Sessions: the store keeps token → uid in memory only. A reconnect token dies with the server anyway (net.js), so
// there is nothing to persist: a restarted server asks for the passphrase once more.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { UID_MIN, UID_MAX, ACCOUNT_NAME_MAX, isUid, isAccountName, normalizePass, sanitizeProfileKeys, mergeProfileKeys, mergeStats, PROFILE_LIMITS, isStatsEnvelope, jsonBytes } from '../../shared/accounts.js';

/** Store format version (bump when the on-disk shape changes; `migrate` below handles older files). */
export const ACCOUNTS_VERSION = 1;

/** scrypt parameters. The defaults are production cost; tests pass a cheap `options.scrypt`. */
export const SCRYPT_DEFAULTS = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 32, saltBytes: 16 });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** @param {string} pass @param {Buffer} secret */
export function passKey(pass, secret) {
  return crypto.createHmac('sha256', secret).update(normalizePass(pass), 'utf8').digest('hex');
}

/** @param {string} pass @param {Buffer} salt @param {{N:number,r:number,p:number,keylen:number}} o */
export function passHash(pass, salt, o = SCRYPT_DEFAULTS) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(normalizePass(pass), salt, o.keylen, { N: o.N, r: o.r, p: o.p }, (err, buf) => {
      if (err) reject(err); else resolve(buf);
    });
  });
}

/** Constant-time comparison of two hex strings (equal length required). */
export function sameHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); } catch { return false; }
}

/**
 * The account store. One instance per server (server/http/websocket.js).
 */
export class AccountStore {
  /**
   * @param {{ dir: string, log?: any, now?: () => number, scrypt?: Partial<typeof SCRYPT_DEFAULTS> }} opts
   */
  constructor({ dir, log = null, now = () => Date.now(), scrypt = null }) {
    this.dir = dir;
    this.log = log;
    this.now = now;
    this.scrypt = { ...SCRYPT_DEFAULTS, ...(scrypt || {}) };
    this.file = path.join(dir, 'accounts.json');
    this.secretFile = path.join(dir, 'secret');
    /** @type {Buffer | null} */
    this.secret = null;
    /** @type {{ v: number, nextUid: number, accounts: Record<string, any> }} */
    this.db = { v: ACCOUNTS_VERSION, nextUid: UID_MIN, accounts: {} };
    /** @type {Map<string, number>} token → uid (in memory: a server restart drops it) */
    this.sessions = new Map();
    /** @type {Map<string, { n: number, until: number }>} token → auth attempts in the current window */
    this.attempts = new Map();
    this.loaded = false;
  }

  /** Create the directory, load the file (or its .bak), and load/create the secret. Safe to call twice. */
  init() {
    if (this.loaded) return this;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this._loadSecret();
    this._load();
    this.loaded = true;
    return this;
  }

  // ---- files ---------------------------------------------------------------------------------------------------

  _loadSecret() {
    try {
      const hex = fs.readFileSync(this.secretFile, 'utf8').trim();
      if (/^[0-9a-f]{64}$/.test(hex)) { this.secret = Buffer.from(hex, 'hex'); return; }
      this.log?.warn?.('[accounts] secret file is malformed; writing a new one (existing accounts cannot log in)');
    } catch { /* first run */ }
    const buf = crypto.randomBytes(32);
    fs.writeFileSync(this.secretFile, buf.toString('hex') + '\n', { mode: 0o600 });
    this.secret = buf;
  }

  _read(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const db = JSON.parse(raw);
      if (!isObj(db) || !isObj(db.accounts)) return null;
      return db;
    } catch { return null; }
  }

  _load() {
    const main = this._read(this.file);
    if (main) { this.db = { v: ACCOUNTS_VERSION, nextUid: Number(main.nextUid) || UID_MIN, accounts: main.accounts }; return; }
    let bad = false;
    try { bad = fs.existsSync(this.file); } catch { /* ignore */ }
    if (bad) {
      const bak = this._read(`${this.file}.bak`);
      if (bak) {
        this.log?.warn?.('[accounts] accounts.json is unreadable; restored from the backup');
        this.db = { v: ACCOUNTS_VERSION, nextUid: Number(bak.nextUid) || UID_MIN, accounts: bak.accounts };
        try { fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { /* ignore */ }
        return;
      }
      this.log?.warn?.('[accounts] accounts.json is unreadable and there is no backup; starting empty');
      try { fs.renameSync(this.file, `${this.file}.corrupt-${this.now()}`); } catch { /* ignore */ }
    }
  }

  /** Atomic save: write a tmp file, copy the current one to .bak, then rename. */
  _save() {
    const body = JSON.stringify(this.db, null, 1);
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    try { if (fs.existsSync(this.file)) fs.copyFileSync(this.file, `${this.file}.bak`); } catch { /* ignore */ }
    fs.renameSync(tmp, this.file);
  }

  // ---- helpers -------------------------------------------------------------------------------------------------

  /** @param {number} uid */
  account(uid) {
    return isUid(uid) ? this.db.accounts[String(uid)] || null : null;
  }

  /** The uid whose passphrase has this key, or null. @param {string} key */
  _byKey(key) {
    for (const acc of Object.values(this.db.accounts)) if (sameHex(acc.key, key)) return acc.uid;
    return null;
  }

  /** @param {string} name */
  _freeUid() {
    for (let uid = Math.max(UID_MIN, this.db.nextUid); uid <= UID_MAX; uid++) {
      if (!this.db.accounts[String(uid)]) return uid;
    }
    // the counter was raised past a gap: scan the whole range once
    for (let uid = UID_MIN; uid <= UID_MAX; uid++) if (!this.db.accounts[String(uid)]) return uid;
    return null;
  }

  /** How many accounts exist. */
  get size() { return Object.keys(this.db.accounts).length; }

  // ---- passphrase / attempts ------------------------------------------------------------------------------------

  /** Consume one auth attempt for this token; false when it is out of budget. @param {string} token */
  allowAttempt(token) {
    const now = this.now();
    const rec = this.attempts.get(token);
    if (!rec || now >= rec.until) { this.attempts.set(token, { n: 1, until: now + 60_000 }); return true; }
    if (rec.n >= 10) return false;
    rec.n++;
    return true;
  }

  // ---- account operations --------------------------------------------------------------------------------------

  /**
   * Bind (register) a new account: `pass` is the unique credential, `name` the display name.
   * @param {{ pass: string, name: string }} o
   * @returns {Promise<{ ok: true, uid: number, name: string } | { error: 'PASS_WEAK' | 'PASS_TAKEN' | 'BAD_NAME' | 'NO_UID', uid?: number }>}
   */
  async bind({ pass, name }) {
    const clean = String(name || '').trim();
    if (!isAccountName(clean)) return { error: 'BAD_NAME' };
    if (typeof pass !== 'string' || pass.length === 0) return { error: 'PASS_WEAK' };
    const key = passKey(pass, this.secret);
    const taken = this._byKey(key);
    if (taken != null) return { error: 'PASS_TAKEN', uid: taken };
    const uid = this._freeUid();
    if (uid == null) return { error: 'NO_UID' };
    const salt = crypto.randomBytes(this.scrypt.saltBytes);
    const hash = await passHash(pass, salt, this.scrypt);
    const now = this.now();
    this.db.accounts[String(uid)] = {
      uid,
      name: clean,
      key,
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      createdAt: now,
      lastSeen: now,
      rev: 0,
      profile: { keys: {}, stats: null, at: now },
    };
    this.db.nextUid = Math.max(UID_MIN, uid + 1);
    this._save();
    return { ok: true, uid, name: clean };
  }

  /**
   * Log in by passphrase alone (it is unique). Returns the account and its profile snapshot.
   * @param {{ pass: string }} o
   * @returns {Promise<{ ok: true, uid: number, name: string, rev: number, keys: Record<string, any>, stats: any } | { error: 'PASS_UNKNOWN' }>}
   */
  async login({ pass }) {
    if (typeof pass !== 'string' || pass.length === 0) return { error: 'PASS_UNKNOWN' };
    const key = passKey(pass, this.secret);
    const uid = this._byKey(key);
    const acc = uid != null ? this.account(uid) : null;
    if (!acc) return { error: 'PASS_UNKNOWN' };
    const hash = await passHash(pass, Buffer.from(acc.salt, 'hex'), this.scrypt);
    if (!sameHex(hash.toString('hex'), acc.hash)) return { error: 'PASS_UNKNOWN' };
    acc.lastSeen = this.now();
    try { this._save(); } catch { /* a read-only disk must not block a login */ }
    return { ok: true, uid: acc.uid, name: acc.name, rev: acc.rev, keys: acc.profile?.keys || {}, stats: acc.profile?.stats || null };
  }

  /**
   * Change the passphrase (the player's own change, D014): the old one proves ownership, the new one must be free.
   * @param {{ uid: number, oldPass: string, newPass: string }} o
   * @returns {Promise<{ ok: true } | { error: 'PASS_UNKNOWN' | 'PASS_TAKEN' | 'PASS_WEAK' | 'NO_ACCOUNT', uid?: number }>}
   */
  async changePass({ uid, oldPass, newPass }) {
    const acc = this.account(uid);
    if (!acc) return { error: 'NO_ACCOUNT' };
    if (typeof newPass !== 'string' || newPass.length === 0) return { error: 'PASS_WEAK' };
    const oldHash = await passHash(String(oldPass || ''), Buffer.from(acc.salt, 'hex'), this.scrypt);
    if (!sameHex(oldHash.toString('hex'), acc.hash)) return { error: 'PASS_UNKNOWN' };
    const newKey = passKey(newPass, this.secret);
    const other = this._byKey(newKey);
    if (other != null && other !== acc.uid) return { error: 'PASS_TAKEN', uid: other };
    const salt = crypto.randomBytes(this.scrypt.saltBytes);
    const hash = await passHash(newPass, salt, this.scrypt);
    acc.key = newKey;
    acc.salt = salt.toString('hex');
    acc.hash = hash.toString('hex');
    acc.lastSeen = this.now();
    this._save();
    return { ok: true };
  }

  /** The player renames the account (the UID stays). @param {{ uid: number, name: string }} o */
  rename({ uid, name }) {
    const acc = this.account(uid);
    if (!acc) return { error: 'NO_ACCOUNT' };
    const clean = String(name || '').trim();
    if (!isAccountName(clean)) return { error: 'BAD_NAME' };
    acc.name = clean;
    acc.lastSeen = this.now();
    this._save();
    return { ok: true, name: clean };
  }

  /** An admin reset (tools/account-admin.mjs): a new passphrase without the old one. @param {{ uid: number, pass: string }} o */
  async resetPass({ uid, pass }) {
    const acc = this.account(uid);
    if (!acc) return { error: 'NO_ACCOUNT' };
    const key = passKey(pass, this.secret);
    const other = this._byKey(key);
    if (other != null && other !== acc.uid) return { error: 'PASS_TAKEN', uid: other };
    const salt = crypto.randomBytes(this.scrypt.saltBytes);
    acc.key = key;
    acc.salt = salt.toString('hex');
    acc.hash = (await passHash(pass, salt, this.scrypt)).toString('hex');
    acc.lastSeen = this.now();
    this._save();
    return { ok: true };
  }

  /** Delete an account (admin). @param {number} uid */
  remove(uid) {
    const acc = this.account(uid);
    if (!acc) return { error: 'NO_ACCOUNT' };
    delete this.db.accounts[String(uid)];
    for (const [token, u] of this.sessions) if (u === uid) this.sessions.delete(token);
    this._save();
    return { ok: true };
  }

  /** Every account without secrets (admin listing). */
  list() {
    return Object.values(this.db.accounts)
      .map((a) => ({ uid: a.uid, name: a.name, createdAt: a.createdAt, lastSeen: a.lastSeen, rev: a.rev, keys: Object.keys(a.profile?.keys || {}), records: a.profile?.stats?.records?.length || 0 }))
      .sort((x, y) => x.uid - y.uid);
  }

  // ---- profile sync --------------------------------------------------------------------------------------------

  /**
   * Merge a pushed profile into the account (last write wins per key; stats by record id) and answer the merged
   * result, so one push is a full sync.
   * @param {number} uid
   * @param {{ keys?: unknown, stats?: unknown }} payload
   * @returns {{ ok: true, rev: number, keys: Record<string, any>, stats: any } | { error: 'NO_ACCOUNT' | 'TOO_BIG' }}
   */
  push(uid, payload = {}) {
    const acc = this.account(uid);
    if (!acc) return { error: 'NO_ACCOUNT' };
    const profile = acc.profile || (acc.profile = { keys: {}, stats: null, at: this.now() });
    const { keys: incoming } = sanitizeProfileKeys(payload.keys || {});
    const merged = mergeProfileKeys(profile.keys || {}, incoming);
    const statsIn = isStatsEnvelope(payload.stats) ? payload.stats : null;
    if (statsIn && jsonBytes(statsIn) > PROFILE_LIMITS.statsBytes) return { error: 'TOO_BIG' };
    const stats = statsIn ? mergeStats(profile.stats || { v: statsIn.v || 1, records: [] }, statsIn) : profile.stats;
    profile.keys = merged.keys;
    profile.stats = stats;
    profile.at = this.now();
    acc.rev = (Number(acc.rev) || 0) + 1;
    acc.lastSeen = profile.at;
    this._save();
    return { ok: true, rev: acc.rev, keys: merged.keys, stats: stats || null };
  }

  /** A read-only snapshot of the account (login / pull). @param {number} uid */
  snapshot(uid) {
    const acc = this.account(uid);
    if (!acc) return { error: 'NO_ACCOUNT' };
    return { ok: true, uid: acc.uid, name: acc.name, rev: acc.rev, keys: acc.profile?.keys || {}, stats: acc.profile?.stats || null };
  }

  // ---- sessions ------------------------------------------------------------------------------------------------

  /** Remember that this reconnect token belongs to the account. Token must be a non-empty string. */
  bindSession(token, uid) {
    if (typeof token !== 'string' || !token) return false;
    if (!this.account(uid)) return false;
    this.sessions.set(token, uid);
    return true;
  }

  /** The account bound to this reconnect token, or null. @param {string} token */
  sessionUid(token) {
    if (typeof token !== 'string') return null;
    const uid = this.sessions.get(token);
    return uid != null && this.account(uid) ? uid : null;
  }

  /** Forget the token (logout). @param {string} token */
  unbindSession(token) {
    if (typeof token === 'string') this.sessions.delete(token);
  }

  /** The account a token belongs to, as the auth state the client mirrors. @param {string} token */
  stateFor(token) {
    const uid = this.sessionUid(token);
    if (uid == null) return { bound: false };
    const acc = this.account(uid);
    return { bound: true, uid: acc.uid, name: acc.name };
  }
}
