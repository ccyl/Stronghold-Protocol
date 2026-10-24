// 账号面板的分支切换（docs/ACCOUNTS.md §2）：从「绑定账号」切到「登录已有账号」时，登录框必须还能输入。
//
// 回归：两个分支都渲染 TextField，切换时 Preact 复用同一个 <input>，把 maxLength（12 → 无）设成 DOM 的 0，
// 于是登录框一个字符也输不进去。修复是 TextField 只在正整数时输出 maxLength，且各分支用不同的 key。
// 需要 jsdom（可选的开发依赖）：没装就跳过，不阻塞其余测试。

import { test } from 'node:test';
import assert from 'node:assert/strict';

let JSDOM = null;
try { ({ JSDOM } = await import('jsdom')); } catch { /* optional */ }

test('绑定 → 登录 切换后输入框仍可输入（需要 jsdom）', { skip: JSDOM ? false : 'jsdom 未安装' }, async () => {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = {};
  for (const k of ['window', 'document', 'localStorage', 'sessionStorage', 'HTMLElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    saved[k] = globalThis[k];
    const v = k === 'window' ? dom.window : k === 'document' ? dom.window.document : k === 'localStorage' ? dom.window.localStorage : k === 'sessionStorage' ? dom.window.sessionStorage : k === 'HTMLElement' ? dom.window.HTMLElement : k === 'Event' ? dom.window.Event : k === 'MouseEvent' ? dom.window.MouseEvent : k === 'KeyboardEvent' ? dom.window.KeyboardEvent : dom.window.getComputedStyle;
    Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
  try {
    const { render } = await import('../../public/vendor/preact.module.js');
    const { html } = await import('../../public/js/ui/components.js');
    const { AccountPanel } = await import('../../public/js/ui/accountPanel.js');
    render(html`<${AccountPanel} open=${true} onClose=${() => {}} />`, document.getElementById('root'));
    await new Promise((r) => setTimeout(r, 30));
    // 绑定分支：账号名 + 两个口令
    assert.equal(document.querySelectorAll('.acct-dlg input').length, 3);
    // 切到登录分支
    const tabs = [...document.querySelectorAll('.acct-tab')];
    assert.equal(tabs.length, 2);
    tabs[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    const input = document.querySelector('.acct-dlg input');
    assert.ok(input, 'login tab has a passphrase field');
    assert.notEqual(input.maxLength, 0, 'maxLength 0 would block every keystroke');
    input.value = 'secret';
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(document.querySelector('.acct-dlg input').value, 'secret');
    // the login button leaves its disabled state once there is a passphrase
    const loginBtn = [...document.querySelectorAll('.acct-dlg button')].find((b) => b.textContent.trim() === '登录');
    assert.equal(loginBtn.disabled, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  }
});
