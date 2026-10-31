# 账号 v2 方案（提案，未实施）

现状见 [ACCOUNTS.md](ACCOUNTS.md)。本文件只讨论**下一步改什么、为什么**，不改代码；实施时以本文件为设计依据，
合并后把结论并入 ACCOUNTS.md 与 `docs/development/DECISIONS.md`（新增一条决策，接在 D014 之后）。

## 1. 现状与四个缺口

| 已有 | 缺口 |
|---|---|
| 口令即身份（全局唯一，HMAC 查表 + scrypt 校验） | 1. **忘记口令 = 账号永久丢失**，只能找服主 `reset-pass` |
| 资料：手动上传 / 下载，整体替换 | 2. 上传/下载**不知道账号里是否更新过**，容易覆盖错，也没有回滚 |
| 战绩：追加流（per-account `seq`、按记录 id 幂等、`stats.since` 补齐） | 3. 会话**只在内存**，重启后所有人重新输口令；看不到有哪些设备登录过 |
| 账号文件原子写 + `.bak`、版本号 `v:1` | 4. 哈希参数写死在代码里，未来换算法无法平滑迁移 |

另外，隧道是公开地址，任何人拿到地址都能绑号（当前无邀请限制）。

## 2. 目标与非目标

**目标**：找回能力、覆盖保护、会话可恢复、哈希可演进；全部零外部依赖（不引入数据库、不发邮件、不加第三方登录）。

**非目标**：Passkey/WebAuthn、OAuth、邮箱/短信找回、JWT、自动合并资料（已证明对设置类数据是负资产）。

## 3. 设计

### 3.1 邀请码（注册准入）

- 数据：`db.invites = [{ code: "<sha256>", createdAt, usedBy: uid|null, usedAt: null|ms }]`。
- 新协议：`auth.bind { pass, name?, invite }`；服务端校验 `invite`（未用过的哈希）。
  错误：`INVITE_BAD`（无效/已用）、`INVITE_REQUIRED`（本服开启了邀请制却没给）。
- 开关：环境变量 `SP_ACCOUNTS_OPEN=1` 关闭邀请制（默认开启）；`SP_ACCOUNTS_INVITE` 不参与。
- 管理：`node tools/account-admin.mjs invite --count 5` 生成并打印一次性邀请码（只在终端显示，库里存哈希）。
- 客户端：绑定页多一个「邀请码」输入框；URL `?invite=XXXX` 或 `sp_invite` 自动带入。

### 3.2 恢复码（找回通道）

- 绑定成功或主动重新生成时，生成 10 个恢复码（格式 `XXXX-XXXX-XXXX`，去掉易混字符），库里只存 scrypt 哈希：
  `account.recovery = [{ hash: "<phc>", usedAt: null|ms }]`。
- 新协议：
  - `auth.recoveryNew { pass }` → 校验口令后重新生成 10 个，S2C `auth.recovery { codes, remaining }`；
    **只在这一次响应里出现明文**，客户端要求用户保存（复制/下载 txt/勾选已保存）。
  - `auth.recover { code, newPass }` → 命中未使用的恢复码：改口令、标记该码已用、**注销该账号全部会话**；
    错误 `RECOVERY_BAD`、`PASS_WEAK`。
- 面板显示剩余恢复码数量；剩 ≤3 个时提醒重新生成。

### 3.3 资料版本历史 + 乐观并发

- 数据结构：
  ```
  profile: {
    rev: 7, at: 1730000000000, keys: {...},
    history: [ { rev: 6, at: ..., keys: {...} }, … ]   // 最近 5 份，身体在替换时压入
  }
  ```
- 上传改为条件写：`profile.push { keys, baseRev }`
  - `baseRev === profile.rev` → 接受，`rev++`，旧值进 `history`；
  - 否则返回错误 `PROFILE_CONFLICT`（detail 带服务端当前 `rev` 与 `at`），客户端弹「账号里已有更新的资料（{at}），
    [仍然覆盖] / [先下载看看]」，选择覆盖时带最新 `baseRev` 重发。
- 新协议：`profile.history {}` → S2C `profile.history { rev, entries: [{ rev, at, keys: 6 类键的数量 }] }`；
  `profile.restore { rev }` → 把该快照作为新 rev 生效（也压入 history），S2C `profile.state`。
- 界面：资料区加「版本历史」按钮 → 列表（时间 + 每类键数量）+「恢复到这一版」。

### 3.4 会话落盘 + 设备管理

- 新文件 `accounts/sessions.json`（0600）：`[{ token, uid, createdAt, lastSeenAt, ip, ua }]`，登录/绑定/注销/踢出时写盘，
  30 天 TTL，每次启动加载；`_save` 失败只降级为内存会话（记录日志，不挡登录）。
- token 继续用现有 reconnect token（`net.js` 已有一条），登录成功后 `bindSession` 落盘。
- 新协议：`auth.devices {}` → S2C `auth.devices { devices: [{ id, createdAt, lastSeenAt, ip, ua, current }] }`；
  `auth.revoke { id }` → 删除该 token（当前设备除外，或允许全踢后要求重登）。
- `auth.state` 增加 `devices: n`（数量），面板显示「已登录设备 n 台」。
- 客户端：面板加「登录设备」列表（时间/IP/UA 粗判 + 当前标记），支持「退出其他设备」。

### 3.5 口令哈希（PHC 字符串，为后续演进留门）

- 旧字段 `{ key, salt, hash }` → 新字段 `pass: "scrypt$N=16384,r=8,p=1$<salt b64>$<hash b64>"`；`key` 保留（查表索引）。
- 读取：无前缀的旧记录按旧参数验，验过后**顺手升级**为 PHC；`v:2` 迁移时也批量升级。
- 目的：以后换 argon2id 或调 N 只需加前缀分支，不动账号数据。

## 4. 协议变更一览

| 方向 | 新增/变更 | 说明 |
|---|---|---|
| C2S | `auth.bind { pass, name?, invite }` | 增加 `invite` |
| C2S | `auth.recoveryNew { pass }` / `auth.recover { code, newPass }` | 恢复码 |
| C2S | `profile.push { keys, baseRev }` | 条件写 |
| C2S | `profile.history {}` / `profile.restore { rev }` | 版本历史 |
| C2S | `auth.devices {}` / `auth.revoke { id }` | 设备管理 |
| S2C | `auth.recovery { codes, remaining }` / `auth.devices { devices }` / `profile.history { entries }` | 三个新推送 |
| 错误码 | `INVITE_BAD`、`INVITE_REQUIRED`、`PROFILE_CONFLICT`、`RECOVERY_BAD`、`DEVICE_UNKNOWN` | 均加进 `ERR_TEXT` |

## 5. 迁移（`v:1` → `v:2`）

1. `db.v = 2`；补 `invites: []`、每账号 `recovery: []`、`profile.history: []`；
2. 每账号 `{key,salt,hash}` → `pass`（PHC）；保留 `key`；
3. 首次启动若启用邀请制且 `invites` 为空，**不阻塞**（管理员用 CLI 生成；客户端提示「请向服主索取邀请码」）；
4. `accounts.json.bak` 仍是兜底；迁移只在加载时做一次并立即写盘。

## 6. 测试计划

- store 单测：邀请码（用/重用/未开邀请）、恢复码（命中/已用/错误码/生成次数）、条件写（rev 匹配/冲突/连续覆盖）、
  历史（压入上限 5、restore 生成新 rev）、会话（落盘、重启后可识别、revoke、TTL 过期）、PHC（旧格式验过升级）；
- e2e（`test/accounts/lobby.test.js`）：一套完整流程——邀请码绑定 → 拿恢复码 → 换设备登录 → 冲突上传 → 恢复码改口令 →
  旧口令失效 → 设备列表踢出；
- 客户端：冲突弹窗二选一、恢复码弹窗必须勾选已保存、历史列表渲染。

## 7. 实施顺序与工作量

| 阶段 | 内容 | 预估 | 需要停机 |
|---|---|---|---|
| P0 | 邀请码 + 恢复码 + `INVITE_*`/`RECOVERY_BAD` + 面板 | 1 天 | 是（重启一次，内存房间会丢） |
| P1 | 条件写冲突提示 + 版本历史 + restore | 1 天 | 是 |
| P2 | 会话落盘 + 设备列表 + PHC 迁移 | 1–1.5 天 | 是（改账号文件结构） |

P0/P1 不动战斗与协议主干，只动 `server/accounts/*`、`shared/accounts.js`、`public/js/ui/account*.js` 与文档。

## 8. 不采用的方案（记录理由）

| 方案 | 理由 |
|---|---|
| Passkey / WebAuthn | 设备绑定 + 必须可信 HTTPS；隧道是自签名证书，换设备即丢 |
| OAuth（Gitee/GitHub/QQ） | 目标人群没有统一账号，且多一层回调与网络依赖 |
| 邮箱/短信找回 | 需要发信通道与反滥用；恢复码是零依赖等价物 |
| JWT 无状态会话 | 单进程私服，落盘 session 更简单且能随时踢人 |
| 资料自动合并 / CRDT | 设置类数据已证明手动更可靠（见 D014 后的两次修复） |
