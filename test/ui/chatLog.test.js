// Chat message model (public/js/ui/chatLog.js): normalise, seq dedupe/sort/bound, seat colour, team-only filter.
// These are the pure rules behind the seq-history replay (M2) that used to only keep the last 40 messages with no
// dedupe and no server order.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SYSTEM_PLAYER_ID, isSystemMessage, normalizeChatMessage, seatColorClass, mergeChat, visibleMessage,
} from '../../public/js/ui/chatLog.js';
import { CHAT_HISTORY_LIMIT } from '../../shared/chat.js';

// CHAT_HISTORY_LIMIT is 200, but the tests that exercise the bound use a small explicit limit for clarity.
const msg = (seq, over = {}) => ({ seq, playerId: 'p1', name: '博士', seat: 0, text: 'hi', at: 1000, ...over });

describe('normalizeChatMessage', () => {
  test('keeps a wire message and its server seq', () => {
    assert.deepEqual(normalizeChatMessage({ seq: 3, playerId: 'p1', name: 'A', seat: 2, isSpectator: false, text: 'hi', at: 42 }), {
      seq: 3, playerId: 'p1', name: 'A', seat: 2, isSpectator: false, system: false, text: 'hi', at: 42,
    });
  });

  test('treats a message without a seq as a no-seq record (seq = null)', () => {
    const r = normalizeChatMessage({ playerId: 'p1', text: 'hi' });
    assert.equal(r.seq, null);
    assert.equal(r.at, 0);
  });

  test('flags the admin announcer as a system line even without a system flag', () => {
    assert.equal(normalizeChatMessage({ playerId: SYSTEM_PLAYER_ID, name: '📢 系统公告', seat: -1, text: '维护' }).system, true);
    assert.equal(normalizeChatMessage({ playerId: 'p1', system: true, text: 'x' }).system, true);
    assert.equal(normalizeChatMessage({ playerId: 'p1', text: 'x' }).system, false);
  });

  test('drops records that cannot be shown (no playerId / no non-empty text)', () => {
    assert.equal(normalizeChatMessage(null), null);
    assert.equal(normalizeChatMessage({}), null);
    assert.equal(normalizeChatMessage({ playerId: 'p1' }), null);
    assert.equal(normalizeChatMessage({ playerId: 'p1', text: '   ' }), null);
  });

  test('a non-numeric seq is treated as absent', () => {
    assert.equal(normalizeChatMessage({ playerId: 'p1', text: 'x', seq: 'three' }).seq, null);
  });
});

describe('isSystemMessage', () => {
  test('detects the admin announcer and an explicit system flag', () => {
    assert.equal(isSystemMessage({ playerId: SYSTEM_PLAYER_ID }), true);
    assert.equal(isSystemMessage({ system: true, playerId: 'x' }), true);
    assert.equal(isSystemMessage({ playerId: 'p1' }), false);
    assert.equal(isSystemMessage(null), false);
  });
});

describe('seatColorClass', () => {
  test('spectators and out-of-range seats get their fallbacks', () => {
    assert.equal(seatColorClass(0, true), 'seat-spec');
    assert.equal(seatColorClass(30, false), '');
    assert.equal(seatColorClass(-1, false), '');
    assert.equal(seatColorClass(1.5, false), '');
  });

  test('every seat 0–19 has a colour class', () => {
    for (let i = 0; i < 20; i += 1) assert.equal(seatColorClass(i, false), `seat-${i}`);
  });
});

describe('mergeChat', () => {
  test('sorts by seq and dedupes a repeated seq (the later copy wins)', () => {
    const merged = mergeChat([], [msg(3), msg(1, { text: 'old' }), msg(1, { text: 'new' }), msg(2)]);
    assert.deepEqual(merged.map((m) => [m.seq, m.text]), [[1, 'new'], [2, 'hi'], [3, 'hi']]);
  });

  test('keeps the last `limit` messages and bounds growth', () => {
    const all = Array.from({ length: 12 }, (_, i) => msg(i + 1, { text: `m${i + 1}` }));
    const merged = mergeChat([], all, { limit: 5 });
    assert.deepEqual(merged.map((m) => m.seq), [8, 9, 10, 11, 12]);
  });

  test('folds into the existing list (incremental room.chat) without duplicating', () => {
    const prev = mergeChat([], [msg(1), msg(2)]);
    const next = mergeChat(prev, msg(2, { text: 'again' }));
    assert.deepEqual(next.map((m) => m.seq), [1, 2]);
    assert.equal(next[1].text, 'again');
  });

  test('appends no-seq system lines after the seq list, in timestamp order', () => {
    const merged = mergeChat([], [
      msg(2), { playerId: SYSTEM_PLAYER_ID, text: 'later', at: 2000 },
      msg(1), { playerId: SYSTEM_PLAYER_ID, text: 'earlier', at: 1500 },
    ]);
    assert.deepEqual(merged.map((m) => [m.seq, m.text]), [[1, 'hi'], [2, 'hi'], [null, 'earlier'], [null, 'later']]);
  });

  test('drops garbage entries and tolerates an empty incoming array', () => {
    assert.equal(mergeChat([], []).length, 0);
    assert.equal(mergeChat([], [null, {}, { playerId: 'p1', text: 'ok' }]).length, 1);
  });
});

describe('visibleMessage', () => {
  const player = (over = {}) => normalizeChatMessage({ playerId: 'p1', seq: 1, seat: 0, text: 'x', ...over });
  test('everything shows when the filter is off', () => {
    assert.equal(visibleMessage(player({ isSpectator: true })), true);
    assert.equal(visibleMessage(player()), true);
  });
  test('team-only hides spectators but keeps seated players and system lines', () => {
    assert.equal(visibleMessage(player({ isSpectator: true }), { teamOnly: true }), false);
    assert.equal(visibleMessage(player(), { teamOnly: true }), true);
    assert.equal(visibleMessage(normalizeChatMessage({ playerId: SYSTEM_PLAYER_ID, seat: -1, text: 'x' }), { teamOnly: true }), true);
  });
});

test('CHAT_HISTORY_LIMIT is 200 (the documented server history bound)', () => {
  assert.equal(CHAT_HISTORY_LIMIT, 200);
});
