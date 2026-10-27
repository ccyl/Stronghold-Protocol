// public/js/ui/accountPanel.js — 账号面板 (this branch: 内部账号, docs/ACCOUNTS.md)
//
// The stats screen's 个人界面: a guest binds or logs into an existing account; a bound connection manages the two
// kinds of account data with the models they deserve (docs/ACCOUNTS.md §3):
//   * 资料 (干员调配 / 自选编队 / 持有 / 换装 / 设置) — manual 上传 / 下载, each behind a confirmation dialog;
//   * 战绩 — appended per match automatically, filled in on login (and by the panel's 补齐 button).
// The passphrase is the whole credential (it is unique per server), so there is no username on the login side.

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button, TextField, MicroLabel, confirmDialog } from './components.js';
import { t } from '../../../shared/i18n.js';
import { store, useStore } from '../store.js';
import {
  accountStore, bindAccount, loginAccount, logoutAccount, changePassphrase, renameAccount,
  uploadProfile, downloadProfile, syncStats,
} from './account.js';
import { loadStats } from './stats.js';
import { toast } from './toasts.js';

/** A short local time for a stamp (ms epoch); '' when unknown. */
const stamp = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** @param {{ open: boolean, onClose: () => void }} props */
export function AccountPanel({ open, onClose }) {
  const acc = useStore((s) => s, Object.is, accountStore);
  const [mode, setMode] = useState('bind');
  const [pass, setPass] = useState('');
  const [pass2, setPass2] = useState('');
  const [name, setName] = useState('');
  const [oldPass, setOldPass] = useState('');
  const [newPass, setNewPass] = useState('');
  const [busy, setBusy] = useState(false);
  const [localCount, setLocalCount] = useState(0);

  useEffect(() => {
    if (acc.bound) setName(acc.name || '');
  }, [acc.bound, acc.name]);
  useEffect(() => {
    if (open) { const s = loadStats(); setLocalCount(Array.isArray(s?.records) ? s.records.length : 0); }
  }, [open, acc.statsSeq]);

  const fail = (err) => {
    if (err?.code === 'PASS_TAKEN') return; // the conflict banner below already explains it
    if (err?.code === 'PASS_UNKNOWN') { toast(t('口令不正确'), 'warn'); return; }
    if (err?.code === 'PASS_WEAK') { toast(t('口令不能为空'), 'warn'); return; }
    if (err?.code === 'RATE') { toast(t('操作过于频繁，请稍后再试'), 'warn'); return; }
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
    let n = 0;
    try { n = await syncStats(); } catch { /* 战绩补齐失败不影响登录 */ }
    toast(n ? t('已登录，并补齐 {n} 局战绩', { n }) : t('已登录'), 'info');
    if (n) setLocalCount((c) => c + n);
  });

  const upload = () => run(async () => {
    const ok = await confirmDialog({
      title: t('上传到账号'),
      text: t('用本机的资料（干员调配、自选编队、持有、换装、设置）覆盖账号里的资料？'),
      okText: t('上传'),
    });
    if (!ok) return;
    await uploadProfile();
    toast(t('已上传到账号'), 'info');
  });

  const download = () => run(async () => {
    const ok = await confirmDialog({
      title: t('从账号下载'),
      text: t('用账号里的资料覆盖本机？下载完成后页面会刷新一次。'),
      okText: t('下载'),
    });
    if (!ok) return;
    await downloadProfile();
    toast(t('正在下载，页面即将刷新'), 'info');
  });

  const pullStats = () => run(async () => {
    const n = await syncStats();
    toast(n ? t('已从账号补齐 {n} 局战绩', { n }) : t('战绩已是最新'), 'info');
    setLocalCount((c) => c + n);
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

  const logout = () => run(async () => {
    await logoutAccount();
    toast(t('已退出登录，资料仍保留在本机'), 'info');
  });

  const conflict = acc.conflict && acc.conflict.uid != null
    ? t('该口令已被 UID {uid} 的用户使用', { uid: acc.conflict.uid })
    : acc.conflict ? t('该口令已被其他账号使用') : null;

  const actions = html`<${Button} variant="secondary" icon="close" onClick=${onClose}>${t('关闭')}<//>`;

  return html`<${Modal} open=${open} onClose=${onClose} title=${t('账号')} micro="ACCOUNT // SYNC" class="acct-dlg" actions=${actions}>
    ${acc.bound ? html`
      <div class="acct-state" data-testid="account-state">
        <span class="acct-state__uid num">UID ${acc.uid}</span>
        <span class="acct-state__name">${acc.name || t('博士')}</span>
        <${MicroLabel}>BOUND<//>
      </div>

      <div class="acct-block">
        <h4 class="acct-block__h">${t('干员调配等资料')}${acc.profileAt ? html`<small>${t('账号资料：{at}', { at: stamp(acc.profileAt) })}</small>` : html`<small>${t('账号里还没有资料')}</small>`}</h4>
        <p class="acct-hint">${t('资料不会自动同步：由你选择用哪一边覆盖哪一边。')}</p>
        <div class="acct-actions">
          <${Button} variant="primary" icon="check" onClick=${upload} disabled=${busy}>${t('上传到账号')}<//>
          <${Button} variant="secondary" icon="chevrons" onClick=${download} disabled=${busy}>${t('从账号下载')}<//>
        </div>
      </div>

      <div class="acct-block">
        <h4 class="acct-block__h">${t('战绩')}<small>${t('账号 {n} 局 · 本机 {m} 局', { n: acc.statsSeq, m: localCount })}</small></h4>
        <p class="acct-hint">${t('每局结束自动追加到账号；换设备登录时自动补齐。')}</p>
        <div class="acct-actions">
          <${Button} variant="secondary" onClick=${pullStats} disabled=${busy || !acc.bound}>${t('从账号补齐战绩')}<//>
        </div>
      </div>

      <div class="acct-row">
        <${TextField} key="rename" label=${t('账号名')} value=${name} maxLength=${12} onInput=${setName} />
        <${Button} variant="secondary" onClick=${rename} disabled=${busy || !name.trim() || name.trim() === acc.name}>${t('改名')}<//>
      </div>
      <div class="acct-row">
        <${TextField} key="old-pass" label=${t('当前口令')} type="password" value=${oldPass} onInput=${setOldPass} />
        <${TextField} key="new-pass" label=${t('新口令')} type="password" value=${newPass} onInput=${setNewPass} />
        <${Button} variant="secondary" onClick=${changePass} disabled=${busy || !oldPass || !newPass}>${t('修改口令')}<//>
      </div>
      ${conflict ? html`<p class="acct-conflict" role="alert">${conflict}</p>` : null}
      <div class="acct-actions">
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
        <${TextField} key="bind-name" label=${t('账号名')} value=${name} maxLength=${12} onInput=${setName} placeholder=${store.get().me?.name || ''} />
        <${TextField} key="bind-pass" label=${t('口令')} type="password" value=${pass} onInput=${setPass} />
        <${TextField} key="bind-pass2" label=${t('再输入一次口令')} type="password" value=${pass2} onInput=${setPass2} />
        ${pass && pass2 && pass !== pass2 ? html`<p class="acct-conflict" role="alert">${t('两次输入的口令不一致')}</p>` : null}
        <div class="acct-actions">
          <${Button} variant="primary" onClick=${bind} disabled=${busy || !pass}>${t('绑定账号')}<//>
        </div>
      ` : html`
        <p class="acct-hint">${t('输入你的口令即可登录；账号里的战绩会自动补齐，资料由你在登录后选择下载。')}</p>
        <${TextField} key="login-pass" label=${t('口令')} type="password" value=${pass} onInput=${setPass} autoFocus=${true} />
        <div class="acct-actions">
          <${Button} variant="primary" onClick=${login} disabled=${busy || !pass}>${t('登录')}<//>
        </div>
      `}
      ${conflict ? html`<p class="acct-conflict" role="alert">${conflict}</p>` : null}
    `}
  <//>`;
}
