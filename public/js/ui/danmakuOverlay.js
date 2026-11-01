// Danmaku overlay (弹幕) — the in-match bullet comments layered over the field: chat messages and emotes fly across a
// small set of horizontal lanes (泳道). This is the thin Preact binding over the pure engine (ui/danmaku.js); the engine
// owns all scheduling (queue, same-emote merging ×N, lane dwell), and this component only:
//   * feeds it the two event streams it already has — store.chatMessages (room.chat) and store.emotes (m.emote) — once,
//     by remembering the highest chat `seq` / `at` and emote `seq` already ingested (so the join/reconnect chat replay in
//     room.chatState is never re-flown as a fresh bullet, and an arrival is never ingested twice);
//   * runs a requestAnimationFrame loop that pumps the engine only while there is something to draw (engine.wake), and
//     stops the instant everything is spent — no per-frame work on an idle table;
//   * renders each flying item in its lane. Nothing here blocks a click: the container is pointer-events:none in CSS, and
//     the text is decorative (the chat log already presents it readably) so the overlay is aria-hidden.
//
// 弹幕 switch (设置 →「弹幕」: 开启 / 仅队友 / 关闭) is read from the settings store. 仅队友 drops spectators — chat from
// the message's own `isSpectator` flag, emotes by looking the sender up in the room's spectator list (m.emote carries no
// name or seat). The admin announcement (playerId 'system') stays in the chat log; it is not flown as a bullet. Reduced
// motion is handled in CSS (the .sp-reduced-motion class on <html>, installed by ui/device.js): the items are shown
// statically and simply expire, never flying across the screen.

import { useCallback, useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html } from './components.js';
import { useStore, isSpectating } from '../store.js';
import { useSettings } from './settings.js';
import { EmoteArt } from './emotes.js';
import { createDanmaku, DANMAKU_LANES } from './danmaku.js';
import { seatColorClass } from './chatLog.js';

/** First ingest bootstrap: build the highest markers already present so a mounted overlay over an in-flight match does not
 *  replay the whole history. Chat is seq'd (server) with a few seq-less admin rows; emotes are seq'd by the client. */
function initialMarkers(chatMessages, emotes) {
  let chatSeq = 0;
  let chatAt = 0;
  for (const m of chatMessages || []) {
    const seq = Number.isFinite(Number(m?.seq)) ? Number(m.seq) : null;
    if (seq != null) { if (seq > chatSeq) chatSeq = seq; }
    else { const at = Number.isFinite(m?.at) ? m.at : 0; if (at > chatAt) chatAt = at; }
  }
  let emoteSeq = 0;
  for (const e of emotes || []) { const s = Number.isFinite(e?.seq) ? e.seq : 0; if (s > emoteSeq) emoteSeq = s; }
  return { chatSeq, chatAt, emoteSeq };
}

/** The name: text of a danmaku chat item (a system announcement is filtered before it ever reaches here). */
function ChatItem({ item }) {
  return html`<span class=${`danmaku__item danmaku__chat ${seatColorClass(item.seat, item.isSpectator)}`}>
    <b class="danmaku__name">${item.name || ''}</b><span class="danmaku__text">${item.text}</span>
  </span>`;
}

function EmoteItem({ item }) {
  return html`<span class="danmaku__item danmaku__emote">
    <${EmoteArt} id=${item.emoteId} />
    ${item.n > 1 ? html`<span class="danmaku__count">×${item.n}</span>` : null}
  </span>`;
}

export function Danmaku() {
  const { danmaku: mode } = useSettings();
  const chatMessages = useStore((s) => s.chatMessages) || [];
  const emotes = useStore((s) => s.emotes) || [];
  const room = useStore((s) => s.room);

  const engineRef = useRef(null);
  if (!engineRef.current) engineRef.current = createDanmaku();
  const engine = engineRef.current;

  // The highest seq / at already ingested; live refs so the ingest effects read them without re-subscribing.
  const seen = useRef(null);
  if (!seen.current) seen.current = initialMarkers(chatMessages, emotes);

  const [, force] = useState(0);          // pump the render from inside the rAF loop
  const [activity, setActivity] = useState(0); // bumped on every new ingest: restarts the rAF loop
  const rerender = useCallback(() => force((n) => n + 1), []);

  useEffect(() => {
    const s = seen.current;
    for (const m of chatMessages) {
      const seq = Number.isFinite(Number(m?.seq)) ? Number(m.seq) : null;
      if (seq != null) { if (seq <= s.chatSeq) continue; s.chatSeq = seq; }
      else { const at = Number.isFinite(m?.at) ? m.at : 0; if (at <= s.chatAt) continue; s.chatAt = at; }
      if (mode === 'off') continue;                                     // 关闭: still advance markers, but never fly
      if (m.playerId === 'system' || m.system === true) continue;       // announcements stay in the log
      if (mode === 'team' && m.isSpectator) continue;                   // 仅队友: drop spectators
      engine.ingest({ kind: 'chat', key: seq != null ? `c${seq}` : `c${m.at}-${m.playerId}`, playerId: m.playerId,
        name: m.name, seat: m.seat, isSpectator: !!m.isSpectator, text: m.text, at: m.at });
    }
    setActivity((n) => n + 1);
  }, [chatMessages, mode, engine]);

  useEffect(() => {
    const s = seen.current;
    for (const e of emotes) {
      const seq = Number.isFinite(e?.seq) ? e.seq : 0;
      if (seq <= s.emoteSeq) continue;
      s.emoteSeq = seq;
      if (mode === 'off') continue;
      if (mode === 'team' && isSpectating(room, e.playerId)) continue;
      engine.ingest({ kind: 'emote', key: `e${seq}`, playerId: e.playerId, emoteId: e.id, at: e.at });
    }
    setActivity((n) => n + 1);
  }, [emotes, mode, room, engine]);

  // The rAF loop: start (or restart) on every ingest; each tick pumps the engine while it has work and then stops. An
  // idle table does no per-frame work.
  useEffect(() => {
    if (mode === 'off') return undefined;
    let raf = 0;
    const step = () => {
      const now = Date.now();
      if (engine.wake(now)) { engine.pump(now); rerender(); raf = requestAnimationFrame(step); }
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [mode, activity, engine, rerender]);

  if (mode === 'off') return null;

  const flying = engine.flying();
  return html`<div class="danmaku" aria-hidden="true">
    ${Array.from({ length: DANMAKU_LANES }, (_, lane) => {
      const item = flying.find((f) => f.lane === lane);
      return html`<div class=${`danmaku__lane danmaku__lane--${lane}`}>
        ${item ? (item.kind === 'emote' ? html`<${EmoteItem} item=${item} />` : html`<${ChatItem} item=${item} />`) : null}
      </div>`;
    })}
  </div>`;
}