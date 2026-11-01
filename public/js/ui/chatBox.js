// public/js/ui/chatBox.js — Multi-player In-game Free Text Chat Component
import { html } from './components.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import { net } from '../net.js';
import { useStore } from '../store.js';
import { seatColorClass, visibleMessage } from './chatLog.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

export function ChatBox({ active: controlledActive, onToggle, showTrigger = controlledActive === undefined }) {
  const messages = useStore((s) => s.chatMessages) || [];
  const [internalActive, setInternalActive] = useState(false);
  const active = controlledActive !== undefined ? controlledActive : internalActive;
  const setActive = onToggle || setInternalActive;
  const [draft, setDraft] = useState('');
  // 「只看队友」：过滤掉观战者消息（观战者=未落座的旁观者），系统公告始终显示。
  const [teamOnly, setTeamOnly] = useState(false);
  // 日志默认显示，最后一条消息之后 12 秒自动淡出（输入中或鼠标停在上方时保持），也可以手动隐藏/显示 ——
  // 之前聊天记录一直挂在左下角、永不消失，挡住棋盘视野。
  const [logShown, setLogShown] = useState(true);
  const hoverRef = useRef(false);
  const hideTimer = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);

  // chatMessages 由 store.js 经 ui/chatLog.js 的 mergeChat 归一化：每条含 seq(可能为 null)、system、isSpectator 等字段。
  const visible = messages.filter((m) => visibleMessage(m, { teamOnly }));

  useEffect(() => {
    if (!visible.length) return undefined;
    setLogShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!hoverRef.current && !active) setLogShown(false);
    }, 12000);
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [visible.length, active]);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [visible.length]);

  // Focus input when activated
  useEffect(() => {
    if (active) {
      setTimeout(() => inputRef.current?.focus(), 40);
    }
  }, [active]);

  // Desktop Enter key trigger & Escape cancel
  useEffect(() => {
    const handleKey = (e) => {
      if (e.key === 'Enter') {
        if (!active) {
          e.preventDefault();
          e.stopPropagation();
          setActive(true);
        }
      } else if (e.key === 'Escape') {
        if (active) {
          setActive(false);
          inputRef.current?.blur();
        }
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [active, setActive]);

  const send = async (e) => {
    e?.preventDefault?.();
    const text = draft.trim();
    if (!text) {
      setActive(false);
      return;
    }
    setDraft('');
    setActive(false);
    try {
      await net.request('room.chat', { text });
    } catch (err) {
      console.warn('[chat] send failed', err);
      if (err?.code === 'RATE' || err?.error === 'RATE') {
        toast(t('发言过于频繁，请稍候'), 'warn');
      } else {
        toast(err?.msg || t('发送失败，请重试'), 'warn');
      }
    }
  };

  return html`
    <div class=${`chat-panel ${active ? 'is-active' : ''}`}>
      ${messages.length ? html`
        <div class="chat-bar__head">
          <button
            type="button"
            class="chat-toggle"
            aria-expanded=${logShown || active ? 'true' : 'false'}
            title=${logShown || active ? t('隐藏聊天记录') : t('显示聊天记录')}
            onClick=${() => setLogShown((v) => !v)}
          >${logShown || active ? t('隐藏') : t('显示')}${!logShown && !active ? html`<span class="chat-toggle__n num">${visible.length}</span>` : null}</button>
          <button
            type="button"
            class="chat-toggle chat-team-toggle"
            aria-pressed=${teamOnly ? 'true' : 'false'}
            title=${t('只看队友')}
            onClick=${() => setTeamOnly((v) => !v)}
          >${t('只看队友')}</button>
        </div>` : null}
      <!-- Tactical Chat Stream (pass-through clicks, expands on hover/active) -->
      <div
        class=${`chat-log ${logShown || active ? '' : 'is-hidden'}`}
        ref=${logRef}
        aria-hidden=${logShown || active ? 'false' : 'true'}
        onMouseEnter=${() => { hoverRef.current = true; setLogShown(true); }}
        onMouseLeave=${() => { hoverRef.current = false; }}
      >
        ${visible.map((m, i) => {
          const key = m.seq != null ? `seq-${m.seq}` : `sys-${m.at || 0}-${i}`;
          if (m.system) {
            return html`
              <div key=${key} class="chat-item chat-item--system">
                <span class="chat-text">📢 ${m.text}</span>
              </div>
            `;
          }
          const seatLabel = m.isSpectator ? t('观战') : `P${(m.seat ?? 0) + 1}`;
          const colorCls = seatColorClass(m.seat, m.isSpectator);
          return html`
            <div key=${key} class="chat-item">
              <span class=${`chat-seat ${colorCls}`}>
                [${seatLabel}] ${m.name || t('博士')}:
              </span>
              <span class="chat-text">${m.text}</span>
            </div>
          `;
        })}
      </div>

      <!-- Input Bar (Active) or Mobile Trigger Button -->
      ${active ? html`
        <form class="chat-form" onSubmit=${send}>
          <input
            ref=${inputRef}
            type="text"
            class="chat-input"
            maxlength="200"
            placeholder=${t('输入对话 (Enter发送, Esc取消)...')}
            value=${draft}
            onInput=${(e) => setDraft(e.target.value)}
            onKeyDown=${(e) => e.stopPropagation()}
            onBlur=${() => {
              // Delay blur to allow send button touch/click
              setTimeout(() => {
                if (!draft) setActive(false);
              }, 180);
            }}
          />
          <button type="submit" class="chat-send-btn">${t('发送')}</button>
        </form>
      ` : (showTrigger ? html`
        <button
          type="button"
          class="chat-trigger-btn"
          onClick=${() => {
            setActive(true);
            setTimeout(() => inputRef.current?.focus(), 30);
          }}
          title=${t('打开对话')}
          aria-label=${t('打开对话')}
        >
          💬
        </button>
      ` : null)}
    </div>
  `;
}
