// test/room/chat.test.js — 聊天内核单元测试（this branch: 聊天重做 M1）
// normalizeChatText（shared/chat.js）+ RoomChat（server/roomChat.js：seq、有界历史、令牌桶、快照）。
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeChatText, isChatText, CHAT_MAX_LEN } from '../../shared/chat.js';
import { RoomChat, CHAT_BUCKETS } from '../../server/roomChat.js';

describe('normalizeChatText (shared/chat.js)', () => {
  test('keeps ordinary text and trims', () => {
    assert.equal(normalizeChatText('大家好！'), '大家好！');
    assert.equal(normalizeChatText('  hello  '), 'hello');
  });

  test('strips control chars', () => {
    assert.equal(normalizeChatText('a\x00b\x1Fc\x7F'), 'abc');
  });

  test('NFC-normalises combining sequences', () => {
    assert.equal(normalizeChatText('cafe\u0301'), 'café');
  });

  test('rejects non-string, empty and whitespace-only', () => {
    for (const v of [123, null, undefined, {}, [], '']) assert.equal(normalizeChatText(v), null, String(v));
    assert.equal(normalizeChatText('   '), null);
    assert.equal(normalizeChatText('\t\n'), null);
  });

  test('enforces CHAT_MAX_LEN and rejects instead of truncating', () => {
    assert.equal(CHAT_MAX_LEN, 200);
    assert.equal(normalizeChatText('a'.repeat(CHAT_MAX_LEN))?.length, CHAT_MAX_LEN);
    assert.equal(normalizeChatText('a'.repeat(CHAT_MAX_LEN + 1)), null);
    assert.equal(isChatText('a'.repeat(CHAT_MAX_LEN)), true);
    assert.equal(isChatText('a'.repeat(CHAT_MAX_LEN + 1)), false);
    assert.equal(isChatText('hello'), true);
    assert.equal(isChatText('  '), false);
  });
});

describe('RoomChat (server/roomChat.js)', () => {
  test('bucket parameters match the spec', () => {
    assert.deepEqual(CHAT_BUCKETS.player, { capacity: 3, refillPerSec: 0.5 });
    assert.deepEqual(CHAT_BUCKETS.room, { capacity: 20, refillPerSec: 10 });
  });

  test('seq increases monotonically; each message carries seq and at', () => {
    let t = 1000;
    const c = new RoomChat({ now: () => t });
    const a = c.append({ playerId: 'p1', name: 'n1', seat: 0, isSpectator: false, text: '一' });
    t += 1;
    const b = c.append({ playerId: 'p2', name: 'n2', seat: 1, isSpectator: false, text: '二' });
    assert.equal(a.seq, 1);
    assert.equal(b.seq, 2);
    assert.equal(a.at, 1000);
    assert.equal(b.at, 1001);
    assert.equal(c.snapshot().seq, 2);
  });

  test('history is bounded to historyLimit', () => {
    const c = new RoomChat({ historyLimit: 5, now: () => 0 });
    for (let i = 0; i < 7; i++) c.append({ playerId: 'p', name: 'n', seat: 0, isSpectator: false, text: `m${i}` });
    assert.equal(c.seq, 7);
    assert.equal(c.messages.length, 5);
    assert.deepEqual(c.messages.map((m) => m.text), ['m2', 'm3', 'm4', 'm5', 'm6']);
  });

  test('per-player burst allows 3 then refuses', () => {
    const c = new RoomChat({ now: () => 0 });
    assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p1'), false);
  });

  test('player tokens refill at 0.5/s', () => {
    let t = 0;
    const c = new RoomChat({ now: () => t });
    for (let i = 0; i < 3; i++) assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p1'), false);
    t = 4000; // 4 s elapsed → 0.5/s × 4 = 2 tokens
    assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p1'), false);
  });

  test('room bucket is shared across all players', () => {
    const buckets = { player: { capacity: 100, refillPerSec: 100 }, room: { capacity: 3, refillPerSec: 0 } };
    const c = new RoomChat({ now: () => 0, buckets });
    assert.equal(c.tryConsume('p1'), true);
    assert.equal(c.tryConsume('p2'), true);
    assert.equal(c.tryConsume('p3'), true);
    assert.equal(c.tryConsume('p4'), false, 'room bucket exhausted stops a fresh player');
  });

  test('snapshot copies the messages array', () => {
    const c = new RoomChat({ now: () => 0 });
    c.append({ playerId: 'p', name: 'n', seat: 0, isSpectator: false, text: 'hi' });
    const snap = c.snapshot();
    assert.equal(snap.seq, 1);
    snap.messages.pop();
    assert.equal(c.messages.length, 1, 'mutating the snapshot must not affect the live history');
    assert.equal(c.snapshot().messages.length, 1);
    assert.equal(c.messages[0].text, 'hi');
  });
});