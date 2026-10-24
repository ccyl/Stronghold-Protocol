// shared/accounts.js — the account system's shared vocabulary (this branch: 内部账号, docs/ACCOUNTS.md)
//
// One account = a display name, a 4-digit UID (1000–9999, assigned once, never reused) and a passphrase that is
// unique across the server (so a passphrase alone identifies the account: login needs no username). Nothing here
// touches crypto or storage — the server (server/accounts/store.js) owns both — this module only fixes the limits,
// the profile keys and the merge rules, so the browser and the server cannot disagree about them.
//
// Offline first: an account is an ENHANCEMENT. A guest keeps playing with everything in localStorage; logging in
// adds cross-device sync (profile keys) and the match history (stats records, merged by record id).

import { NAME_MAX_LEN } from './constants.js';

/** Lowest assigned UID. */
export const UID_MIN = 1000;
/** Highest assignable UID (4 digits, the internal-use range). */
export const UID_MAX = 9999;
/** Longest passphrase in code units. Strength is deliberately not policed (the maintainer's decision, D014): the
 *  length cap only keeps one frame from carrying an unbounded string. */
export const PASS_MAX = 128;
/** Account display name: the same length as the in-game name (12 code units). */
export const ACCOUNT_NAME_MAX = NAME_MAX_LEN;

/** The preferences synced across devices: the browser's `sp.pref.<key>` entries. Deliberately NOT included:
 *  `lobby.*`, `screenFit`, `recentRooms`, `ui-plugins` (this device's layout / last choice) — docs/ACCOUNTS.md §3. */
export const PROFILE_KEYS = Object.freeze(['settings', 'diy', 'skins', 'ownership', 'loadout', 'lang']);

/** Size caps of one pushed profile (the server refuses a bigger one: PROFILE_TOO_BIG). */
export const PROFILE_LIMITS = Object.freeze({
  /** JSON bytes of one key. */
  entryBytes: 64 * 1024,
  /** JSON bytes of all keys together. */
  totalBytes: 256 * 1024,
  /** JSON bytes of the stats envelope (the client's own budget is 800 000 characters — ui/stats.js MAX_CHARS). */
  statsBytes: 800 * 1024,
  /** Stored stats records (the client keeps at most MAX_RECORDS = 1000). */
  records: 1000,
  /** Longest key accepted in a `keys` map (defence against a hand-written client). */
  keys: 32,
});

/** An account's 4-digit UID. @param {unknown} v */
export const isUid = (v) => Number.isInteger(v) && v >= UID_MIN && v <= UID_MAX;

/** A passphrase as sent on the wire: 1–PASS_MAX code units, no policy beyond that (D014). @param {unknown} v */
export const isPass = (v) => typeof v === 'string' && v.length > 0 && v.length <= PASS_MAX;

/** An account display name: non-blank, ≤ ACCOUNT_NAME_MAX, no control characters (the same rule as hello's name). */
export function isAccountName(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (!s || v.length > ACCOUNT_NAME_MAX) return false;
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(v);
}

/** The canonical form of a passphrase: Unicode NFC, nothing else (spaces are significant; no trimming). */
export const normalizePass = (pass) => String(pass).normalize('NFC');

/** A numeric timestamp accepted in a sync entry (ms epoch, finite, non-negative). */
export const isStamp = (v) => Number.isFinite(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER;

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

const encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

/** Byte length of a JSON-encoded value, or Infinity when it cannot be encoded. @param {unknown} v */
export function jsonBytes(v) {
  try {
    const s = JSON.stringify(v);
    if (typeof s !== 'string') return Infinity;
    return encoder ? encoder.encode(s).length : s.length * 2;
  } catch {
    return Infinity;
  }
}

/**
 * One profile entry as the server accepts it: `{ value, at }` with `at` a stamp and the JSON size inside the caps.
 * @param {unknown} raw
 * @returns {{ value: unknown, at: number } | null} null when the entry is unusable (the caller drops it)
 */
export function sanitizeProfileEntry(raw) {
  if (!isObj(raw) || !isStamp(raw.at)) return null;
  const bytes = jsonBytes(raw.value);
  if (!(bytes <= PROFILE_LIMITS.entryBytes)) return null;
  return { value: raw.value, at: raw.at };
}

/**
 * The accepted part of a `profile.push` keys map: known keys only, each entry sanitised, at most PROFILE_LIMITS.keys
 * entries, total JSON inside the cap. Unknown keys and malformed entries are dropped (the push still succeeds).
 * @param {unknown} raw
 * @returns {{ keys: Record<string, { value: unknown, at: number }>, dropped: number }}
 */
export function sanitizeProfileKeys(raw) {
  /** @type {Record<string, { value: unknown, at: number }>} */
  const keys = {};
  let dropped = 0;
  if (!isObj(raw)) return { keys, dropped };
  let total = 0;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (n >= PROFILE_LIMITS.keys || !PROFILE_KEYS.includes(k)) { dropped++; continue; }
    const entry = sanitizeProfileEntry(v);
    if (!entry) { dropped++; continue; }
    const bytes = jsonBytes(entry.value);
    if (total + bytes > PROFILE_LIMITS.totalBytes) { dropped++; continue; }
    total += bytes;
    n++;
    keys[k] = entry;
  }
  return { keys, dropped };
}

/**
 * Last-write-wins merge of two key maps. For each key the entry with the larger `at` wins; on a tie the REMOTE one
 * wins (the server is where two devices meet, so a tie means "already pulled"), which makes the merge idempotent.
 * @param {Record<string, { value: unknown, at: number }>} local
 * @param {Record<string, { value: unknown, at: number }>} remote
 * @returns {{ keys: Record<string, { value: unknown, at: number }>, taken: string[] }} `taken` = keys the remote won
 */
export function mergeProfileKeys(local, remote) {
  /** @type {Record<string, { value: unknown, at: number }>} */
  const keys = {};
  /** @type {string[]} */
  const taken = [];
  for (const k of PROFILE_KEYS) {
    const l = isObj(local) ? local[k] : null;
    const r = isObj(remote) ? remote[k] : null;
    if (l && r) {
      if (r.at >= l.at) { keys[k] = r; taken.push(k); } else keys[k] = l;
    } else if (r) { keys[k] = r; taken.push(k); } else if (l) { keys[k] = l; }
  }
  return { keys, taken };
}

/**
 * Merge two stats envelopes by record id (the client's ui/stats.js builds `id` from the settlement; a record of the
 * same match on two devices is one record). Records are ordered newest first (by `t`), capped to `records`, and the
 * result is a fresh envelope with the larger format version.
 * @param {{ v?: number, records?: any[] } | null} a
 * @param {{ v?: number, records?: any[] } | null} b
 * @param {{ records?: number }} [opts]
 * @returns {{ v: number, records: any[] }}
 */
export function mergeStats(a, b, { records = PROFILE_LIMITS.records } = {}) {
  const v = Math.max(Number(a?.v) || 0, Number(b?.v) || 0) || 1;
  /** @type {Map<string, any>} */
  const byId = new Map();
  for (const src of [a, b]) {
    const list = Array.isArray(src?.records) ? src.records : [];
    for (const rec of list) {
      if (!isObj(rec)) continue;
      const id = typeof rec.id === 'string' && rec.id ? rec.id : null;
      const key = id || `anonymous:${JSON.stringify(rec).slice(0, 64)}`;
      const prev = byId.get(key);
      // a duplicate from the other side: keep the newer record (its `t`), else the one with more fields
      if (!prev) { byId.set(key, rec); continue; }
      const pt = Number(prev.t) || 0;
      const rt = Number(rec.t) || 0;
      if (rt > pt) byId.set(key, rec);
    }
  }
  const merged = [...byId.values()]
    .map((rec) => ({ rec, t: Number(rec.t) || 0 }))
    .sort((x, y) => y.t - x.t)
    .slice(0, Math.max(0, records))
    .map((x) => x.rec);
  return { v, records: merged };
}

/**
 * Whether a `profile.push` payload is structurally usable: a `keys` map (any entry is sanitised separately) and,
 * optionally, a `stats` envelope object.
 * @param {unknown} raw
 */
export function isProfilePush(raw) {
  if (!isObj(raw) || !isObj(raw.keys)) return false;
  return raw.stats === undefined || raw.stats === null || isObj(raw.stats);
}

/** Whether a `profile.pull`/`profile.push` stats payload is structurally usable (an envelope object). @param {unknown} v */
export const isStatsEnvelope = (v) => isObj(v) && (v.records === undefined || Array.isArray(v.records));
