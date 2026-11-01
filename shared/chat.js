// shared/chat.js — 局内文字聊天规范（this branch: 聊天重做 M1）
// 参考：SiderLock shared/matchChat.js（文本规范化 + 上限 + 拒绝而非截断）。
//
// 文本规则：NFC 归一 → 去控制符 → trim → 空或超长拒绝（不截断）。
// 长度按规范化后的 UTF-16 code unit 计数。

/** 单条聊天文本上限（规范化后）。超出拒绝，不截断。 */
export const CHAT_MAX_LEN = 200;

/** 房间有界历史条数。 */
export const CHAT_HISTORY_LIMIT = 200;

/**
 * 规范化一条聊天文本：非字符串 → null；NFC 归一；去控制符（保留 \t \n \r）；trim；
 * 空或超长 → null。合法则返回规范化文本。
 * @param {any} raw
 * @returns {string | null}
 */
export function normalizeChatText(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFC').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
  if (!text) return null;
  if (text.length > CHAT_MAX_LEN) return null;
  return text;
}

/** 协议校验器（shared/protocol.js 的 room.chat）：可接受则 true。 */
export const isChatText = (v) => normalizeChatText(v) != null;