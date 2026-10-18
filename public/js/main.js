// Client entry: boot (fonts, identity, socket), net → store wiring, router, global overlays.
//
// Router (derived from the store, no URL routes):
//   not entered            → Title
//   m.public.phase ≠ LOBBY → Game (screens/game.js: briefing / band draft / match / result by phase)
//   room.inMatch           → Game (match starting, m.public on its way)
//   in a room              → Room
//   otherwise              → Lobby
// Deep link `?room=CODE`: remembered at boot, auto-joined once the player has entered and the
// session is online (after a short grace period in case the server restores a room on resume).
// Reloading a tab that already passed the title re-enters automatically (sessionStorage flag) and
// resumes the server session with the saved token; stale room/match state is dropped if the
// server does not re-push it within RESTORE_GRACE_MS after `welcome`. Boot waits for
// `identity.init()` (which token this tab may use without stealing another live tab's session)
// before the first connect; a page restored from the back/forward cache reloads.
// A `welcome` with a NEW playerId (the server restarted / the session expired) while a room or match was on screen:
// toast 「服务器会话已重置，上一局模拟已结束」 (store.js sessionResetNotice) and return to the lobby with nothing stale.
//
// Shared modules are imported relatively ('../../shared/…' resolves to /shared/… in the browser).
// Multi-device support (ui/device.js + css/devices.css): feature classes on <html>, no page zoom, safe areas, rotation
// re-layout; ui/compat.js polyfills are imported before anything else.
// 干员调配 (DESIGN §16): an overlay over any route (<LoadoutHost/>, opened from lobby / room / briefing); its loadout is
// kept in sync with the server by installLoadoutSync (room.loadout after every welcome and edit), its 干员持有 tab's
// not-owned list (0.2.0 补位) by installOwnershipSync (room.ownership, likewise), the 自选编队 picks (0.2.0 DIY) by
// installDiySync (room.diy, likewise; it also keeps welcome.diyKitted for the picker).
// Game data: every text of the game is static data (/data/*.json) downloaded once per page; the in-match files are
// warmed in the background as soon as the player is in a room (warmGameData), before the match needs them.
// Language (ui/lang.js, docs/I18N.md): chosen before the first render (initLang); App re-renders on a switch (useLang).
// Server texts are translated on arrival: m.toast / m.ticker frames (msgid + params, or the text as a msgid; a
// config.broadcasts line from its id + args), error codes (ui/toasts.js describeError) and room.closed reasons.
// Cosmetic plugins (DESIGN §32 P1a): installContent (content.js) lays the room's visual set and the player's personal
// plugins over the art manifest every screen reads. Gameplay plugins (§32.6): installContentSet (content.js) downloads and
// checks a room's content set and makes it the data every screen and the battle runner read.

// Polyfills first (older Safari / Firefox ESR): every module evaluated after this one sees them.
import './ui/compat.js';
import { render } from '../vendor/preact.module.js';
import { useErrorBoundary, useEffect, useState } from '../vendor/hooks.module.js';
import { html, UiHosts, Button, Icon, MicroLabel, closeAllDialogs, confirmDialog, alertDialog } from './ui/components.js';
import { ConnectionBanner } from './ui/connBanner.js';
import { ToastHost, toast, toastError, describeError } from './ui/toasts.js';
import { net, identity, NetError } from './net.js';
import { store, useStore, emptyMatch, selectRoute, sessionResetNotice, isSpectating, pushChatMessage } from './store.js';
import { data } from './data.js';
import { GAME_FILES } from './ui/gameComponents.js';
import { TitleScreen, sanitizeName } from './screens/title.js';
import { LobbyScreen, rememberRoom, parseRoomParam } from './screens/lobby.js';
import { RoomScreen, TrustedNotice } from './screens/room.js';
import { GameScreen } from './screens/game.js';
import { installAudio, audio } from './audio.js';
import { settingsStore, updateSettings } from './ui/settings.js';
import { GuideHost } from './ui/guide.js';
import { installDeviceSupport } from './ui/device.js';
import { registerImportedAssetWorker } from './assetCache.js';
import { LoadoutHost } from './screens/loadout.js';
import { StatsHost } from './screens/stats.js';
import { installRehearsal } from './battle/rehearsal.js';
import { recordResult, installStatsRecorder } from './ui/stats.js';
import { installLoadoutSync, installOwnershipSync, installDiySync, installSkinsSync } from './ui/loadoutSync.js';
import { startBuildGuard } from './ui/buildGuard.js';
import { MAX_SEATS } from '../../shared/constants.js';
import { initLang, useLang, tickerText } from './ui/lang.js';
import { t, N_, translateWire } from '../../shared/i18n.js';
import { recordError, installTrafficMeter } from './diag.js';
import { installContent, installContentSet } from './content.js';
import { cosmetics } from './cosmetics.js';

const RESTORE_GRACE_MS = 1500;
const JOIN_DELAY_MS = 350;
const TICKER_KEEP = 20;
const EMOTE_KEEP = MAX_SEATS * 4; // keep several seconds of messages even when every seat sends together

const SCREENS = { title: TitleScreen, lobby: LobbyScreen, room: RoomScreen, game: GameScreen };

/** Copy of a server message without transport fields. */
function payload(msg) {
  const { t, rid, ...rest } = msg; // eslint-disable-line no-unused-vars
  return rest;
}

function clearRoomParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('room')) return;
    url.searchParams.delete('room');
    history.replaceState(history.state, '', url.pathname + (url.search || '') + url.hash);
  } catch { /* ignore */ }
}

// ---- net → store wiring ---------------------------------------------------------------------------

let seq = 0;
let welcomeAt = 0;
let roomStateAt = 0;
let matchAt = 0;
let restoreTimer = null;
let joinTimer = null;
let joinInFlight = false;
/** The rehearsal installer (battle/rehearsal.js): its tasks follow the match on screen (see wireNet's store hook). */
let rehearsal = null;

function clearPendingJoin() {
  store.patch('ui', { pendingJoin: null });
  clearRoomParam();
}

/** Auto-join the deep-linked room once entered + online (idempotent). */
function schedulePendingJoin() {
  clearTimeout(joinTimer);
  joinTimer = setTimeout(async () => {
    const s = store.get();
    const code = s.ui.pendingJoin;
    if (!code || joinInFlight || !s.session.entered || net.status !== 'online') return;
    if (s.room) {
      if (s.room.code !== code) toast(t('你已在其他同盟中，请先离开当前同盟'), 'warn');
      clearPendingJoin();
      return;
    }
    joinInFlight = true;
    try {
      await net.request('room.join', { code });
    } catch (err) {
      toastError(err);
    } finally {
      joinInFlight = false;
      clearPendingJoin();
    }
  }, JOIN_DELAY_MS);
}

/** End the post-resume "syncing" state early once the server re-pushed what we were showing. */
function maybeFinishRestore() {
  const s = store.get();
  if (!s.ui.restoring) return;
  const roomOk = !s.room || roomStateAt >= welcomeAt;
  const matchOk = !s.match.public || matchAt >= welcomeAt || !s.room?.inMatch;
  if (roomOk && matchOk) {
    clearTimeout(restoreTimer);
    store.patch('ui', { restoring: false });
  }
}

/**
 * Leave whatever room / match was on screen for the lobby with nothing stale left behind: open imperative dialogs,
 * the post-resume restore timer, ticker lines and emote bubbles of the old match (the battle runner and the 暂离 flag
 * follow the store themselves).
 */
function backToLobby() {
  identity.rememberMatch(null);
  clearTimeout(restoreTimer);
  const s = store.get();
  if (s.room || s.match.public) closeAllDialogs();
  store.set({ room: null, match: emptyMatch(), ticker: [], emotes: [], chatMessages: [] });
  store.patch('ui', { restoring: false });
}

/** The unofficial plugins a server counts in welcome / /healthz `content.plugins` (absent: none — DESIGN §32 P1a). */
const pluginCount = (content) => (content && Number.isInteger(content.plugins) && content.plugins > 0 ? content.plugins : 0);

function onWelcome(msg) {
  identity.saveToken(msg.token);
  identity.rememberMatch(null);
  const prev = store.get();
  const prevId = prev.me.playerId;
  const name = typeof msg.name === 'string' && msg.name ? msg.name : prev.me.name;
  identity.saveName(name);
  store.set({
    me: { playerId: msg.playerId ?? null, name, token: typeof msg.token === 'string' ? msg.token : null },
    // the server's content identity (DESIGN §32): the diagnostics name it (diag.js contentLine)
    content: msg.content && typeof msg.content.vanilla === 'string' ? { vanilla: msg.content.vanilla } : null,
    // how many unofficial plugins it has (P1a — absent: none; content.js fetches the catalogue only when there are some)
    installedPlugins: pluginCount(msg.content),
  });
  welcomeAt = Date.now();

  if (prevId != null && prevId !== msg.playerId) {
    // A brand-new server session (the server restarted — crashed / killed, so no room.closed arrived — or this session
    // expired on it): whatever we showed before is gone — back to the lobby cleanly and say why.
    const notice = sessionResetNotice(prev, msg.playerId);
    backToLobby();
    if (notice) toast(t(notice), 'warn', { ttl: 7000 });
  } else if (prev.room || prev.match.public) {
    // Resumed session: the server re-pushes room/match state; drop whatever it doesn't.
    store.patch('ui', { restoring: true });
    clearTimeout(restoreTimer);
    restoreTimer = setTimeout(() => {
      const s = store.get();
      const patch = {};
      if (s.room && roomStateAt < welcomeAt) patch.room = null;
      if (s.match.public && matchAt < welcomeAt) patch.match = emptyMatch();
      store.set(patch);
      store.patch('ui', { restoring: false });
    }, RESTORE_GRACE_MS);
  }
  if (msg.serverLoad && typeof msg.serverLoad === 'object') {
    store.set({ serverLoad: msg.serverLoad });
    // Alert or warn players about server load on connection/welcome
    checkServerLoadNotice(msg.serverLoad);
  }
  schedulePendingJoin();
}

let hasShownLoadNotice = false;
async function checkServerLoadNotice(load) {
  if (hasShownLoadNotice || !load || load.status === 'normal') return;
  hasShownLoadNotice = true;

  if (load.status === 'critical') {
    const isPreloaded = (() => {
      try {
        const saved = localStorage.getItem('sp_preloaded_profiles');
        return !!(saved && (JSON.parse(saved).core || JSON.parse(saved).full));
      } catch { return false; }
    })();

    const advice = isPreloaded
      ? t('检测到您已预载核心资源。当前服务器算力负荷极高（CPU ') + (load.cpuPercent || 0) + t('%），对局中可能有轻微同步延迟。')
      : t('检测到您尚未预载资源！在当前服务器高负荷下直接进入游玩极易发生静态素材拉取超时或断线。建议立即前往主页右下角「⚡资源预载」或前往备用服务器。');

    await alertDialog({
      title: t('⚠ 服务器高载荷预警'),
      text: html`<div>
        <p style="margin: 0 0 .12rem 0; line-height: 1.5;">${load.message ? t(load.message) : t('当前服务器在线人数较多，负载已逼近承载上限。')}</p>
        <p style="margin: 0 0 .1rem 0; color: var(--amber); font-size: .13rem;">${advice}</p>
        <div style="font-size: .12rem; color: var(--text-lo); background: rgba(0,0,0,0.25); padding: .08rem; border-radius: 4px;">
          ${t('当前在线:')} <b>${load.onlineCount}</b> ${t('人 · 算力折算点数:')} <b>${load.score} / ${load.maxScore || 150}</b> · CPU: <b>${load.cpuPercent}%</b>
        </div>
      </div>`,
      okText: t('我知道了，继续游玩'),
      tone: 'warn',
    });
  } else if (load.status === 'warning') {
    toast(t('⚠️ 服务器较拥挤（在线 {onlineCount} 人），建议未预载玩家先进行资源预载', { onlineCount: load.onlineCount }), 'warn', { ttl: 8000 });
  }
}

function onRoomState(msg) {
  const room = payload(msg);
  roomStateAt = Date.now();
  const myId = store.get().me.playerId;
  const seats = Array.isArray(room.seats) ? room.seats : [];
  if (myId != null && seats.length && !seats.some((s) => s && s.playerId === myId) && !isSpectating(room, myId)) {
    // We are no longer seated (kicked / left elsewhere) — neither in a player seat nor a spectator seat.
    if (store.get().room) toast(t('你已不在该同盟中'), 'warn');
    store.set({ room: null, match: emptyMatch() });
    return;
  }
  const prevRoom = store.get().room;
  // A (new) match starts: forget the previous match's state so stale results never show.
  if (room.inMatch && !(prevRoom && prevRoom.inMatch && prevRoom.code === room.code)) store.set({ match: emptyMatch() });
  store.set({ room });
  identity.rememberMatch(room.inMatch && seats.some((seat) => seat?.playerId === myId)
    ? { name: store.get().me.name, code: room.code || '' } : null);
  if (room.mode === 'coop' && typeof room.code === 'string') rememberRoom(room.code);
  maybeFinishRestore();
}

const CLOSE_REASON = {
  // 'timeout' = this player was removed after staying disconnected past the lobby grace (server/lobby.js)
  host_left: N_('创建者已离开，同盟已解散'), timeout: N_('由于长时间断开连接，你已离开同盟'), empty: N_('同盟已解散'),
  kicked: N_('你已被移出同盟'), ended: N_('模拟已结束'), expired: N_('同盟已过期'), shutdown: N_('服务器维护中，同盟已关闭'),
};

function wireNet() {
  net.on('status', (snap) => {
    const cur = store.get().connection;
    const isOnline = snap.status === 'online';
    store.set({
      connection: {
        status: snap.status, ping: snap.ping, jitter: snap.jitter, quality: snap.quality, attempt: snap.attempt, retryAt: snap.retryAt,
        lastError: snap.lastError, everOnline: cur.everOnline || isOnline,
      },
    });
    if (!isOnline && store.get().matchmaking?.status === 'searching') {
      store.patch('matchmaking', { status: 'idle', elapsed: 0, matched: 0 });
    }
  });
  net.on('clock', (c) => store.set({ clock: { offset: c.offset, rtt: c.rtt, synced: c.synced } }));
  net.on('welcome', onWelcome);
  net.on('helloError', (err) => {
    if (err.code === 'SESSION_IN_USE') identity.rejectToken();
    toastError(err);
  });
  net.on('replaced', () => toast(t('该身份已在其他页面登录，本页已断开'), 'warn', { ttl: 6000 }));
  net.on('unhandledError', (err) => toastError(err));
  net.on('room.state', onRoomState);
  net.on('room.closed', (msg) => {
    backToLobby();
    const known = Object.hasOwn(CLOSE_REASON, String(msg.reason)) ? CLOSE_REASON[msg.reason] : null;
    toast(known ? t(known) : typeof msg.reason === 'string' && msg.reason.length < 60 ? t('同盟已关闭：{reason}', { reason: msg.reason }) : t('同盟已关闭'), 'warn');
  });
  net.on('match.status', (msg) => {
    store.patch('matchmaking', {
      status: msg.status || 'idle',
      mode: msg.mode || null,
      difficulty: msg.difficulty || null,
      elapsed: typeof msg.elapsed === 'number' ? msg.elapsed : 0,
      matched: typeof msg.matched === 'number' ? msg.matched : 0,
      target: typeof msg.target === 'number' ? msg.target : 4,
    });
  });
  net.on('match.found', (msg) => {
    store.patch('matchmaking', { status: 'found', roomCode: msg.roomCode });
    toast(t('已匹配到同盟小队（{roomCode}）！', { roomCode: msg.roomCode }), 'success', { ttl: 3000 });
  });
  net.on('server.maintenance', (msg) => {
    const active = !!msg.active;
    store.patch('maintenance', {
      active,
      deadline: msg.deadline || 0,
      seconds: msg.seconds || 0,
      reason: msg.reason || '',
    });
    if (active) {
      toast(t('⚠ 服务器将于 {0} 秒后停服维护（{1}）', { 0: msg.seconds || 60, 1: msg.reason ? t(msg.reason) : t('例行维护') }), 'warn', { ttl: 9000 });
    }
  });
  net.on('room.chat', (msg) => {
    pushChatMessage({
      playerId: msg.playerId,
      name: msg.name,
      seat: msg.seat,
      isSpectator: !!msg.isSpectator,
      text: msg.text,
      at: msg.at || Date.now(),
    });
  });
  net.on('lobby.stats', (msg) => {
    store.patch('connection', { onlineCount: typeof msg.online === 'number' ? msg.online : 1 });
    store.set({
      lobbyStats: {
        online: typeof msg.online === 'number' ? msg.online : 1,
        roomsCount: typeof msg.roomsCount === 'number' ? msg.roomsCount : 0,
        matchesCount: typeof msg.matchesCount === 'number' ? msg.matchesCount : 0,
        rooms: Array.isArray(msg.rooms) ? msg.rooms : [],
      },
    });
  });
  net.on('m.public', (msg) => { matchAt = Date.now(); store.patch('match', { public: payload(msg) }); maybeFinishRestore(); });
  net.on('m.private', (msg) => { matchAt = Date.now(); store.patch('match', { private: payload(msg) }); });
  net.on('m.layer', (msg) => {
    const s = store.get();
    if (selectRoute(s) === 'game' && msg.playerId === s.me?.playerId) audio.layerGain(msg.bondId, msg.add);
  });
  net.on('m.field', (msg) => store.patch('match', { field: payload(msg) }));
  net.on('m.result', (msg) => {
    const res = payload(msg);
    store.patch('match', { result: res });
    // 本机统计 (PR #323): every arrival, including the lobby's result replay after a reconnect / reload —
    // replays dedupe by content id inside recordResult (spectator seats' copies build no record at all)
    // (`vs`: the room's cosmetic plugins, recorded — such a match still counts as the original game: ui/stats.js)
    // (`content`: the room's content set when it played gameplay plugins — such a match is unofficial: ui/stats.js)
    recordResult(res, { myId: store.get().me.playerId, roomMode: store.get().room?.mode ?? null, vs: store.get().room?.content?.vs ?? null, content: store.get().room?.content ?? null, now: Date.now() });
  });
  net.on('m.toast', (msg) => {
    const kind = ['info', 'success', 'warn', 'error'].includes(msg.kind) ? msg.kind : 'info';
    // msgid + params (server ≥ 0.2.0) or the text itself as a msgid, in the current language
    toast(translateWire(msg), kind);
  });
  net.on('m.ticker', (msg) => {
    if (typeof msg.text !== 'string') return;
    const text = tickerText(msg);
    // type, player + the round it came in: a BOSS_HIT line is dropped once its boss round is over and superseded by the
    // same player's next one (ui/ticker.js tickerLineLive / tickerSupersedes)
    const type = typeof msg.type === 'string' ? msg.type : null;
    const playerId = typeof msg.playerId === 'string' ? msg.playerId : null;
    // its broadcast priority: the strip plays the highest first (ui/ticker.js enqueueTickerLines)
    const priority = Number.isFinite(msg.priority) ? msg.priority : 0;
    store.set((s) => ({ ticker: [...s.ticker.slice(-(TICKER_KEEP - 1)), { id: ++seq, text, at: Date.now(), type, playerId, round: s.match?.public?.round ?? null, priority }] }));
  });
  net.on('m.emote', (msg) => {
    store.set((s) => ({ emotes: [...s.emotes.slice(-(EMOTE_KEEP - 1)), { seq: ++seq, playerId: msg.playerId, id: msg.id, at: Date.now() }] }));
  });

  // Entering (title → lobby) while already online also needs the deep-link join.
  store.subscribe((s, prev) => {
    if (s.session.entered && !prev.session.entered) schedulePendingJoin();
    // in a room (co-op or solo, also a resumed one) a match is near: its data starts downloading
    if (s.room && !prev.room) warmGameData();
    // the match on screen is over (left, closed, kicked, a new session): a rehearsal task of it is dead, and the frame
    // that cancels it may never arrive (a disposed match sends nothing) — the page stops what it is running itself
    if (selectRoute(prev) === 'game' && selectRoute(s) !== 'game') rehearsal?.clear();
  });
}

/**
 * Download every data file of the match UI (gameComponents GAME_FILES: operators, skills, bonds, items, enemies, 特质 …)
 * in the background once the player is in a room — a match is near (the lobby alone never downloads them). The game's
 * texts are static data loaded once per page — never fetched during a match — and the match screen waits for these
 * files, so with them warmed it opens at once and no text ever appears late (user playtest #3 item 9). Idempotent (the
 * data store shares each file's promise).
 */
function warmGameData() {
  // a room with gameplay plugins: content.js downloads its content set's files instead (DESIGN §32.6)
  const go = () => { if (store.get().room?.content?.vanilla === false) return; data.loadAll(GAME_FILES).catch(() => {}); };
  if (typeof globalThis.requestIdleCallback === 'function') globalThis.requestIdleCallback(go, { timeout: 2500 });
  else setTimeout(go, 600);
}

// ---- UI chrome (the connection banner lives in ui/connBanner.js) -----------------------------------

function ScreenCrashed({ error, reset }) {
  return html`<div class="screen crash">
    <div class="crash__box brackets">
      <${MicroLabel} tone="mint">SYSTEM FAULT<//>
      <h2>${t('界面发生错误')}</h2>
      <p class="t-lo">${String(error?.message || error).slice(0, 200)}</p>
      <${Button} variant="primary" icon="refresh" onClick=${reset}>${t('重新加载界面')}<//>
    </div>
  </div>`;
}

function MaintenanceBanner() {
  const maint = useStore((s) => s.maintenance);
  const [timeLeft, setTimeLeft] = useState(0);

  useEffect(() => {
    if (!maint?.active || !maint.deadline) return undefined;
    const calc = () => Math.max(0, Math.ceil((maint.deadline - Date.now()) / 1000));
    setTimeLeft(calc());
    const t = setInterval(() => {
      const left = calc();
      setTimeLeft(left);
      if (left <= 0) clearInterval(t);
    }, 500);
    return () => clearInterval(t);
  }, [maint?.active, maint?.deadline]);

  if (!maint?.active) return null;

  const mm = String(Math.floor(timeLeft / 60)).padStart(2, '0');
  const ss = String(timeLeft % 60).padStart(2, '0');

  return html`<aside class="maint-banner brackets" role="alert">
    <div class="maint-banner__stripe" aria-hidden="true"></div>
    <div class="maint-banner__content">
      <div class="maint-banner__hazard"><${Icon} name="warn" /></div>
      <div class="maint-banner__text">
        <span class="maint-banner__title">${t('停服维护倒计时')}</span>
        <span class="maint-banner__desc">${maint.reason ? t(maint.reason) : t('服务器即将进行停机维护，请尽快完成当前模拟并保存进度')}</span>
      </div>
      <div class="maint-banner__timer">
        <span class="maint-banner__time num">${mm}:${ss}</span>
        <span class="maint-banner__unit">REMAINING</span>
      </div>
    </div>
  </aside>`;
}

function App() {
  const route = useStore(selectRoute);
  useLang(); // a language switch re-renders the whole tree in place
  const [error, resetError] = useErrorBoundary((err) => console.error('[ui] screen crashed', err));
  const Screen = SCREENS[route] || LobbyScreen;
  return html`<div class="app-root">
    <div class="app-bg" aria-hidden="true"></div>
    <${MaintenanceBanner} />
    ${error ? html`<${ScreenCrashed} error=${error} reset=${resetError} />` : html`<${Screen} key=${route} />`}
    <${TrustedNotice} />
    <${ConnectionBanner} />
    <${ToastHost} />
    <${UiHosts} />
    <${GuideHost} />
    <${LoadoutHost} />
    <${StatsHost} />
  </div>`;
}

// ---- boot -----------------------------------------------------------------------------------------

async function waitForFonts(ms) {
  const fonts = document.fonts;
  if (!fonts || typeof fonts.load !== 'function') return;
  const loads = [
    fonts.load('900 1em "Noto Sans SC"', '卫戍协议盟约'), // i18n-ignore (font sample)
    fonts.load('700 1em "Noto Sans SC"', '开始'), // i18n-ignore (font sample)
    fonts.load('700 1em Bender', '0123456789'),
    fonts.load('700 1em Rajdhani', '0123456789'),
  ].map((p) => p.catch(() => null));
  await Promise.race([Promise.all(loads), new Promise((r) => setTimeout(r, ms))]);
}

function installGlobalErrorHandlers() {
  window.addEventListener('unhandledrejection', (ev) => {
    const err = ev.reason;
    // Media autoplay/abort rejections (audio.play() before a user gesture, interrupted loads) are
    // expected browser behaviour, not app errors: log quietly, never toast.
    if (err && (err.name === 'NotAllowedError' || err.name === 'AbortError')) { console.warn('[app] ignored rejection', err.name); return; }
    console.error('[app] unhandled rejection', err);
    recordError('rejection', err);
    if (err instanceof NetError) toastError(err);
    else toast(t('发生意外错误：{error}', { error: describeError(err) }).slice(0, 120), 'error');
  });
  window.addEventListener('error', (ev) => {
    if (!(ev instanceof ErrorEvent)) return; // resource load errors are not script errors
    console.error('[app] uncaught error', ev.error || ev.message);
    // An uncaught throw after boot leaves nothing on screen (the toast path only covers rejections), and on a device
    // whose WebView surface is broken even a toast would be invisible — so the shell has to hear about it.
    reportClientState({ error: String((ev.error && ev.error.message) || ev.message || 'unknown').slice(0, 200) });
    recordError('error', ev.error || ev.message, ev.error ? null : `${ev.filename || '?'}:${ev.lineno || 0}:${ev.colno || 0}`);
  });
}

/**
 * One line of "what the page can see about itself", handed to the Android shell (AndroidBridge.reportClientState).
 * A WebView that fails to composite shows a black screen the page cannot annotate — the message would be painted on
 * the same broken surface — so the native side keeps this and complains when it never arrives.
 */
function reportClientState(extra = {}) {
  const native = globalThis.AndroidNative;
  if (typeof native?.reportClientState !== 'function') return;
  const gl = (type) => { try { return !!document.createElement('canvas').getContext(type); } catch { return false; } };
  const root = document.querySelector('.app-root');
  const renderedW = root?.clientWidth || 0;
  const renderedH = root?.clientHeight || 0;
  const layoutCollapsed = renderedW === 0 || renderedH === 0;
  try {
    native.reportClientState(JSON.stringify({
      at: Date.now(),
      booted: !!globalThis.__SP__ && !layoutCollapsed,
      layoutCollapsed,
      renderedW,
      renderedH,
      rootChildren: document.getElementById('app')?.childElementCount ?? -1,
      canvases: document.querySelectorAll('canvas').length,
      webgl2: gl('webgl2'), webgl: gl('webgl'),
      dpr: globalThis.devicePixelRatio || 1,
      vw: globalThis.innerWidth || 0, vh: globalThis.innerHeight || 0,
      ua: String(navigator.userAgent).slice(0, 160),
      ...(layoutCollapsed ? { error: `UI layout collapsed (w=${renderedW}, h=${renderedH})` } : {}),
      ...extra,
    }));
  } catch { /* the shell is already on its own timeout path */ }
}

async function boot() {
  installGlobalErrorHandlers();
  // what this page downloads, by category, for the 问题反馈 report's traffic line (diag.js; nothing is sent anywhere)
  installTrafficMeter();
  // touch / hover / fullscreen classes, zoom-gesture blocking, rotation re-layout (ui/device.js, css/devices.css)
  installDeviceSupport();
  // Hashed art a player imported. HTTPS or localhost only; a failure here must not stop boot.
  void registerImportedAssetWorker();
  // A page restored from the back/forward cache has a dead socket and a stale token choice: start over.
  window.addEventListener('pageshow', (ev) => { if (ev.persisted) location.reload(); });
  // Pick this tab's reconnect token (asks other live tabs; ≤150 ms) while fonts load.
  const identityReady = identity.init();

  const urlParams = new URLSearchParams(location.search);
  const pendingJoin = parseRoomParam(location.search);
  const paramName = urlParams.get('name');
  const savedName = sanitizeName(paramName || identity.loadName() || (urlParams.has('entered') ? 'Doctor #9009' : ''));
  const entered = (identity.wasEntered() || urlParams.has('entered')) && !!savedName;
  store.set((s) => ({
    me: { ...s.me, name: savedName },
    session: { entered },
    ui: { ...s.ui, pendingJoin },
  }));

  wireNet();
  installStatsRecorder(store); // follows the match on screen, so a 放弃模拟 can be recorded (ui/stats.js)
  installLoadoutSync({ net });
  installOwnershipSync({ net });
  installDiySync({ net });
  installSkinsSync({ net });
  // the room's cosmetic plugins and the player's own over the art manifest (content.js; nothing is fetched without them)
  installContent({ toast });
  // a room with gameplay plugins: its content set downloaded, checked and shown (content.js — DESIGN §32.6)
  installContentSet({ toast });
  // A bot prep's layout rehearsal the server offers this host's browser (DESIGN §14, SP_BOT_REHEARSAL=host on the
  // server): a same-origin module Worker simulates the candidates off the main thread and answers with its pick; a
  // browser that cannot run one answers `error` and the server rehearses itself. Nothing happens while the server
  // does not delegate. A gameplay-plugin room is never offered (the server keeps that rehearsal).
  rehearsal = installRehearsal({ net });
  net.attachBrowserHooks();
  // Audio: unlock on first gesture, BGM follows the route / match phase (js/audio.js).
  // a cosmetic plugin's sound that will not load falls back like its art (content.js, DESIGN §32 P1a)
  installAudio({ getManifest: () => data.get('assets'), subscribe: store.subscribe, getState: store.get, selectRoute, settings: settingsStore.get(),
    onFailed: (url) => cosmetics.fail(url) });
  // …and the music follows the art: the screen's track again when the cosmetic layers change its URLs
  cosmetics.subscribe(() => audio.refreshBgm());
  data.load('assets').catch(() => {});
  data.load('skins').catch(() => {});
  // Warm the data cache in the background (missing files are tolerated).
  data.loadAll('config').catch(() => {});
  // Optional local-client art manifest (emotes, tutorial pages, official UI sprites; DESIGN §13).
  data.load('local').catch(() => {});
  // 0.2.0 backups (stand-ins, DIY operators, tokens)
  data.load('backups').catch(() => {});

  const connectWhenReady = identityReady.then(() => {
    if (entered) net.setName(savedName);
    else net.connect();
  });
  // the language (and its UI translations) before the first render: no Chinese flash for an English player
  const langReady = initLang().catch((err) => console.warn('[app] language setup failed', err));
  await Promise.all([waitForFonts(1200), connectWhenReady, langReady]);
  const root = document.getElementById('app');
  render(html`<${App} />`, root);

  const splash = document.getElementById('boot');
  if (splash) {
    splash.classList.add('is-done');
    setTimeout(() => splash.remove(), 300);
  }
  globalThis.__SP__ = {
    store, net, data, audio, version: 1, updateSettings, settings: settingsStore,
    onThermalThrottle: (warm) => globalThis.__SP_VIEW__?.setThermalThrottle?.(warm),
  };
  reportClientState();
  // A page keeps the modules it imported at load time for its whole lifetime, so a deploy cannot reach an open tab
  // (ui/buildGuard.js): watch `/healthz.build`. Outside a match the page reloads itself; during a match the guard says
  // so instead (the connection banner offers 刷新页面) and reloads once the match — settlement screen included — is over,
  // so a running game is never thrown away.
  try {
    startBuildGuard({
      inMatch: () => selectRoute(store.get()) === 'game',
      onStale: ({ waiting }) => { if (waiting) store.patch('ui', { buildStale: true }); },
      // the same /healthz names how many plugins the server has: the title screen shows it before any hello
      onHealth: (h) => { const n = pluginCount(h.content); if (n !== store.get().installedPlugins) store.set({ installedPlugins: n }); },
    });
  } catch (err) {
    console.warn('[app] build guard failed to start', err);
  }
}

boot().catch((err) => {
  console.error('[app] boot failed', err);
  const el = document.getElementById('boot-err');
  if (el) el.textContent = t('启动失败，请刷新页面重试');
});
