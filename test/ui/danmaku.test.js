// test/ui/danmaku.test.js — the pure scheduling core of the in-match 弹幕 (public/js/ui/danmaku.js): queue with a
// bound, promotion into a fixed set of lanes with a dwell, same-emote merging into ×N, and the wake clock the overlay
// uses to run its requestAnimationFrame loop only while there is something to animate. No DOM, no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDanmaku, DANMAKU_LANES, DANMAKU_QUEUE_CAP, DANMAKU_LANE_MS } from '../../public/js/ui/danmaku.js';

const chat = (key, ops = {}) => ({ kind: 'chat', key, playerId: 'p', name: '博士', seat: 0, isSpectator: false, text: '你好', at: 0, ...ops });
const emote = (key, emoteId, at) => ({ kind: 'emote', key, playerId: 'p', emoteId, at });

test('ingest queues a chat item without assigning a lane', () => {
  const d = createDanmaku();
  const item = d.ingest(chat('a'));
  assert.equal(item.kind, 'chat');
  assert.equal(item.text, '你好');
  assert.equal(item.lane, null);
  assert.deepEqual(d.stats(), { queued: 1, flying: 0, lanes: DANMAKU_LANES });
});

test('pump promotes queued items onto free lanes with a dwell', () => {
  const d = createDanmaku();
  d.ingest(chat('a'));
  d.ingest(chat('b'));
  d.ingest(chat('c'));
  const flying = d.pump(1000);
  assert.equal(flying.length, 3);
  assert.deepEqual(flying.map((f) => f.lane), [0, 1, 2]);
  assert.deepEqual(flying.map((f) => f.until), [1000 + DANMAKU_LANE_MS, 1000 + DANMAKU_LANE_MS, 1000 + DANMAKU_LANE_MS]);
  assert.deepEqual(d.stats(), { queued: 0, flying: 3, lanes: DANMAKU_LANES });
});

test('a queue beyond the lanes stays queued until a lane frees', () => {
  const d = createDanmaku();
  for (let i = 0; i < 5; i++) d.ingest(chat(`m${i}`));
  d.pump(0);
  assert.deepEqual(d.stats(), { queued: 2, flying: 3, lanes: DANMAKU_LANES });
  // a further pump at the same instant has no free lane, nothing moves
  d.pump(0);
  assert.deepEqual(d.stats(), { queued: 2, flying: 3, lanes: DANMAKU_LANES });
});

test('a lane frees after its dwell and the next queued item takes it', () => {
  const d = createDanmaku();
  for (let i = 0; i < 4; i++) d.ingest(chat(`m${i}`));
  d.pump(0);
  // at exactly 0 + laneMs the first ride has ended (until <= now), so the 4th item is promoted
  const flying = d.pump(DANMAKU_LANE_MS);
  assert.equal(d.stats().queued, 0);
  assert.equal(d.stats().flying, 1, 'all three started together, so all three expired at once; only m3 is promoted');
  assert.equal(flying[0].key, 'm3');
  assert.equal(flying[0].lane, 0);
});

test('same emote within the merge window folds into one ×N item', () => {
  const d = createDanmaku();
  const first = d.ingest(emote('e', 'happy', 0));
  assert.equal(first.n, 1);
  const merged = d.ingest(emote('e', 'happy', 500));
  assert.equal(merged, first, 'returns the same item object');
  assert.equal(merged.n, 2);
  assert.deepEqual(d.stats(), { queued: 1, flying: 0, lanes: DANMAKU_LANES }, 'merged, not a second queued item');
});

test('a chain of repeats keeps folding into the same item', () => {
  const d = createDanmaku();
  const item = d.ingest(emote('e', 'happy', 0));
  d.ingest(emote('e', 'happy', 400));
  d.ingest(emote('e', 'happy', 799)); // 0->400 (400ms) merges, 400->799 (399ms) merges
  assert.equal(item.n, 3);
  assert.deepEqual(d.stats(), { queued: 1, flying: 0, lanes: DANMAKU_LANES });
});

test('the same emote after the window is a new item, and different emotes never merge', () => {
  const d = createDanmaku();
  const a = d.ingest(emote('e1', 'happy', 0));
  const b = d.ingest(emote('e2', 'happy', 900)); // 900 > 800: new item
  assert.notEqual(b, a);
  assert.equal(a.n, 1);
  assert.equal(b.n, 1);
  d.ingest(emote('e3', 'sad', 100)); // different emoteId: never merged, even inside the window
  assert.deepEqual(d.stats(), { queued: 3, flying: 0, lanes: DANMAKU_LANES });
});

test('a repeat emote merges into an already-flying item (×N updates live)', () => {
  const d = createDanmaku();
  const item = d.ingest(emote('e', 'happy', 0));
  d.pump(0); // promoted to a lane
  assert.equal(d.stats().flying, 1);
  d.ingest(emote('e', 'happy', 300));
  assert.equal(item.n, 2);
  assert.equal(d.stats().flying, 1, 'still a single flying item, no new lane taken');
});

test('chat is never merged, even when identical', () => {
  const d = createDanmaku();
  d.ingest(chat('c1'));
  d.ingest(chat('c2'));
  assert.deepEqual(d.stats(), { queued: 2, flying: 0, lanes: DANMAKU_LANES });
});

test('the queue is bounded: past the cap items are dropped, not accumulated', () => {
  const d = createDanmaku();
  for (let i = 0; i < DANMAKU_QUEUE_CAP; i++) assert.ok(d.ingest(chat(`c${i}`)), `queues the ${i + 1}th`);
  assert.equal(d.ingest(chat('overflow')), null, 'the item over the cap is dropped');
  assert.equal(d.stats().queued, DANMAKU_QUEUE_CAP);
});

test('a repeat emote merges before the cap check, so a full queue never drops it', () => {
  const d = createDanmaku();
  const item = d.ingest(emote('e', 'happy', 0));
  d.pump(0); // the emote flies; the queue is now empty
  for (let i = 0; i < DANMAKU_QUEUE_CAP; i++) d.ingest(chat(`c${i}`)); // fill the queue to the cap
  assert.equal(d.stats().queued, DANMAKU_QUEUE_CAP);
  const merged = d.ingest(emote('e', 'happy', 100));
  assert.equal(merged, item, 'merges into the flying item instead of being dropped');
  assert.equal(item.n, 2);
  assert.equal(d.stats().queued, DANMAKU_QUEUE_CAP, 'the queue is untouched');
});

test('wake is true while items are queued or flying, and false once everything is spent', () => {
  const d = createDanmaku();
  assert.equal(d.wake(0), false, 'empty engine is asleep');
  d.ingest(chat('a'));
  assert.equal(d.wake(0), true, 'a queued item wakes the overlay');
  d.pump(0);
  assert.equal(d.wake(0), true, 'a flying item keeps it awake');
  d.pump(DANMAKU_LANE_MS);
  assert.equal(d.wake(DANMAKU_LANE_MS), false, 'no queued and no flying: asleep again');
});

test('ingest ignores junk events', () => {
  const d = createDanmaku();
  assert.equal(d.ingest(null), null);
  assert.equal(d.ingest({ kind: 'system' }), null);
  assert.equal(d.ingest({ at: 12 }), null);
  assert.deepEqual(d.stats(), { queued: 0, flying: 0, lanes: DANMAKU_LANES });
});

test('configurable geometry: lanes and dwell are respected', () => {
  const d = createDanmaku({ lanes: 2, laneMs: 100 });
  d.ingest(chat('a'));
  d.ingest(chat('b'));
  d.ingest(chat('c'));
  const flying = d.pump(0);
  assert.equal(flying.length, 2);
  assert.deepEqual(flying.map((f) => f.lane), [0, 1]);
  assert.deepEqual(d.stats(), { queued: 1, flying: 2, lanes: 2 });
  d.pump(100);
  assert.equal(d.stats().flying, 1, 'both lanes freed, the 3rd item now rides');
});