#!/usr/bin/env node
// tools/account-admin.mjs — 账号运维（this branch: 内部账号, docs/ACCOUNTS.md）
//
//   node tools/account-admin.mjs list                      列出账号（UID、名字、创建/最后登录、已同步的键与战绩条数）
//   node tools/account-admin.mjs reset <uid> <新口令>       重置口令（玩家忘了口令；不需要旧口令）
//   node tools/account-admin.mjs remove <uid>               删除账号（该账号的资料与战绩一并删除）
//   node tools/account-admin.mjs export [文件]              把账号库整体导出成 JSON（含哈希与密钥，只用于备份/迁移）
//   node tools/account-admin.mjs path                       打印账号库的位置
//
// 账号库默认在项目根目录的 accounts/（SP_ACCOUNTS_DIR 可改）。里面没有明文口令：口令只以 scrypt 哈希和
// 一个用独立密钥文件派生的 HMAC 查表键存在。这个工具只在服主本人的机器上运行，不要放进客户端包。

import fs from 'node:fs';
import path from 'node:path';
import { AccountStore } from '../server/accounts/store.js';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.SP_ACCOUNTS_DIR || path.join(ROOT, 'accounts');

function usage() {
  console.log(`用法：
  node tools/account-admin.mjs list                 列出账号
  node tools/account-admin.mjs reset <uid> <新口令>  重置口令
  node tools/account-admin.mjs remove <uid>          删除账号
  node tools/account-admin.mjs export [文件]         导出账号库（JSON，含哈希，用于备份）
  node tools/account-admin.mjs path                  打印账号库位置
账号库：${dir}`);
}

const store = new AccountStore({ dir }).init();
const [cmd, a, b] = process.argv.slice(2);

if (!cmd || cmd === 'help' || cmd === '--help') {
  usage();
  process.exit(cmd ? 0 : 1);
}

if (cmd === 'path') {
  console.log(dir);
} else if (cmd === 'list') {
  const rows = store.list();
  if (!rows.length) console.log('还没有账号。');
  for (const r of rows) {
    const created = new Date(r.createdAt).toISOString().slice(0, 10);
    const seen = r.lastSeen ? new Date(r.lastSeen).toISOString().slice(0, 16).replace('T', ' ') : '-';
    console.log(`UID ${r.uid}  ${r.name}  创建 ${created}  最后 ${seen}  版本 ${r.rev}  键 [${r.keys.join(', ') || '无'}]  战绩 ${r.records} 条`);
  }
} else if (cmd === 'reset') {
  const uid = Number(a);
  if (!Number.isInteger(uid) || !b) { usage(); process.exit(1); }
  const r = await store.resetPass({ uid, pass: b });
  if (r.error) { console.error(`重置失败：${r.error}${r.uid ? `（口令与 UID ${r.uid} 重复）` : ''}`); process.exit(1); }
  console.log(`UID ${uid} 的口令已重置（旧会话不受影响，但旧口令立即失效）。`);
} else if (cmd === 'remove') {
  const uid = Number(a);
  if (!Number.isInteger(uid)) { usage(); process.exit(1); }
  const r = store.remove(uid);
  if (r.error) { console.error(`删除失败：${r.error}`); process.exit(1); }
  console.log(`UID ${uid} 已删除。`);
} else if (cmd === 'export') {
  const out = a || path.join(ROOT, `accounts-export-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify(store.db, null, 1));
  console.log(`已导出到 ${out}（含口令哈希与查表键，请妥善保管；配套的 secret 在 ${path.join(dir, 'secret')}）。`);
} else {
  usage();
  process.exit(1);
}
