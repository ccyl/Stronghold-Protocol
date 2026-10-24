// 账号同步的客户端规则（docs/ACCOUNTS.md §3）: 按键后写胜出 + 本机三路比较（自上次同步后没动过的键接受服务器值，
// 动过的键保留本机值并在下次推送时获胜），战绩按记录 id 合并。

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
  SYNC_MIRROR_KEY, collectPush, applyProfileKeys, localProfileKeys, resetSyncMirror,
} = await import('../../public/js/ui/account.js');
const { PROFILE_KEYS } = await import('../../shared/accounts.js');

const pref = (key, value) => globalThis.localStorage.setItem(`sp.pref.${key}`, JSON.stringify(value));
const read = (key) => JSON.parse(globalThis.localStorage.getItem(`sp.pref.${key}`));

beforeEach(() => {
  globalThis.localStorage.clear();
});

test('nothing changed since the last sync → nothing to push', () => {
  pref('settings', { bgm: 0.5 });
  pref(SYNC_MIRROR_KEY, { settings: { bgm: 0.5 } });
  assert.equal(collectPush(100), null);
});

test('only the keys that differ from the mirror are pushed, with one stamp', () => {
  pref('settings', { bgm: 0.5 });
  pref('diy', { 'chess_char_6_diy1_a': { charId: 'char_498_inside' } });
  pref('lang', 'en');
  pref(SYNC_MIRROR_KEY, { settings: { bgm: 0.5 }, lang: 'en' });
  const out = collectPush(777);
  assert.deepEqual(Object.keys(out.keys).sort(), ['diy']);
  assert.deepEqual(out.keys.diy, { value: { 'chess_char_6_diy1_a': { charId: 'char_498_inside' } }, at: 777 });
  assert.deepEqual(out.mirror, {
    settings: { bgm: 0.5 },
    lang: 'en',
    diy: { 'chess_char_6_diy1_a': { charId: 'char_498_inside' } },
  });
});

test('pulling applies untouched keys and keeps locally edited ones', () => {
  pref('settings', { bgm: 0.5 }); // untouched since the last sync
  pref('diy', { local: 1 });      // edited since the last sync
  pref(SYNC_MIRROR_KEY, { settings: { bgm: 0.5 }, diy: { local: 0 } });
  const remote = {
    settings: { value: { bgm: 0.9 }, at: 200 },
    diy: { value: { server: 2 }, at: 300 },
  };
  const res = applyProfileKeys(remote);
  assert.deepEqual(res.applied, ['settings']);
  assert.deepEqual(res.kept, ['diy']);
  assert.deepEqual(read('settings'), { bgm: 0.9 }, 'the untouched key took the server value');
  assert.deepEqual(read('diy'), { local: 1 }, 'the local edit survived');
  // the mirror now records the applied value; the kept key still needs a push
  assert.deepEqual(read(SYNC_MIRROR_KEY).settings, { bgm: 0.9 });
  const out = collectPush(400);
  assert.deepEqual(Object.keys(out.keys), ['diy'], 'the kept key is the one pushed next');
});

test('a key that is absent locally is simply taken from the account', () => {
  const res = applyProfileKeys({ lang: { value: 'ja', at: 10 }, skins: { value: { a: 'x' }, at: 10 } });
  assert.deepEqual(res.applied.sort(), ['lang', 'skins']);
  assert.deepEqual(res.kept, []);
  assert.equal(read('lang'), 'ja');
});

test('the profile keys are exactly the synced set', () => {
  assert.deepEqual([...PROFILE_KEYS].sort(), ['diy', 'lang', 'loadout', 'ownership', 'settings', 'skins']);
  // keys outside the set are never touched by a pull
  applyProfileKeys({ 'lobby.mode': { value: 'solo', at: 10 } });
  assert.equal(globalThis.localStorage.getItem('sp.pref.lobby.mode'), null);
});

test('logging out clears the mirror so the next login starts clean', () => {
  pref(SYNC_MIRROR_KEY, { settings: { bgm: 0.5 } });
  resetSyncMirror();
  assert.deepEqual(read(SYNC_MIRROR_KEY), {});
  // with no mirror, every key this device has counts as an edit to push
  pref('settings', { bgm: 0.5 });
  const out = collectPush(1);
  assert.deepEqual(Object.keys(out.keys), ['settings']);
});

test('localProfileKeys reports only the keys present', () => {
  pref('lang', 'ko');
  assert.deepEqual(localProfileKeys(), { lang: 'ko' });
});
