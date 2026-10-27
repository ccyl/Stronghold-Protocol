// public/js/ui/account.js — the account system's browser side (this branch: 内部账号, docs/ACCOUNTS.md)
//
// The server owns the account (server/accounts/store.js); this module keeps the connection's state, sends the account
// requests, and drives the two halves of the data the account holds — with deliberately DIFFERENT models:
//
//   * 资料 (干员调配 / 自选编队 / 持有 / 换装 / 设置 / 语言) — MANUAL. 「上传到账号」 replaces the account's set with this
//     device's; 「从账号下载」 replaces this device's with the account's (then reloads so every store re-reads it).
//     There is no background merging: the player decides which side wins, and the panel shows when the account was
//     last written. (The first automatic sync design — per-key last-write-wins with a three-way mirror — silently kept
//     the wrong side on any device that had ever saved a preference; a manual action is predictable.)
//   * 战绩 (match records) — APPEND-ONLY on the server. Every record this device stores is sent with `stats.add`; the
//     server numbers it with a per-account `seq` and dedupes by the record id. A login (and the panel's 「补齐」)
//     pulls `stats.since { seq }` so a device gets exactly the matches it has not seen. No conflicts, no merging.
//
// The account panel lives in the stats screen (the 个人界面). Nothing here runs while the connection is a guest.

import { net, identity } from '../net.js';
import { store, createStore, loadPref, savePref } from '../store.js';
import { PROFILE_KEYS, isUid } from '../../../shared/accounts.js';
import { loadStats, appendRecord, recordListeners, saveStats } from './stats.js';

/** The last stats cursor this device has seen from the account (`sp.pref.statsSeq`). */
export const STATS_SEQ_KEY = 'statsSeq';

/** The connection's account, as the UI reads it. `conflict` = { operation, uid } of a passphrase the server refused. */
export const accountStore = createStore({
  bound: false,
  uid: null,
  name: '',
  profileAt: 0,   // when the account's 资料 was last written (ms epoch)
  statsSeq: 0,    // how many match records the account holds
  conflict: null,
  busy: false,
});

/** Whether an account is bound to this connection. */
export const isBound = () => !!accountStore.get().bound;

/** The profile keys this device currently has. @returns {Record<string, any>} */
export function localProfileKeys() {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of PROFILE_KEYS) {
    const v = loadPref(key, undefined);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Replace this device's profile keys with the account's (the download). @param {Record<string, any>} keys */
export function applyAccountKeys(keys) {
  let n = 0;
  for (const key of PROFILE_KEYS) {
    const r = keys && keys[key];
    if (!r) continue;
    savePref(key, r.value);
    n++;
  }
  return n;
}

/** The account requests need a session; the 个人界面 opens from the title screen too (net.request queues until online). */
export function ensureSession(fallbackName) {
  if (net.status === 'online' || net.name) return true;
  let callsign = String(fallbackName || '').trim();
  if (!callsign) { try { callsign = String(store.get()?.me?.name || '').trim(); } catch { callsign = ''; } }
  if (!callsign) { try { callsign = String(identity.loadName?.() || '').trim(); } catch { callsign = ''; } }
  net.setName(callsign || 'Doctor');
  return true;
}

/** Set by 「从账号下载」: the next profile.state replaces this device's profile and reloads the page. */
let applyNext = false;

/** The S2C side: install once at boot (main.js). Returns an unsubscribe that is normally never used. */
export function accountSubscribe() {
  const offs = [];
  offs.push(net.on('auth.state', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.bound === true && isUid(m.uid)) {
      accountStore.set({ bound: true, uid: m.uid, name: typeof m.name === 'string' ? m.name : '', conflict: null });
    } else {
      accountStore.set({ bound: false, uid: null, name: '', conflict: null, profileAt: 0, statsSeq: 0 });
    }
  }));
  offs.push(net.on('auth.conflict', (m) => {
    if (!m || typeof m !== 'object') return;
    const uid = isUid(m.uid) ? m.uid : null;
    accountStore.set({ conflict: { operation: String(m.operation || ''), uid } });
  }));
  offs.push(net.on('profile.state', (m) => {
    if (!m || typeof m !== 'object') return;
    const at = Number(m.at) || 0;
    accountStore.set({ profileAt: at, conflict: null });
    if (!applyNext) return; // a login's informational push: the player presses 「从账号下载」 when they want it
    applyNext = false;
    applyAccountKeys(m.keys || {});
    setTimeout(() => { try { globalThis.location?.reload?.(); } catch { /* ignore */ } }, 400);
  }));
  offs.push(net.on('stats.state', (m) => {
    if (!m || typeof m !== 'object') return;
    const seq = Number(m.seq) || 0;
    if (seq) savePref(STATS_SEQ_KEY, seq);
    accountStore.set({ statsSeq: seq });
    const entries = Array.isArray(m.entries) ? m.entries : [];
    if (!entries.length) return;
    let stats = loadStats();
    let added = 0;
    for (const e of entries) {
      if (!e || !e.record) continue;
      const res = appendRecord(stats, e.record);
      stats = res.stats;
      if (res.added) added++;
    }
    if (added) saveStats(stats);
    if (added) toastStatsPulled(added);
  }));
  return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } };
}

// ---- 资料（手动） ----------------------------------------------------------------------------------------------

/**
 * 「上传到账号」: replace the account's profile keys with this device's set. The panel confirms first.
 * @returns {Promise<boolean>}
 */
export async function uploadProfile() {
  if (!isBound()) return false;
  ensureSession('');
  accountStore.set({ busy: true });
  try {
    const keys = {};
    for (const [k, v] of Object.entries(localProfileKeys())) keys[k] = { value: v };
    await net.request('profile.push', { keys });
    return true;
  } finally {
    accountStore.set({ busy: false });
  }
}

/**
 * 「从账号下载」: ask the server for the account's profile; the profile.state handler replaces this device's copy and
 * reloads the page (every store reads the preferences at load).
 * @returns {Promise<boolean>}
 */
export async function downloadProfile() {
  if (!isBound()) return false;
  ensureSession('');
  applyNext = true;
  return net.request('profile.pull');
}

// ---- 战绩（追加） ----------------------------------------------------------------------------------------------

/** Listeners for "the account pulled n matches" (the panel shows a line). */
const pulledListeners = new Set();
export function onStatsPulled(fn) {
  if (typeof fn === 'function') pulledListeners.add(fn);
  return () => pulledListeners.delete(fn);
}
const toastStatsPulled = (n) => { for (const fn of pulledListeners) { try { fn(n); } catch { /* ignore */ } } };

/**
 * Append one stored match record to the account (`stats.add`). Idempotent on the server (record id); a failure is
 * silent — the record stays on this device and the next 「补齐」/login sends what the account lacks? No: this is the
 * only upload path, so a failure is retried by `uploadStats()` (the panel's 「上传本机战绩」).
 * @param {any} record
 * @returns {Promise<boolean>}
 */
export async function addStatsRecord(record) {
  if (!isBound() || !record || !record.id) return false;
  if (net.status !== 'online') return false;
  try {
    await net.request('stats.add', { records: [record] });
    return true;
  } catch {
    return false;
  }
}

/** Send up to `max` of this device's records (oldest first) that the account may not have — the first-login backfill. */
export async function uploadStats(max = 40) {
  if (!isBound()) return 0;
  ensureSession('');
  const seq = Number(loadPref(STATS_SEQ_KEY, 0)) || 0;
  const stats = loadStats();
  const list = Array.isArray(stats.records) ? stats.records : [];
  if (!list.length) return 0;
  // the account holds `seq` records; this device sends its oldest `max` (idempotent on the server)
  const batch = list.slice(-Math.max(1, Math.min(20, max)));
  let sent = 0;
  for (let i = 0; i < batch.length; i += 20) {
    const chunk = batch.slice(i, i + 20).filter((r) => r && r.id);
    if (!chunk.length) continue;
    try {
      await net.request('stats.add', { records: chunk });
      sent += chunk.length;
    } catch { break; }
  }
  return sent;
}

/**
 * Pull the account's records this device has not seen (`stats.since`), and backfill the account with this device's
 * newer history — the login path and the panel's 「补齐」.
 * @returns {Promise<number>} how many records this device gained
 */
export async function syncStats() {
  if (!isBound()) return 0;
  ensureSession('');
  const before = Number(accountStore.get().statsSeq) || 0;
  accountStore.set({ busy: true });
  try {
    await uploadStats(20);
    await net.request('stats.since', { seq: Number(loadPref(STATS_SEQ_KEY, 0)) || 0 });
    return Math.max(0, (Number(accountStore.get().statsSeq) || 0) - before);
  } finally {
    accountStore.set({ busy: false });
  }
}

/** Install the per-match uploader: every record this device stores goes to the bound account. Call once at boot. */
export function installStatsUpload() {
  const listener = (rec) => { addStatsRecord(rec).catch(() => {}); };
  recordListeners.add(listener);
  return () => recordListeners.delete(listener);
}

// ---- requests -------------------------------------------------------------------------------------------------

/** Bind (register) an account for this connection: the passphrase is the login credential and must be unique. */
export async function bindAccount(pass, name) {
  ensureSession(name);
  accountStore.set({ conflict: null });
  const res = name ? await net.request('auth.bind', { pass, name }) : await net.request('auth.bind', { pass });
  // 绑定后把本机资料整体上传一次，作为账号的初始资料
  uploadProfile().catch(() => {});
  return res;
}

/** Log in (bind an existing account). The caller then pulls the stats (`syncStats`) and offers 「从账号下载」. */
export async function loginAccount(pass) {
  ensureSession('');
  accountStore.set({ conflict: null });
  return net.request('auth.login', { pass });
}

/** Unbind: the profile stays on this device and play continues as a guest. */
export async function logoutAccount() {
  ensureSession('');
  return net.request('auth.logout');
}

/** Change the passphrase (the old one proves ownership; the new one must be free). */
export async function changePassphrase(oldPass, newPass) {
  ensureSession('');
  accountStore.set({ conflict: null });
  return net.request('auth.pass', { oldPass, newPass });
}

/** Rename the account (the UID stays). */
export async function renameAccount(name) {
  ensureSession(name);
  return net.request('auth.rename', { name });
}

/** Read the account's profile (the informational push; the download uses `downloadProfile`). */
export async function pullProfile() {
  if (!isBound()) return null;
  ensureSession('');
  return net.request('profile.pull');
}
