// 账号系统的文件必须都在版本库里：`.gitignore` 里根目录锚定的 /accounts/ 只忽略运行期账号库，
// 早先写成 accounts/ 时把 server/accounts/ 整目录忽略了，于是打包（只收 git ls-files）少了服务端模块、
// 上线后服务器起不来。这里盯住这类"本地能跑、包里没有"的回归。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const tracked = new Set(execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean));

const FILES = [
  'shared/accounts.js',
  'server/accounts/store.js',
  'server/http/websocket.js',
  'server/lobby.js',
  'public/js/ui/account.js',
  'public/js/ui/accountPanel.js',
  'docs/ACCOUNTS.md',
  'tools/account-admin.mjs',
  'test/accounts/store.test.js',
  'test/accounts/lobby.test.js',
  'test/ui/account-sync.test.js',
];

test('every file of the account system is tracked by git (the packagers only ship tracked files)', () => {
  for (const f of FILES) assert.ok(tracked.has(f), `${f} is not tracked`);
});

test('the runtime account store is ignored at the repository root only', () => {
  const out = execFileSync('git', ['check-ignore', '-v', 'accounts/accounts.json'], { cwd: ROOT, encoding: 'utf8' });
  assert.match(out, /\/accounts\//);
  let hit = null;
  try { hit = execFileSync('git', ['check-ignore', '-v', 'server/accounts/store.js'], { cwd: ROOT, encoding: 'utf8' }); } catch { hit = null; }
  assert.equal(hit, null, 'the server module must not be ignored');
});
