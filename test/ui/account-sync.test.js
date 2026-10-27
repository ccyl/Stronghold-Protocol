// 账号同步的客户端规则（docs/ACCOUNTS.md §3）：资料是手动上传/下载（整体替换），战绩是追加（按记录 id 去重）。

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** A localStorage good enough for store.js loadPref/savePref. */
class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();

const {
  localProfileKeys, applyAccountKeys, ensureSession, STATS_SEQ_KEY,
} = await import('../../public/js/ui/account.js');
const { PROFILE_KEYS } = await import('../../shared/accounts.js');

const pref = (key, value) => globalThis.localStorage.setItem(`sp.pref.${key}`, JSON.stringify(value));
const read = (key) => JSON.parse(globalThis.localStorage.getItem(`sp.pref.${key}`));

beforeEach(() => {
  globalThis.localStorage.clear();
});

test('localProfileKeys reports the synced set only', () => {
  pref('lang', 'ko');
  pref('settings', { bgm: 0.5 });
  pref('lobby.mode', 'solo');
  assert.deepEqual(localProfileKeys(), { lang: 'ko', settings: { bgm: 0.5 } });
});

test('the synced keys are exactly the documented set', () => {
  assert.deepEqual([...PROFILE_KEYS].sort(), ['diy', 'lang', 'loadout', 'ownership', 'settings', 'skins']);
});

test('a download replaces this device keys and leaves the unsynced ones alone', () => {
  pref('settings', { bgm: 0.1 });
  pref('diy', { old: 1 });
  pref('lobby.mode', 'coop');
  const n = applyAccountKeys({
    settings: { value: { bgm: 0.9 } },
    diy: { value: { fresh: 2 } },
    loadout: { value: { ops: 'x' } },
  });
  assert.equal(n, 3);
  assert.deepEqual(read('settings'), { bgm: 0.9 });
  assert.deepEqual(read('diy'), { fresh: 2 });
  assert.deepEqual(read('loadout'), { ops: 'x' });
  assert.equal(read('lobby.mode'), 'coop', 'a key outside the set is never touched');
});

test('an account key that is absent locally is still written by a download', () => {
  applyAccountKeys({ lang: { value: 'ja' } });
  assert.equal(read('lang'), 'ja');
});

test('the stats cursor lives in its own preference', () => {
  assert.equal(STATS_SEQ_KEY, 'statsSeq');
  globalThis.localStorage.setItem(`sp.pref.${STATS_SEQ_KEY}`, '12');
  assert.equal(Number(read(STATS_SEQ_KEY)), 12);
});

test('ensureSession opens a session with a sensible callsign', async () => {
  const { net } = await import('../../public/js/net.js');
  const calls = [];
  const orig = net.setName;
  net.setName = (n) => { calls.push(n); net.name = n; };
  try {
    assert.equal(ensureSession('桃酥小狗'), true);
    assert.deepEqual(calls, ['桃酥小狗']);
    // an existing name means no further hello
    assert.equal(ensureSession('other'), true);
    assert.deepEqual(calls, ['桃酥小狗']);
  } finally {
    net.setName = orig;
    net.name = null;
  }
});

test('every account request uses net.request(type, fields)', async () => {
  const { net } = await import('../../public/js/net.js');
  const { bindAccount, loginAccount, logoutAccount, changePassphrase, renameAccount, accountStore } = await import('../../public/js/ui/account.js');
  accountStore.set({ bound: true, uid: 1000, name: 'T' });
  const calls = [];
  const origRequest = net.request;
  const origSetName = net.setName;
  net.request = (t, fields) => { calls.push([t, fields]); return Promise.resolve({ t: 'ok' }); };
  net.setName = () => {};
  try {
    await bindAccount('p', 'n');
    await bindAccount('p');
    await loginAccount('p');
    await logoutAccount();
    await changePassphrase('old', 'new');
    await renameAccount('n');
  } finally {
    net.request = origRequest;
    net.setName = origSetName;
  }
  // 绑定成功后会顺手整份上传一次（profile.push），所以只看 auth.* 的调用顺序
  const authCalls = calls.filter(([t]) => t.startsWith('auth.'));
  assert.deepEqual(authCalls.slice(0, 6), [
    ['auth.bind', { pass: 'p', name: 'n' }],
    ['auth.bind', { pass: 'p' }],
    ['auth.login', { pass: 'p' }],
    ['auth.logout', undefined],
    ['auth.pass', { oldPass: 'old', newPass: 'new' }],
    ['auth.rename', { name: 'n' }],
  ]);
});
