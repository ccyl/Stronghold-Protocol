// The account store (docs/ACCOUNTS.md): registration with a unique passphrase, login by passphrase, UID
// allocation, passphrase change, profile sync merge, sessions, persistence and corruption recovery.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AccountStore, passKey } from '../../server/accounts/store.js';
import { mergeProfileKeys, mergeStats } from '../../shared/accounts.js';

const scratch = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-accounts-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const store = (dir) => new AccountStore({ dir, scrypt: { N: 1024 } }).init();

test('registration assigns UID 1000 first and refuses a taken passphrase with its UID', async (t) => {
  const s = store(scratch(t));
  const a = await s.bind({ pass: 'alice-pass', name: 'Alice' });
  assert.deepEqual(a, { ok: true, uid: 1000, name: 'Alice' });
  const b = await s.bind({ pass: 'bob-pass', name: 'Bob' });
  assert.equal(b.uid, 1001);
  // the same passphrase (after NFC normalisation) is a conflict, and the answer names the holder
  const dup = await s.bind({ pass: 'alice-pass', name: 'Alice2' });
  assert.deepEqual(dup, { error: 'PASS_TAKEN', uid: 1000 });
  // an empty passphrase is the one thing refused by strength
  assert.deepEqual(await s.bind({ pass: '', name: 'X' }), { error: 'PASS_WEAK' });
  // names follow the in-game rule
  assert.deepEqual(await s.bind({ pass: 'p2', name: '  ' }), { error: 'BAD_NAME' });
  // NFC: the composed and decomposed forms are the same passphrase
  const nfc = 'é-pass';
  await s.bind({ pass: nfc, name: 'Nfc' });
  assert.deepEqual(await s.bind({ pass: nfc.normalize('NFD'), name: 'Nfc2' }), { error: 'PASS_TAKEN', uid: 1002 });
});

test('login needs only the passphrase and answers the account with its profile', async (t) => {
  const s = store(scratch(t));
  const a = await s.bind({ pass: 'secret-1', name: 'Alice' });
  const r = await s.login({ pass: 'secret-1' });
  assert.equal(r.ok, true);
  assert.equal(r.uid, a.uid);
  assert.equal(r.name, 'Alice');
  assert.deepEqual(r.keys, {});
  assert.equal(r.stats, null);
  assert.deepEqual(await s.login({ pass: 'secret-2' }), { error: 'PASS_UNKNOWN' });
  assert.deepEqual(await s.login({ pass: '' }), { error: 'PASS_UNKNOWN' });
});

test('changing the passphrase requires the old one and keeps uniqueness', async (t) => {
  const s = store(scratch(t));
  const a = await s.bind({ pass: 'old', name: 'Alice' });
  await s.bind({ pass: 'taken', name: 'Bob' });
  assert.deepEqual(await s.changePass({ uid: a.uid, oldPass: 'wrong', newPass: 'new' }), { error: 'PASS_UNKNOWN' });
  assert.deepEqual(await s.changePass({ uid: a.uid, oldPass: 'old', newPass: 'taken' }), { error: 'PASS_TAKEN', uid: 1001 });
  assert.deepEqual(await s.changePass({ uid: a.uid, oldPass: 'old', newPass: '' }), { error: 'PASS_WEAK' });
  assert.deepEqual(await s.changePass({ uid: a.uid, oldPass: 'old', newPass: 'new' }), { ok: true });
  assert.equal((await s.login({ pass: 'new' })).uid, a.uid);
  assert.deepEqual(await s.login({ pass: 'old' }), { error: 'PASS_UNKNOWN' });
  // an admin reset works without the old passphrase
  assert.deepEqual(await s.resetPass({ uid: a.uid, pass: 'admin-set' }), { ok: true });
  assert.equal((await s.login({ pass: 'admin-set' })).uid, a.uid);
});

test('profile push merges per key (later stamp wins) and answers the merged set', async (t) => {
  const s = store(scratch(t));
  const { uid } = await s.bind({ pass: 'p', name: 'A' });
  let r = s.push(uid, { keys: { settings: { value: { bgm: 0.5 }, at: 100 }, diy: { value: { a: 1 }, at: 100 } } });
  assert.equal(r.ok, true);
  assert.deepEqual(r.keys.settings.value, { bgm: 0.5 });
  // an older push does not overwrite, a newer one does; unknown keys are dropped
  r = s.push(uid, { keys: { settings: { value: { bgm: 0.9 }, at: 50 }, bogus: { value: 1, at: 999 } } });
  assert.deepEqual(r.keys.settings, { value: { bgm: 0.5 }, at: 100 });
  assert.equal('bogus' in r.keys, false);
  r = s.push(uid, { keys: { settings: { value: { bgm: 0.2 }, at: 200 } } });
  assert.deepEqual(r.keys.settings, { value: { bgm: 0.2 }, at: 200 });
  assert.deepEqual(r.keys.diy, { value: { a: 1 }, at: 100 });
  // a fresh login reads the same profile back
  const login = await s.login({ pass: 'p' });
  assert.deepEqual(login.keys.settings, { value: { bgm: 0.2 }, at: 200 });
  assert.equal(login.rev, 3);
});

test('stats merge by record id and answer one envelope', async (t) => {
  const s = store(scratch(t));
  const { uid } = await s.bind({ pass: 'p', name: 'A' });
  const rec = (id, tt) => ({ id, t: tt, victory: true, roundsPassed: 3 });
  let r = s.push(uid, { keys: {}, stats: { v: 2, records: [rec('m1', 10), rec('m2', 20)] } });
  assert.deepEqual(r.stats.records.map((x) => x.id), ['m2', 'm1']);
  // the same id from the other device is one record; a new one is appended
  r = s.push(uid, { keys: {}, stats: { v: 2, records: [rec('m1', 10), rec('m3', 30)] } });
  assert.deepEqual(r.stats.records.map((x) => x.id), ['m3', 'm2', 'm1']);
  // the server drops malformed entries and caps the envelope
  const big = s.push(uid, { keys: {}, stats: { v: 2, records: [rec('x', 1)], pad: 'y'.repeat(900_000) } });
  assert.equal(big.error, 'TOO_BIG');
});

test('sessions bind a reconnect token to an account; logout forgets it', async (t) => {
  const s = store(scratch(t));
  const { uid } = await s.bind({ pass: 'p', name: 'A' });
  assert.deepEqual(s.stateFor('tok'), { bound: false });
  assert.equal(s.bindSession('tok', uid), true);
  assert.deepEqual(s.stateFor('tok'), { bound: true, uid, name: 'A' });
  s.unbindSession('tok');
  assert.deepEqual(s.stateFor('tok'), { bound: false });
  assert.equal(s.bindSession('', uid), false);
});

test('the store survives a restart and recovers from a corrupt file via its backup', async (t) => {
  const dir = scratch(t);
  const s1 = store(dir);
  const { uid } = await s1.bind({ pass: 'p', name: 'A' });
  s1.push(uid, { keys: { settings: { value: { x: 1 }, at: 5 } } });
  const s2 = store(dir);
  assert.equal(s2.size, 1);
  assert.equal((await s2.login({ pass: 'p' })).uid, uid);
  assert.deepEqual(s2.snapshot(uid).keys.settings.value, { x: 1 });
  // a corrupt file falls back to the .bak written by the last save
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{ broken');
  const s3 = store(dir);
  assert.equal(s3.size, 1);
  assert.equal((await s3.login({ pass: 'p' })).uid, uid);
});

test('the passphrase index is an HMAC of the secret, not the passphrase', async (t) => {
  const dir = scratch(t);
  const s = store(dir);
  const { uid } = await s.bind({ pass: 'p', name: 'A' });
  const raw = fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8');
  assert.equal(raw.includes('"p"'), false, 'no plaintext passphrase');
  const acc = s.account(uid);
  assert.equal(acc.key, passKey('p', s.secret));
  assert.notEqual(acc.key, passKey('p', Buffer.alloc(32, 1)), 'the key depends on the secret');
  assert.equal(acc.hash.length, 64);
});

test('auth attempts are rate limited per token', (t) => {
  const s = store(scratch(t));
  let allowed = 0;
  for (let i = 0; i < 12; i++) if (s.allowAttempt('tok')) allowed++;
  assert.equal(allowed, 10);
  assert.equal(s.allowAttempt('other'), true);
});

test('the merge helpers agree between server and client', () => {
  const local = { settings: { value: 1, at: 10 }, diy: { value: 2, at: 30 } };
  const remote = { settings: { value: 3, at: 20 }, diy: { value: 4, at: 30 } };
  const { keys, taken } = mergeProfileKeys(local, remote);
  assert.deepEqual(keys.settings, { value: 3, at: 20 });
  assert.deepEqual(keys.diy, remote.diy, 'a tie goes to the remote side');
  assert.deepEqual(taken.sort(), ['diy', 'settings']);
  const a = { v: 2, records: [{ id: 'a', t: 5 }, { id: 'b', t: 9 }] };
  const b = { v: 2, records: [{ id: 'b', t: 9 }, { id: 'c', t: 7 }] };
  assert.deepEqual(mergeStats(a, b).records.map((r) => r.id), ['b', 'c', 'a']);
});
