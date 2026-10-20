// public/js/ui/chatBox.js — Multi-player In-game Free Text Chat Component
import { html } from './components.js';
import { useState, useEffect, useRef } from '../../vendor/hooks.module.js';
import { net } from '../net.js';
import { useStore, store, pushChatMessage } from '../store.js';
import { toast } from './toasts.js';
import { t } from '../../../shared/i18n.js';

export function ChatBox({ active: controlledActive, onToggle, showTrigger = controlledActive === undefined }) {
  const messages = useStore((s) => s.chatMessages) || [];
  const [internalActive, setInternalActive] = useState(false);
  const active = controlledActive !== undefined ? controlledActive : internalActive;
  const setActive = onToggle || setInternalActive;
  const [draft, setDraft] = useState('');
  // 日志默认显示，最后一条消息之后 12 秒自动淡出（输入中或鼠标停在上方时保持），也可以手动隐藏/显示 ——
  // 之前聊天记录一直挂在左下角、永不消失，挡住棋盘视野。
  const [logShown, setLogShown] = useState(true);
  const hoverRef = useRef(false);
  const hideTimer = useRef(null);
  const inputRef = useRef(null);
  const logRef = useRef(null);

  useEffect(() => {
    if (!messages.length) return undefined;
    setLogShown(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => {
      if (!hoverRef.current && !active) setLogShown(false);
    }, 12000);
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [messages.length, active]);

  // Auto-scroll to bottom on new message
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [messages.length]);

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
      } else if (!net.connected || !store.get().session?.entered) {
        // 离线/单机调试模式回退
        pushChatMessage({
          playerId: store.get().session?.playerId || 'me',
          name: store.get().session?.name || t('博士'),
          seat: 0,
          isSpectator: false,
          text,
          at: Date.now(),
        });
      } else {
        toast(err?.msg || t('发送失败，请重试'), 'warn');
      }
    }
  };

  const getSeatColorClass = (seat, isSpectator) => {
    if (isSpectator) return 'seat-spec';
    switch (seat) {
      case 0: return 'seat-0';
      case 1: return 'seat-1';
      case 2: return 'seat-2';
      case 3: return 'seat-3';
      default: return '';
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
          >${logShown || active ? t('隐藏') : t('显示')}${!logShown && !active ? html`<span class="chat-toggle__n num">${messages.length}</span>` : null}</button>
        </div>` : null}
      <!-- Tactical Chat Stream (pass-through clicks, expands on hover/active) -->
      <div
        class=${`chat-log ${logShown || active ? '' : 'is-hidden'}`}
        ref=${logRef}
        aria-hidden=${logShown || active ? 'false' : 'true'}
        onMouseEnter=${() => { hoverRef.current = true; setLogShown(true); }}
        onMouseLeave=${() => { hoverRef.current = false; }}
      >
        ${messages.map((m, i) => {
          const seatLabel = m.isSpectator ? t('观战') : `P${(m.seat ?? 0) + 1}`;
          const colorCls = getSeatColorClass(m.seat, m.isSpectator);
          return html`
            <div key=${i} class="chat-item">
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
            maxlength="80"
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
