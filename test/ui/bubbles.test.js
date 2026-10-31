// Bubbles beside avatars: which one shows, and when it goes away (public/js/ui/bubbles.js).
// The regression these cover: the chat text bubble was folded into a `useMemo` with no clock dependency, so it never
// expired and could overwrite an emote.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeBubbles, DEFAULT_BUBBLE_MS } from '../../public/js/ui/bubbles.js';

const emote = (playerId, seq, at, id = 'e' + seq) => ({ seq, playerId, id, at });
const chat = (playerId, text, at, seq) => ({ playerId, text, at, seq });

describe('computeBubbles', () => {
  test('an emote younger than the TTL is shown as a picture bubble', () => {
    const now = 10_000;
    const map = computeBubbles({ emotes: [emote('p1', 1, now - 500)], now });
    assert.deepEqual(map.get('p1'), { kind: 'emote', id: 'e1', seq: 1, at: now - 500 });
  });

  test('an expired emote is gone (the map is recomputed, not cached)', () => {
    const now = 10_000;
    const map = computeBubbles({ emotes: [emote('p1', 1, now - DEFAULT_BUBBLE_MS)], now });
    assert.equal(map.has('p1'), false);
  });

  test('chat text shows while it is fresh and disappears once its TTL passes', () => {
    const now = 10_000;
    const fresh = computeBubbles({ chatMessages: [chat('p1', 'hi', now - 1_000)], now });
    assert.equal(fresh.get('p1').kind, 'text');
    assert.equal(fresh.get('p1').text, 'hi');
    const stale = computeBubbles({ chatMessages: [chat('p1', 'hi', now - DEFAULT_BUBBLE_MS)], now });
    assert.equal(stale.has('p1'), false, 'the text bubble expires on its own');
  });

  test('a TTL from the configured timers is honoured', () => {
    const now = 10_000;
    const map = computeBubbles({ chatMessages: [chat('p1', 'hi', now - 2_000)], now, chatTtl: 1_000 });
    assert.equal(map.has('p1'), false);
  });

  test('text wins over an emote from the same player while both are alive', () => {
    const now = 10_000;
    const map = computeBubbles({
      emotes: [emote('p1', 3, now - 200)],
      chatMessages: [chat('p1', 'hello', now - 100)],
      now,
    });
    assert.equal(map.get('p1').kind, 'text');
    assert.equal(map.get('p1').text, 'hello');
  });

  test('the emote comes back after the text expires', () => {
    const now = 10_000;
    const map = computeBubbles({
      emotes: [emote('p1', 3, now - 200)],
      chatMessages: [chat('p1', 'hello', now - 2_900)],
      now,
      chatTtl: 1_000,
      emoteTtl: 3_000,
    });
    assert.equal(map.get('p1').kind, 'emote');
  });

  test('the newest event wins per player, and players do not collide', () => {
    const now = 10_000;
    const map = computeBubbles({
      emotes: [emote('p1', 1, now - 2_000), emote('p1', 2, now - 100), emote('p2', 5, now - 50)],
      chatMessages: [chat('p3', 'old', now - 500), chat('p3', 'new', now - 100)],
      now,
    });
    assert.equal(map.get('p1').seq, 2);
    assert.equal(map.get('p2').kind, 'emote');
    assert.equal(map.get('p3').text, 'new');
    assert.equal(map.size, 3);
  });

  test('a clock ahead of ours is tolerated within a second, not beyond it', () => {
    const now = 10_000;
    assert.equal(computeBubbles({ emotes: [emote('p1', 1, now + 500)], now }).has('p1'), true);
    assert.equal(computeBubbles({ emotes: [emote('p1', 1, now + 5_000)], now }).has('p1'), false);
  });

  test('empty text, missing ids and garbage input are ignored', () => {
    const now = 10_000;
    const map = computeBubbles({
      emotes: [null, {}, { playerId: 'p1', id: 'x', at: 'later' }],
      chatMessages: [chat('p1', '   ', now), chat('', 'hi', now), { playerId: 'p2', text: 'ok' }],
      now,
    });
    assert.equal(map.has('p1'), false);
    assert.deepEqual([...map.keys()], ['p2'], 'a message without a timestamp is still measured from now');
    assert.equal(computeBubbles({ now }).size, 0);
    assert.equal(computeBubbles({ emotes: 'nope', chatMessages: 42, now }).size, 0);
  });
});
