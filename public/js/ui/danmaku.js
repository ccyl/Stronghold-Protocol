// Danmaku (弹幕) engine — the pure, DOM-free scheduling core behind the in-match bullet comments (ui/danmakuOverlay.js).
// The overlay subscribes to the same two event streams as the existing bubbles (ui/bubbles.js): chat messages
// (`room.chat`, held in store.chatMessages) and emotes (`m.emote`, held in store.emotes). Each event is *ingested* into
// this engine, which queues it, merges a rapid repeat of the same emote into one "×N" item, and *pumps* queued items up
// into a fixed set of horizontal lanes (泳道) that carry them across the field for a fixed dwell (DANMAKU_LANE_MS), then
// drops them. The engine owns only state and clock arithmetic — it never touches the DOM or the browser — so it is unit
// tested in Node (test/ui/danmaku.test.js). The design follows Stardust's danmaku (HANDOVER-2026-11-01 §5.1):
// a small number of lanes, same-emote merging ×N within a short window, a bounded queue, and a `wake` clock that lets the
// overlay run its requestAnimationFrame loop only while there is something to draw (and under reduced motion, not at all).
//
// Timestamps are opaque numbers: the engine only ever compares and adds (`at` diffs for merging, `now` + laneMs for the
// dwell), so the overlay may feed client `Date.now()` for emotes and the server's `at` for chat without any need to align
// the two clocks — merging applies to emotes only, which all come from the client's own clock.

export const DANMAKU_LANES = 3;          // 泳道: the number of simultaneous horizontal tracks.
export const DANMAKU_QUEUE_CAP = 8;      // 队列上限: enough pending items are dropped, not unbounded.
export const DANMAKU_MERGE_WINDOW_MS = 800; // 同表情合并窗口: a repeat of the same emote within this window folds into ×N.
export const DANMAKU_LANE_MS = 6000;     // 泳道停留: how long an item rides a lane before it is dropped.

/**
 * Create a danmaku scheduler.
 * @param {{ lanes?: number, queueCap?: number, mergeWindowMs?: number, laneMs?: number }} [opts]
 * @returns {{ ingest: (evt: object) => object|null, pump: (now: number) => object[], flying: () => object[],
 *   wake: (now: number) => boolean, stats: () => { queued: number, flying: number, lanes: number } }}
 */
export function createDanmaku({ lanes = DANMAKU_LANES, queueCap = DANMAKU_QUEUE_CAP, mergeWindowMs = DANMAKU_MERGE_WINDOW_MS, laneMs = DANMAKU_LANE_MS } = {}) {
  const laneState = Array.from({ length: Math.max(1, lanes) }, () => ({ until: -Infinity }));
  const queue = [];     // items waiting for a free lane, oldest first.
  const flying = [];    // items currently riding a lane, oldest first.
  let lastEmote = null; // { at, emoteId, item } — the most recent emote, for same-emote merging.

  const freeLane = (now) => laneState.findIndex((l) => l.until <= now);

  /**
   * Accept one event. A repeat emote within `mergeWindowMs` of the last same emote merges into that item (×N) and returns
   * it; otherwise a new item is queued (or dropped, returning null, when the queue is already at `queueCap`).
   * Chat is never merged.
   * @param {{ kind: 'chat'|'emote', key: any, playerId: any, at: number, [k: string]: any }} evt
   * @returns {object|null} the queue/flying item (mutated on later merges), or null when dropped.
   */
  function ingest(evt) {
    if (!evt || (evt.kind !== 'chat' && evt.kind !== 'emote')) return null;
    const at = Number.isFinite(evt.at) ? evt.at : 0;
    if (evt.kind === 'emote') {
      const same = lastEmote && lastEmote.emoteId === evt.emoteId;
      if (same && at >= lastEmote.at && at - lastEmote.at <= mergeWindowMs) {
        lastEmote.item.n += 1;
        lastEmote.at = at;
        return lastEmote.item;
      }
    }
    if (queue.length >= queueCap) return null;
    const item = evt.kind === 'emote'
      ? { key: evt.key, kind: 'emote', playerId: evt.playerId, emoteId: evt.emoteId, at, n: 1, lane: null, until: 0 }
      : { key: evt.key, kind: 'chat', playerId: evt.playerId, name: evt.name ?? '', seat: Number.isInteger(evt.seat) ? evt.seat : 0, isSpectator: !!evt.isSpectator, text: typeof evt.text === 'string' ? evt.text : '', at, n: 1, lane: null, until: 0 };
    queue.push(item);
    if (evt.kind === 'emote') lastEmote = { at, emoteId: evt.emoteId, item };
    return item;
  }

  /**
   * Advance the clock: release lanes whose dwell has passed, drop flown items, then promote queued items onto free lanes.
   * @param {number} now
   * @returns {object[]} the items currently flying (after this pump).
   */
  function pump(now) {
    for (let i = 0; i < laneState.length; i++) if (laneState[i].until <= now) laneState[i].until = -Infinity;
    for (let i = flying.length - 1; i >= 0; i--) if (flying[i].until <= now) flying.splice(i, 1);
    let idx;
    while (queue.length > 0 && (idx = freeLane(now)) >= 0) {
      const item = queue.shift();
      item.lane = idx;
      item.until = now + laneMs;
      laneState[idx].until = item.until;
      flying.push(item);
    }
    return flying;
  }

  const flyingNow = () => flying;

  /**
   * Whether there is work to draw now: a queued item waiting for a lane, or an item still riding one. The overlay runs its
   * rAF loop only while this is true and stops the moment there is nothing left to animate.
   * @param {number} now
   */
  function wake(now) {
    if (queue.length > 0) return true;
    return flying.some((f) => f.until > now);
  }

  return { ingest, pump, flying: flyingNow, wake, stats: () => ({ queued: queue.length, flying: flying.length, lanes: laneState.length }) };
}