// 账号的端到端流程（docs/ACCOUNTS.md）：真的起一个服务器（账号目录指向临时目录），用 WebSocket 客户端走
// 绑定 → 冲突 → 登录 → 资料同步 → 改口令 → 登出 → 重连保持登录态。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../../server/index.js';
import { TestClient } from '../helpers/wsClient.js';

let srv;
let tmp;
const open = [];

const connect = async (name, token) => {
  const c = await TestClient.connect(srv.url.replace('http', 'ws') + '/ws');
  open.push(c);
  c.welcome = await c.hello(name, token);
  return c;
};

test('accounts', async (t) => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-accounts-e2e-'));
  srv = await startServer({ port: 0, host: '127.0.0.1', quiet: true, accountsDir: path.join(tmp, 'accounts'), assetIndex: false });
  t.after(async () => {
    await Promise.all(open.map((c) => c.terminate().catch(() => {})));
    await srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await t.test('a fresh connection is a guest', async () => {
    const c = await connect('Guest');
    assert.deepEqual(await c.waitFor('auth.state'), { t: 'auth.state', bound: false });
    // profile.pull without an account is refused
    const r = await c.request({ t: 'profile.pull' });
    assert.equal(r.t, 'error');
    assert.equal(r.code, 'NOT_BOUND');
  });

  await t.test('binding registers UID 1000 and pushes the empty profile', async () => {
    const c = await connect('Alice');
    await c.waitFor('auth.state');
    assert.equal((await c.request({ t: 'auth.bind', pass: 'alice-pass', name: 'Alice' })).t, 'ok');
    const st = await c.waitFor('auth.state', (m) => m.bound === true);
    assert.deepEqual(st, { t: 'auth.state', bound: true, uid: 1000, name: 'Alice' });
    const prof = await c.waitFor('profile.state');
    assert.deepEqual(prof, { t: 'profile.state', rev: 0, keys: {}, stats: null });
    // a second bind with the same passphrase names the holder and pushes the conflict
    const d = await connect('Alice2');
    await d.waitFor('auth.state');
    const r = await d.request({ t: 'auth.bind', pass: 'alice-pass', name: 'Alice2' });
    assert.equal(r.code, 'PASS_TAKEN');
    assert.deepEqual(await d.waitFor('auth.conflict'), { t: 'auth.conflict', operation: 'bind', uid: 1000 });
    // and the same client logs into that account instead
    assert.equal((await d.request({ t: 'auth.login', pass: 'alice-pass' })).t, 'ok');
    assert.deepEqual(await d.waitFor('auth.state', (m) => m.bound === true), { t: 'auth.state', bound: true, uid: 1000, name: 'Alice' });
  });

  await t.test('profile push merges per key and reaches the other device', async () => {
    const a = await connect('A');
    await a.waitFor('auth.state');
    await a.request({ t: 'auth.bind', pass: 'sync-pass', name: 'Sync' });
    await a.waitFor('profile.state');
    assert.equal((await a.request({ t: 'profile.push', keys: { settings: { value: { bgm: 0.4 }, at: 100 } } })).t, 'ok');
    let prof = await a.waitFor('profile.state', (m) => m.rev === 1);
    assert.deepEqual(prof.keys.settings, { value: { bgm: 0.4 }, at: 100 });
    // the other device logs in and reads the same profile
    const b = await connect('B');
    await b.waitFor('auth.state');
    assert.equal((await b.request({ t: 'auth.login', pass: 'sync-pass' })).t, 'ok');
    prof = await b.waitFor('profile.state');
    assert.deepEqual(prof.keys.settings, { value: { bgm: 0.4 }, at: 100 });
    // a later push wins, an older one does not; stats merge by record id
    assert.equal((await b.request({ t: 'profile.push', keys: { settings: { value: { bgm: 0.9 }, at: 200 } } })).t, 'ok');
    await b.waitFor('profile.state', (m) => m.rev === 2);
    assert.equal((await a.request({ t: 'profile.push', keys: { settings: { value: { bgm: 0.1 }, at: 150 } } })).t, 'ok');
    const merged = await a.waitFor('profile.state', (m) => m.rev === 3);
    assert.deepEqual(merged.keys.settings, { value: { bgm: 0.9 }, at: 200 });
    await b.request({ t: 'profile.push', keys: {}, stats: { v: 2, records: [{ id: 'm1', t: 10, victory: true }] } });
    await b.waitFor('profile.state', (m) => m.rev === 4);
    await a.request({ t: 'profile.push', keys: {}, stats: { v: 2, records: [{ id: 'm1', t: 10, victory: true }, { id: 'm2', t: 20, victory: false }] } });
    const stats = await a.waitFor('profile.state', (m) => m.rev === 5);
    assert.deepEqual(stats.stats.records.map((r) => r.id), ['m2', 'm1']);
  });

  await t.test('changing the passphrase needs the old one and keeps uniqueness', async () => {
    const c = await connect('C');
    await c.waitFor('auth.state');
    await c.request({ t: 'auth.bind', pass: 'first-pass', name: 'C' });
    const mine = (await c.waitFor('auth.state', (m) => m.bound === true)).uid;
    await c.waitFor('profile.state');
    const other = await connect('D');
    await other.waitFor('auth.state');
    await other.request({ t: 'auth.bind', pass: 'other-pass', name: 'D' });
    const theirs = (await other.waitFor('auth.state', (m) => m.bound === true)).uid;
    await other.waitFor('profile.state');
    assert.equal((await c.request({ t: 'auth.pass', oldPass: 'nope', newPass: 'second-pass' })).code, 'PASS_UNKNOWN');
    const taken = await c.request({ t: 'auth.pass', oldPass: 'first-pass', newPass: 'other-pass' });
    assert.equal(taken.code, 'PASS_TAKEN');
    assert.deepEqual(await c.waitFor('auth.conflict'), { t: 'auth.conflict', operation: 'pass', uid: theirs });
    await c.waitFor('ok', (m) => true).catch(() => {});
    assert.equal((await c.request({ t: 'auth.pass', oldPass: 'first-pass', newPass: 'second-pass' })).t, 'ok');
    // the old passphrase is gone, the new one logs in
    const e = await connect('E');
    await e.waitFor('auth.state');
    assert.equal((await e.request({ t: 'auth.login', pass: 'first-pass' })).code, 'PASS_UNKNOWN');
    assert.equal((await e.request({ t: 'auth.login', pass: 'second-pass' })).t, 'ok');
    assert.equal((await e.waitFor('auth.state', (m) => m.bound === true)).uid, mine);
  });

  await t.test('logout unbinds, a reconnect keeps the login, and a rename keeps the UID', async () => {
    const c = await connect('F');
    await c.waitFor('auth.state');
    await c.request({ t: 'auth.bind', pass: 'keep-pass', name: 'F' });
    const st = await c.waitFor('auth.state', (m) => m.bound === true);
    assert.equal(st.bound, true);
    // renaming keeps the UID
    assert.equal((await c.request({ t: 'auth.rename', name: 'F2' })).t, 'ok');
    assert.deepEqual(await c.waitFor('auth.state', (m) => m.name === 'F2'), { t: 'auth.state', bound: true, uid: st.uid, name: 'F2' });
    // a reconnect with the same token resumes the account (hello pushes auth.state)
    const token = c.welcome.token;
    assert.ok(token, 'welcome carries the reconnect token');
    await c.terminate();
    const again = await connect('F2', token);
    assert.deepEqual(await again.waitFor('auth.state', (m) => m.bound === true), { t: 'auth.state', bound: true, uid: st.uid, name: 'F2' });
    // logout: guest again, and the profile pull is refused
    assert.equal((await again.request({ t: 'auth.logout' })).t, 'ok');
    assert.deepEqual(await again.waitFor('auth.state', (m) => m.bound === false), { t: 'auth.state', bound: false });
    assert.equal((await again.request({ t: 'profile.pull' })).code, 'NOT_BOUND');
  });

  await t.test('the data lives outside the repository and contains no plaintext passphrase', async () => {
    const file = path.join(tmp, 'accounts', 'accounts.json');
    const raw = fs.readFileSync(file, 'utf8');
    for (const pass of ['alice-pass', 'sync-pass', 'second-pass', 'keep-pass', 'other-pass']) {
      assert.equal(raw.includes(pass), false, `${pass} must not be stored`);
    }
    const secret = fs.readFileSync(path.join(tmp, 'accounts', 'secret'), 'utf8').trim();
    assert.match(secret, /^[0-9a-f]{64}$/);
  });
});
