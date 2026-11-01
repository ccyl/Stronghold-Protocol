// server/roomChat.js — 房间聊天状态与令牌桶限流（this branch: 聊天重做 M1）
// 参考：SiderLock server/matchChat.js（seq + 有界历史 + 每玩家/房间令牌桶）。
//
// 一个房间一个 RoomChat：单调递增 seq、最多 CHAT_HISTORY_LIMIT 条历史、
// 每玩家令牌桶（0.5/s 恢复、突发 3）+ 房间令牌桶（10/s 恢复、突发 20）两级限流。

import { CHAT_HISTORY_LIMIT } from '../shared/chat.js';

export const CHAT_BUCKETS = Object.freeze({
  // 每玩家：0.5 token/秒恢复，容量 3（突发最多 3 条）
  player: Object.freeze({ capacity: 3, refillPerSec: 0.5 }),
  // 房间：10 token/秒恢复，容量 20（突发最多 20 条）
  room: Object.freeze({ capacity: 20, refillPerSec: 10 }),
});

/** 一个令牌桶：tokens 当前量，ts 上次补充的时间戳（ms）。 */
function makeBucket(capacity, now) {
  return { tokens: capacity, ts: now };
}

/** 按经过时间补充一个桶，把 ts 推进到 now。 */
function refill(bucket, { capacity, refillPerSec }, now) {
  const dt = Math.max(0, now - bucket.ts) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + dt * refillPerSec);
  bucket.ts = now;
}

export class RoomChat {
  /**
   * @param {object} [opts]
   * @param {() => number} [opts.now] 时钟（测试注入）
   * @param {number} [opts.historyLimit]
   * @param {{ player: {capacity:number, refillPerSec:number}, room: {capacity:number, refillPerSec:number} }} [opts.buckets]
   */
  constructor({ now = Date.now, historyLimit = CHAT_HISTORY_LIMIT, buckets = CHAT_BUCKETS } = {}) {
    this.now = now;
    this.historyLimit = historyLimit;
    this.buckets = buckets;
    /** 已分配的最大 seq（0 = 暂无消息）。 */
    this.seq = 0;
    /** 有界历史，旧→新。 */
    this.messages = [];
    /** @type {Map<string, {tokens:number, ts:number}>} */
    this._playerBuckets = new Map();
    this._room = makeBucket(buckets.room.capacity, now());
  }

  _playerBucket(playerId) {
    let b = this._playerBuckets.get(playerId);
    if (!b) {
      b = makeBucket(this.buckets.player.capacity, this.now());
      this._playerBuckets.set(playerId, b);
    }
    return b;
  }

  /**
   * 尝试消耗一枚令牌（房间桶 + 玩家桶各扣一枚）。失败不扣（桶已按时间补充）。
   * @param {string} playerId
   * @returns {boolean}
   */
  tryConsume(playerId) {
    const now = this.now();
    const room = this._room;
    refill(room, this.buckets.room, now);
    const player = this._playerBucket(playerId);
    refill(player, this.buckets.player, now);
    if (room.tokens < 1 || player.tokens < 1) return false;
    room.tokens -= 1;
    player.tokens -= 1;
    return true;
  }

  /**
   * 追加一条消息（调用方已 tryConsume 成功）。返回带 seq/at 的完整条目，并维持有界历史。
   * @param {{ playerId: string, name: string, seat: number, isSpectator: boolean, text: string }} entry
   * @returns {{ seq: number, playerId: string, name: string, seat: number, isSpectator: boolean, text: string, at: number }}
   */
  append({ playerId, name, seat, isSpectator, text }) {
    const message = { seq: ++this.seq, playerId, name, seat, isSpectator, text, at: this.now() };
    this.messages.push(message);
    if (this.messages.length > this.historyLimit) {
      this.messages.splice(0, this.messages.length - this.historyLimit);
    }
    return message;
  }

  /** room.chatState 快照：{ seq, messages }（messages 为旧→新的副本）。 */
  snapshot() {
    return { seq: this.seq, messages: this.messages.slice() };
  }
}