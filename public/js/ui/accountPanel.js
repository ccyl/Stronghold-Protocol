// public/js/ui/accountPanel.js — 账号面板 (this branch: 内部账号, docs/ACCOUNTS.md)
//
// The title screen's "账号" button opens this. A guest can bind (register) or log into an existing account; a bound
// connection sees its UID, can rename, change the passphrase, sync now or log out. The passphrase is the whole
// credential (it is unique per server), so there is no username field on the login side.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, TextField, MicroLabel } from './components.js';
import { t } from '../../../shared/i18n.js';
import { store, useStore } from '../store.js';
import {
  accountStore, bindAccount, loginAccount, logoutAccount, changePassphrase, renameAccount, pullProfile, pushProfile,
} from './account.js';
import { toast } from './toasts.js';

/** @param {{ open: boolean, onClose: () => void }} props */
export function AccountPanel({ open, onClose }) {
  const acc = useStore((s) => s, Object.is, accountStore);
  const [mode, setMode] = useState('bind');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  // 账号名默认取当前代号：留空会让「绑定账号」变成一次无效请求
  const [name, setName] = useState(() => store.get().me?.name || '');
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);

  // the account's name pre-fills the rename field
  useEffect(() => { if (acc.bound) setName(acc.name || ''); }, [acc.bound, acc.name]);

  const fail = (err) => {
    if (err?.code === 'PASS_TAKEN') return; // the conflict banner below already explains it
    if (err?.code === 'PASS_UNKNOWN') { toast(t('口令不正确'), 'warn'); return; }
    if (err?.code === 'PASS_WEAK') { toast(t('口令不能为空'), 'warn'); return; }
    if (err?.code === 'RATE') { toast(t('操作过于频繁，请稍后再试'), 'warn'); return; }
    // NetError carries the server's text in `message` (msg/detail are the raw frame fields)
    console.warn('[account] request failed', err?.code, err?.serverMsg, err?.detail, err);
    const reason = err?.detail ? `（${err.detail}）` : '';
    toast(String(err?.message || t('操作失败，请重试')) + reason, 'warn');
  };

  const run = async (fn) => {
    if (busy) return;
    setBusy(true);
    try { await fn(); } catch (err) { fail(err); } finally { setBusy(false); }
  };

  const bind = () => run(async () => {
    if (pass !== pass2) { toast(t('两次输入的口令不一致'), 'warn'); return; }
    if (!pass) { toast(t('口令不能为空'), 'warn'); return; }
    const accountName = (name.trim() || acc.name || '').trim();
    await bindAccount(pass, accountName || undefined);
    toast(t('账号已绑定'), 'info');
    setPass(''); setPass2('');
  });

  const login = () => run(async () => {
    if (!pass) { toast(t('请输入口令'), 'warn'); return; }
    await loginAccount(pass);
    setPass('');
    const pulled = await pullProfile({ reload: true }).catch(() => null);
    if (pulled) toast(t('已登录，资料已同步'), 'info');
  });

  const changePass = () => run(async () => {
    if (!oldPass || !newPass) { toast(t('请输入口令'), 'warn'); return; }
    await changePassphrase(oldPass, newPass);
    setOldPass(''); setNewPass('');
    toast(t('口令已修改'), 'info');
  });

  const rename = () => run(async () => {
    if (!name.trim()) return;
    await renameAccount(name.trim());
    toast(t('账号名已修改'), 'info');
  });

  const syncNow = () => run(async () => {
    const pushed = await pushProfile();
    const pulled = await pullProfile({ reload: true }).catch(() => null);
    toast(pushed || pulled ? t('已同步') : t('没有需要同步的改动'), 'info');
  });

  const logout = () => run(async () => {
    await logoutAccount();
    toast(t('已退出登录，资料仍保留在本机'), 'info');
  });

  const conflict = acc.conflict && acc.conflict.uid != null
    ? t('该口令已被 UID {uid} 的用户使用', { uid: acc.conflict.uid })
    : acc.conflict ? t('该口令已被其他账号使用') : null;

  const actions = html`
    <${Button} variant="secondary" icon="close" onClick=${onClose}>${t('关闭')}<//>`;

  return html`<${Modal} open=${open} onClose=${onClose} title=${t('账号')} micro="ACCOUNT // CROSS-DEVICE SYNC" class="acct-dlg" actions=${actions}>
    ${acc.bound ? html`
      <div class="acct-state" data-testid="account-state">
        <span class="acct-state__uid num">UID ${acc.uid}</span>
        <span class="acct-state__name">${acc.name || t('博士')}</span>
        <${MicroLabel}>BOUND<//>
      </div>
      <p class="acct-hint">${t('登录后，这份资料（设置、干员调配、自选编队、持有、换装、战绩）会同步到你的账号，换设备也能接着用。')}</p>
      <div class="acct-row">
        <${TextField} label=${t('账号名')} value=${name} maxLength=${12} onInput=${setName} />
        <${Button} variant="secondary" onClick=${rename} disabled=${busy || !name.trim() || name.trim() === acc.name}>${t('改名')}<//>
      </div>
      <div class="acct-row">
        <${TextField} label=${t('当前口令')} type="password" value=${oldPass} onInput=${setOldPass} />
        <${TextField} label=${t('新口令')} type="password" value=${newPass} onInput=${setNewPass} />
        <${Button} variant="secondary" onClick=${changePass} disabled=${busy || !oldPass || !newPass}>${t('修改口令')}<//>
      </div>
      ${conflict ? html`<p class="acct-conflict" role="alert">${conflict}</p>` : null}
      <div class="acct-actions">
        <${Button} variant="primary" onClick=${syncNow} disabled=${busy}>${t('立即同步')}<//>
        <${Button} variant="ghost" onClick=${logout} disabled=${busy}>${t('退出登录')}<//>
      </div>
    ` : html`
      <p class="acct-hint">${t('不登录也能照常游戏，所有资料保存在这台设备上。绑定账号后会分配一个 UID，之后用口令就能在别的设备上登录。')}</p>
      <div class="acct-tabs" role="tablist">
        <button type="button" class=${`acct-tab${mode === 'bind' ? ' is-on' : ''}`} role="tab" aria-selected=${mode === 'bind'} onClick=${() => setMode('bind')}>${t('绑定账号')}</button>
        <button type="button" class=${`acct-tab${mode === 'login' ? ' is-on' : ''}`} role="tab" aria-selected=${mode === 'login'} onClick=${() => setMode('login')}>${t('登录已有账号')}</button>
      </div>
      ${mode === 'bind' ? html`
        <p class="acct-hint">${t('口令是唯一的登录凭证：只要记住口令就能在任何设备登录。口令不限制强度，但一旦泄露，别人就能登录你的账号。')}</p>
        <${TextField} key="bind-name" label=${t('账号名')} value=${name} maxLength=${12} onInput=${setName} placeholder=${acc.name || ''} />
        <${TextField} key="bind-pass" label=${t('口令')} type="password" value=${pass} onInput=${setPass} />
        <${TextField} key="bind-pass2" label=${t('再输入一次口令')} type="password" value=${pass2} onInput=${setPass2} />
        ${pass && pass2 && pass !== pass2 ? html`<p class="acct-conflict" role="alert">${t('两次输入的口令不一致')}</p>` : null}
        <div class="acct-actions">
          <${Button} variant="primary" onClick=${bind} disabled=${busy || !pass}>${t('绑定账号')}<//>
        </div>
      ` : html`
        <p class="acct-hint">${t('输入你的口令即可登录；这台设备上的资料会和账号里的合并。')}</p>
        <${TextField} key="login-pass" label=${t('口令')} type="password" value=${pass} onInput=${setPass} autoFocus=${true} />
        <div class="acct-actions">
          <${Button} variant="primary" onClick=${login} disabled=${busy || !pass}>${t('登录')}<//>
        </div>
      `}
      ${conflict ? html`<p class="acct-conflict" role="alert">${conflict}</p>` : null}
    `}
  <//>`;
}
