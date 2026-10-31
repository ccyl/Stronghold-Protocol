// public/js/ui/bubbles.js — which bubble is on screen beside each player's avatar right now.
//
// The team panel shows one bubble per player: either an 交流 emote picture or the text of a chat message. Both are
// short-lived, and the chat text used to be folded into the emote map inside a `useMemo` whose dependencies had no
// clock in them — so the map was never recomputed on a ticker and the last text bubble stayed on screen until the
// next message (and an emote could be overwritten by a stale text). This module is that computation, pure and
// clock-explicit, so it can be recomputed on every render and unit-tested without a DOM.

/** How long an emote bubble stays up when the caller has no configured value (constData.chatTime = 3 s). */
export const DEFAULT_BUBBLE_MS = 3000;
/** A clock slightly ahead of `now` is tolerated (another machine's timestamp), the same slack the emote map used. */
const FUTURE_SLACK_MS = 1000;

/**
 * @typedef {{ kind: 'emote', id: string, seq: number, at: number }
 *   | { kind: 'text', text: string, seq: number, at: number }} Bubble
 */

/**
 * The bubbles alive at `now`: playerId → bubble, an emote picture or chat text.
 *
 * Rules: only events younger than their TTL count; a timestamp more than a second in the future is ignored; the newest
 * event wins per player; when a player has both, the text wins (a text is what the player just typed, while the emote
 * pops again on the next one). The returned map is fresh on every call — expiry needs no state.
 *
 * @param {{ emotes?: any[], chatMessages?: any[], now: number, emoteTtl?: number, chatTtl?: number }} input
 * @returns {Map<string, Bubble>}
 */
export function computeBubbles({ emotes, chatMessages, now, emoteTtl = DEFAULT_BUBBLE_MS, chatTtl = DEFAULT_BUBBLE_MS }) {
  const t = Number.isFinite(now) ? now : Date.now();
  const emote = new Map();
  for (const e of Array.isArray(emotes) ? emotes : []) {
    if (!e || typeof e.playerId !== 'string' || !e.playerId) continue;
    const at = Number(e.at);
    if (!Number.isFinite(at) || at > t + FUTURE_SLACK_MS) continue;
    if (!(t - at < emoteTtl)) continue;
    const cur = emote.get(e.playerId);
    const seq = Number(e.seq) || 0;
    if (!cur || cur.seq <= seq) emote.set(e.playerId, { kind: 'emote', id: e.id, seq, at });
  }

  const text = new Map();
  for (const m of Array.isArray(chatMessages) ? chatMessages : []) {
    if (!m || typeof m.playerId !== 'string' || !m.playerId) continue;
    if (typeof m.text !== 'string' || !m.text.trim()) continue;
    // A message without a timestamp is treated as just arrived (old local/fallback entries), so it still shows and
    // expires instead of staying invisible forever.
    const rawAt = Number(m.at);
    const at = Number.isFinite(rawAt) ? rawAt : t;
    if (at > t + FUTURE_SLACK_MS) continue;
    if (!(t - at < chatTtl)) continue;
    const cur = text.get(m.playerId);
    const seq = Number.isFinite(Number(m.seq)) ? Number(m.seq) : at;
    if (!cur || cur.at <= at) text.set(m.playerId, { kind: 'text', text: m.text, seq, at });
  }

  const out = new Map(emote);
  for (const [pid, bubble] of text) out.set(pid, bubble);
  return out;
}
