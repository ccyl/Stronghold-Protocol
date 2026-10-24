// public/js/ui/account.js — the account system's browser side (this branch: 内部账号, docs/ACCOUNTS.md)
//
// The server owns the account (server/accounts/store.js); this module keeps the connection's state, sends the
// account requests, and syncs the profile:
//
//   * accountStore { bound, uid, name, rev, conflict, syncing, lastSync } — what the UI renders;
//   * accountSubscribe(): the S2C side (auth.state / auth.conflict / profile.state) — installed once at boot;
//   * bindAccount / loginAccount / logoutAccount / changePassphrase / renameAccount — one request each;
//   * pushProfile() / pullProfile() — the sync itself.
//
// Sync model: last write wins per key, with a local three-way check so a device never overwrites an edit it has not
// pushed yet. `sp.pref.syncMirror` holds the values as they were at the last successful sync: a local key that still
// equals its mirror is "untouched" and the remote entry wins; a key that differs is the user's own newer edit and is
// pushed instead (the server then merges it in by its stamp). The stats records merge by record id (shared/accounts.js
// mergeStats), which is idempotent: the same match on two devices is one record.
//
// Applying a PULLED profile (login, manual pull) writes the preferences into localStorage. A page that already read
// them (settings, the DIY store, skins …) keeps its in-memory copy until it reloads, so the account panel lives on the
// title screen — the one place where a reload costs nothing.

import { net } from '../net.js';
import { createStore, loadPref, savePref } from '../store.js';
import { PROFILE_KEYS, mergeProfileKeys, mergeStats, isUid } from '../../../shared/accounts.js';
import { loadStats, saveStats } from './stats.js';

/** The last-synced values of the profile keys (a plain object saved as one preference). */
export const SYNC_MIRROR_KEY = 'syncMirror';

/** The connection's account, as the UI reads it. `conflict` = { operation, uid } of a passphrase the server refused. */
export const accountStore = createStore({
  bound: false,
  uid: null,
  name: '',
  rev: 0,
  conflict: null,
  syncing: false,
  lastSync: 0,
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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The keys this device must push: the local values that differ from the last synced mirror. Unchanged keys are left
 * out (the server already has them), so a push is small and its stamps only cover real edits.
 * @param {number} at stamp for the pushed entries
 * @returns {{ keys: Record<string, { value: any, at: number }>, mirror: Record<string, any> } | null}
 *   null when nothing changed
 */
export function collectPush(at = Date.now()) {
  const mirror = loadPref(SYNC_MIRROR_KEY, {});
  const local = localProfileKeys();
  /** @type {Record<string, { value: any, at: number }>} */
  const keys = {};
  /** @type {Record<string, any>} */
  const next = { ...mirror };
  let changed = false;
  for (const key of PROFILE_KEYS) {
    const v = local[key];
    if (v === undefined) continue;
    if (same(v, mirror[key])) continue;
    keys[key] = { value: v, at };
    next[key] = v;
    changed = true;
  }
  return changed ? { keys, mirror: next } : null;
}

/**
 * Apply the server's profile keys to this device with the three-way rule: a key this device edited since the last
 * sync keeps its value (it is pushed instead); every other key takes the server's entry.
 * @param {Record<string, { value: any, at: number }>} remote
 * @returns {{ applied: string[], kept: string[] }}
 */
export function applyProfileKeys(remote) {
  const mirror = loadPref(SYNC_MIRROR_KEY, {});
  const local = localProfileKeys();
  const applied = [];
  const kept = [];
  const nextMirror = { ...mirror };
  for (const key of PROFILE_KEYS) {
    const r = remote && remote[key];
    if (!r) continue;
    const localEdited = local[key] !== undefined && !same(local[key], mirror[key]);
    if (localEdited) { kept.push(key); continue; }
    savePref(key, r.value);
    nextMirror[key] = r.value;
    applied.push(key);
  }
  savePref(SYNC_MIRROR_KEY, nextMirror);
  return { applied, kept };
}

/** Merge the server's stats envelope into this device's records (by id) and keep it. */
export function applyProfileStats(stats) {
  if (!stats) return null;
  const merged = mergeStats(loadStats(), stats);
  saveStats(merged);
  return merged;
}

/** The S2C side: install once at boot (main.js). Returns an unsubscribe that is normally never used. */
export function accountSubscribe() {
  const offs = [];
  offs.push(net.on('auth.state', (m) => {
    if (!m || typeof m !== 'object') return;
    if (m.bound === true && isUid(m.uid)) {
      accountStore.set({ bound: true, uid: m.uid, name: typeof m.name === 'string' ? m.name : '', conflict: null });
    } else {
      accountStore.set({ bound: false, uid: null, name: '', conflict: null });
    }
  }));
  offs.push(net.on('auth.conflict', (m) => {
    if (!m || typeof m !== 'object') return;
    const uid = isUid(m.uid) ? m.uid : null;
    accountStore.set({ conflict: { operation: String(m.operation || ''), uid } });
  }));
  offs.push(net.on('profile.state', (m) => {
    if (!m || typeof m !== 'object') return;
    applyProfileStats(m.stats || null);
    const res = applyProfileKeys(m.keys || {});
    accountStore.set({ rev: Number(m.rev) || 0, lastSync: Date.now(), conflict: null });
    // keys the local side won are pushed straight away, so the account matches this device too
    if (res.kept.length) pushProfile().catch(() => {});
    return res;
  }));
  return () => { for (const off of offs) { try { off(); } catch { /* ignore */ } } };
}

/** Clear the local mirror (logout: the next login starts from a clean three-way comparison). */
export function resetSyncMirror() {
  savePref(SYNC_MIRROR_KEY, {});
}

// ---- requests -------------------------------------------------------------------------------------------------

/**
 * Bind (register) an account for this connection: the passphrase is the login credential and must be unique.
 * @param {string} pass @param {string} name
 */
export async function bindAccount(pass, name) {
  accountStore.set({ conflict: null });
  return net.request({ t: 'auth.bind', pass, name });
}

/** Log in (bind an existing account) — the server pushes its profile, which is merged into this device. */
export async function loginAccount(pass) {
  accountStore.set({ conflict: null });
  return net.request({ t: 'auth.login', pass });
}

/** Unbind: the profile stays on this device and play continues as a guest. */
export async function logoutAccount() {
  resetSyncMirror();
  return net.request({ t: 'auth.logout' });
}

/** Change the passphrase (the old one proves ownership; the new one must be free). */
export async function changePassphrase(oldPass, newPass) {
  accountStore.set({ conflict: null });
  return net.request({ t: 'auth.pass', oldPass, newPass });
}

/** Rename the account (the UID stays). */
export async function renameAccount(name) {
  return net.request({ t: 'auth.rename', name });
}

/**
 * Push this device's changed keys and its stats. The server merges and answers with `profile.state`, so one push is a
 * full two-way sync.
 * @returns {Promise<boolean>} whether anything was sent
 */
export async function pushProfile() {
  if (!isBound()) return false;
  const payload = { t: 'profile.push', keys: {} };
  const collected = collectPush();
  if (collected) {
    payload.keys = collected.keys;
    // remember the pushed values only once the server accepted them
    accountStore.set({ syncing: true });
    try {
      await net.request(payload);
      savePref(SYNC_MIRROR_KEY, collected.mirror);
      accountStore.set({ lastSync: Date.now() });
      return true;
    } catch { return false; } finally { accountStore.set({ syncing: false }); }
  }
  // nothing changed locally: send nothing (a stats-only push happens on the periodic sync below)
  return false;
}

/** Read the account's profile back (the server pushes it). */
export async function pullProfile() {
  if (!isBound()) return null;
  return net.request({ t: 'profile.pull' });
}

/**
 * The periodic sync: push local edits and the stats envelope when the account is bound and the socket is online.
 * Called by the app's timer (main.js); a no-op otherwise.
 */
export async function syncProfile() {
  if (!isBound() || !net.connected) return false;
  const stats = loadStats();
  const collected = collectPush();
  const payload = { t: 'profile.push', keys: collected ? collected.keys : {} };
  if (stats && Array.isArray(stats.records) && stats.records.length) payload.stats = stats;
  if (!collected && !payload.stats) return false;
  accountStore.set({ syncing: true });
  try {
    await net.request(payload);
    if (collected) savePref(SYNC_MIRROR_KEY, collected.mirror);
    accountStore.set({ lastSync: Date.now(), syncing: false });
    return true;
  } catch {
    accountStore.set({ syncing: false });
    return false;
  }
}
