// test/lobby-chat.test.js — room.chat multi-player broadcast, protocol & history replay test
import { describe, test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { startServer } from '../server/index.js';
import { StubMatch } from '../server/match/StubMatch.js';
import { TestClient } from './helpers/wsClient.js';
import { ERR } from '../shared/constants.js';
import { validateC2S, S2C } from '../shared/protocol.js';
import { CHAT_MAX_LEN } from '../shared/chat.js';

function clientPool(getUrl) {
  const open = new Set();
  return {
    async connect() { const c = await TestClient.connect(getUrl()); open.add(c); return c; },
    async player(name, token) {
      const c = await this.connect();
      const w = await c.hello(name, token);
      c.id = w.playerId;
      c.token = w.token;
      return c;
    },
    async closeAll() {
      await Promise.all([...open].map((c) => c.terminate().catch(() => {})));
      open.clear();
    },
  };
}
const quietLog = () => {
  const errors = [];
  return { errors, log: { info() {}, warn() {}, debug() {}, error: (...a) => errors.push(a.map(String).join(' ')) } };
};
const ok = async (c, msg) => { const r = await c.request(msg); assert.equal(r.t, 'ok', `${msg.t}: ${JSON.stringify(r)}`); return r; };
const err = async (c, msg, code) => { const r = await c.request(msg); assert.equal(r.t, 'error', JSON.stringify(r)); assert.equal(r.code, code, JSON.stringify(r)); return r; };
const seatOf = (state, id) => state.seats.find((s) => s && s.playerId === id) || null;
async function createRoom(c) {
  await ok(c, { t: 'room.create', mode: 'coop', difficulty: 'NORMAL' });
  return c.waitFor('room.state', (s) => s.hostId === c.id);
}
async function joinRoom(c, code) {
  await ok(c, { t: 'room.join', code });
  return c.waitFor('room.state', (s) => s.code === code && !!seatOf(s, c.id));
}

describe('room.chat protocol and multi-player broadcast', () => {
  let srv;
  let pool;
  const cap = quietLog();

  before(async () => {
    srv = await startServer({ port: 0, host: '127.0.0.1', log: cap.log, MatchClass: StubMatch, lobbyGraceMs: 60_000 });
    pool = clientPool(() => `ws://127.0.0.1:${srv.port}/ws`);
  });
  afterEach(async () => { await pool.closeAll(); });
  after(async () => {
    await srv?.close();
    assert.deepEqual(cap.errors, [], 'no server errors logged');
  });

  test('protocol validates room.chat in C2S and S2C', () => {
    assert.equal(validateC2S({ t: 'room.chat', text: '大家好！' }), null);
    assert.equal(validateC2S({ t: 'room.chat', text: 'hello' }), null);
    assert.equal(validateC2S({ t: 'room.chat', text: 'a'.repeat(CHAT_MAX_LEN) }), null);
    assert.notEqual(validateC2S({ t: 'room.chat', text: '' }), null);
    assert.notEqual(validateC2S({ t: 'room.chat', text: '   ' }), null);
    assert.notEqual(validateC2S({ t: 'room.chat', text: 'a'.repeat(CHAT_MAX_LEN + 1) }), null);
    assert.notEqual(validateC2S({ t: 'room.chat' }), null);
    assert.equal(S2C.includes('room.chat'), true);
    assert.equal(S2C.includes('room.chatState'), true);
  });

  test('chat rejected when player is not in a room', async () => {
    const p1 = await pool.player('SoloDoc');
    await err(p1, { t: 'room.chat', text: 'hello' }, ERR.NOT_IN_ROOM);
  });

  test('chat broadcast reaches all players in the room including sender', async () => {
    const host = await pool.player('HostDoctor');
    const guest1 = await pool.player('GuestDoctor1');
    const guest2 = await pool.player('GuestDoctor2');

    const roomState = await createRoom(host);
    await joinRoom(guest1, roomState.code);
    await joinRoom(guest2, roomState.code);

    // Host sends a message
    const pHostReceive = host.waitFor('room.chat', (m) => m.text === '攻打右路！');
    const pG1Receive = guest1.waitFor('room.chat', (m) => m.text === '攻打右路！');
    const pG2Receive = guest2.waitFor('room.chat', (m) => m.text === '攻打右路！');

    const res = await host.request({ t: 'room.chat', text: '攻打右路！' });
    assert.equal(res.t, 'ok');

    const [mHost, mG1, mG2] = await Promise.all([pHostReceive, pG1Receive, pG2Receive]);

    assert.equal(mHost.seq, 1);
    assert.equal(mHost.playerId, host.id);
    assert.equal(mHost.name, 'HostDoctor');
    assert.equal(mHost.seat, 0);
    assert.equal(mHost.isSpectator, false);
    assert.equal(mHost.text, '攻打右路！');

    assert.equal(mG1.seq, 1);
    assert.equal(mG1.name, 'HostDoctor');
    assert.equal(mG1.seat, 0);
    assert.equal(mG1.text, '攻打右路！');

    assert.equal(mG2.seq, 1);
    assert.equal(mG2.name, 'HostDoctor');
    assert.equal(mG2.seat, 0);
    assert.equal(mG2.text, '攻打右路！');

    // Guest sends a message back
    const pHostReceive2 = host.waitFor('room.chat', (m) => m.text === '收到，已部署先锋');
    const pG1Receive2 = guest1.waitFor('room.chat', (m) => m.text === '收到，已部署先锋');
    const pG2Receive2 = guest2.waitFor('room.chat', (m) => m.text === '收到，已部署先锋');

    await ok(guest1, { t: 'room.chat', text: '收到，已部署先锋' });

    const [mHost2, mG12, mG22] = await Promise.all([pHostReceive2, pG1Receive2, pG2Receive2]);
    assert.equal(mG12.seq, 2);
    assert.equal(mG12.playerId, guest1.id);
    assert.equal(mG12.name, 'GuestDoctor1');
    assert.equal(mG12.seat, 1);
    assert.equal(mG12.text, '收到，已部署先锋');
    assert.equal(mHost2.text, '收到，已部署先锋');
    assert.equal(mG22.text, '收到，已部署先锋');
  });

  test('rate limit: per-player burst allows 3 messages then refuses', async () => {
    const host = await pool.player('Spammer');
    await createRoom(host);

    await ok(host, { t: 'room.chat', text: '第一句' });
    await ok(host, { t: 'room.chat', text: '第二句' });
    await ok(host, { t: 'room.chat', text: '第三句' });
    await err(host, { t: 'room.chat', text: '第四句不该发出去' }, ERR.RATE);
  });

  test('a late joiner replays chat history via room.chatState', async () => {
    const host = await pool.player('ReplayHost');
    const guest1 = await pool.player('ReplayGuest1');
    const roomState = await createRoom(host);
    await joinRoom(guest1, roomState.code);

    await ok(host, { t: 'room.chat', text: '第一条历史' });
    await ok(guest1, { t: 'room.chat', text: '第二条历史' });

    const guest2 = await pool.player('ReplayGuest2');
    await joinRoom(guest2, roomState.code);
    const snap = await guest2.waitFor('room.chatState');
    assert.equal(snap.seq, 2);
    assert.equal(snap.messages.length, 2);
    assert.deepEqual(snap.messages.map((m) => m.text), ['第一条历史', '第二条历史']);
    assert.equal(snap.messages[0].seq, 1);
    assert.equal(snap.messages[1].seq, 2);
    assert.equal(snap.messages[1].playerId, guest1.id);
  });

  test('a reconnecting player replays missed messages via room.chatState', async () => {
    const host = await pool.player('RejoinHost');
    const guest = await pool.player('RejoinGuest');
    const roomState = await createRoom(host);
    await joinRoom(guest, roomState.code);

    await ok(host, { t: 'room.chat', text: '掉线前' });

    await guest.terminate();
    // while the guest is away the host keeps chatting; the guest misses it live
    await ok(host, { t: 'room.chat', text: '掉线后' });

    const back = await pool.connect();
    const welcome = await back.hello('RejoinGuest', guest.token);
    assert.equal(welcome.resumed, true);
    const snap = await back.waitFor('room.chatState');
    assert.equal(snap.seq, 2);
    assert.deepEqual(snap.messages.map((m) => m.text), ['掉线前', '掉线后']);
  });
});