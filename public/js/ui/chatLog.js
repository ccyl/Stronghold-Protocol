// public/js/ui/chatLog.js — the client's chat message model: normalise a wire message, fold it into a bounded
// seq-sorted list (dedupe by server seq), and the seat-colour / visibility rules. Pure and DOM-free so it can be
// unit-tested directly (test/ui/chatLog.test.js), the same way bubbles.js is.
//
// Mirrors the server kernel (server/roomChat.js): `seq` is the server's monotonic message number; the server keeps
// the last CHAT_HISTORY_LIMIT messages and replays them on join / reconnect via S2C `room.chatState`.
// System broadcasts (server/admin.js) bypass that kernel and have no seq.

import { CHAT_HISTORY_LIMIT } from '../../../shared/chat.js';
import { MAX_SEATS } from '../../../shared/constants.js';

/** The playerId the admin announcement uses (server/admin.js); treated as a system line, not a player. */
export const SYSTEM_PLAYER_ID = 'system';

/** @param {any} msg @returns {boolean} whether the message is a system line (admin announcement, etc.). */
export function isSystemMessage(msg) {
  return !!(msg && (msg.system === true || msg.playerId === SYSTEM_PLAYER_ID));
}

/**
 * Normalise an S2C `room.chat` message or a `room.chatState` record into the client record, or null when it cannot be
 * shown (no playerId, no non-empty text). The server's `seq` is kept when it is a finite number (system broadcasts
 * have none); a missing timestamp becomes 0 so the record still has a numeric `at`.
 *
 * @param {any} msg
 * @returns {{ seq: number|null, playerId: string, name: string, seat: number, isSpectator: boolean,
 *             system: boolean, text: string, at: number } | null}
 */
export function normalizeChatMessage(msg) {
  if (!msg || typeof msg !== 'object') return null;
  const playerId = typeof msg.playerId === 'string' ? msg.playerId : '';
  const text = typeof msg.text === 'string' ? msg.text : '';
  if (!playerId || !text.trim()) return null;
  return {
    seq: Number.isFinite(msg.seq) ? msg.seq : null,
    playerId,
    name: typeof msg.name === 'string' ? msg.name : '',
    seat: Number.isInteger(msg.seat) ? msg.seat : 0,
    isSpectator: !!msg.isSpectator,
    system: playerId === SYSTEM_PLAYER_ID || msg.system === true,
    text,
    at: Number.isFinite(msg.at) ? msg.at : 0,
  };
}

/**
 * The CSS modifier for a message's seat colour: `seat-spec` for spectators, `seat-${n}` for seated seats 0–19
 * (MAX_SEATS), and '' when there is no colour to apply (system lines, out-of-range).
 *
 * @param {number} seat
 * @param {boolean} isSpectator
 * @returns {string}
 */
export function seatColorClass(seat, isSpectator) {
  if (isSpectator) return 'seat-spec';
  return Number.isInteger(seat) && seat >= 0 && seat < MAX_SEATS ? `seat-${seat}` : '';
}

/**
 * Fold `prev` plus one or more `incoming` messages into a single bounded list: dedupe by server `seq` (a later copy
 * wins), sort seq'd records ascending, append the no-seq system lines (sorted by `at`), keep the last `limit`.
 *
 * @param {any[]} prev current records
 * @param {any|any[]} incoming one record or an array
 * @param {{ limit?: number }} [opts]
 * @returns {any[]}
 */
export function mergeChat(prev, incoming, { limit = CHAT_HISTORY_LIMIT } = {}) {
  const bySeq = new Map();
  const noSeq = [];
  const walk = (list) => {
    for (const raw of Array.isArray(list) ? list : [list]) {
      const rec = normalizeChatMessage(raw);
      if (!rec) continue;
      if (rec.seq != null) bySeq.set(rec.seq, rec);
      else noSeq.push(rec);
    }
  };
  walk(prev);
  walk(incoming);
  const seqd = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  noSeq.sort((a, b) => (a.at || 0) - (b.at || 0));
  const merged = seqd.concat(noSeq);
  return merged.length > limit ? merged.slice(merged.length - limit) : merged;
}

/**
 * Whether a message is shown under the current filters. 只看队友 (teamOnly) hides spectators but always keeps system
 * lines: a room's seated players are the teammates, and an observer is not.
 *
 * @param {ReturnType<typeof normalizeChatMessage>} msg
 * @param {{ teamOnly?: boolean }} [opts]
 * @returns {boolean}
 */
export function visibleMessage(msg, { teamOnly = false } = {}) {
  if (!msg) return false;
  if (!teamOnly) return true;
  if (msg.system) return true;
  return !msg.isSpectator;
}
