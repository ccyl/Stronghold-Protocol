# 账号（本分支：内部使用）

本分支在官方仓库之上补了一套**内部使用**的账号系统：目的只有两个 —— **资料跨设备同步**与**战绩跨设备**。
不登录照常玩（游客的一切仍在浏览器里），登录只是增强。规则来自维护者的决定 [D014](development/DECISIONS.md#d014)；
协议与实现见 `shared/accounts.js`、`shared/protocol.js`（`auth.*` / `profile.*`）、`server/accounts/store.js`、
`public/js/ui/account.js`、`public/js/ui/accountPanel.js`。

## 1. 账号是什么

| 字段 | 规则 |
|---|---|
| 用户名 | 显示名，1–12 字符（与游戏内代号同一条规则），可改，不唯一 |
| UID | **4 位数字，1000–9999**，注册时由服务端顺序分配，永不复用 |
| 口令 | **全局唯一的登录凭证**；只存 `scrypt` 哈希，永不存明文；不限制强度（可以为 1 个字符） |

口令唯一 ⇒ **登录只需要口令**：没有用户名输入框，也没有"找回口令"流程（忘了找服主重置，见 §6）。

## 2. 流程

- **游客**：只有代号，所有资料在 `localStorage`（设置、干员调配、自选编队、持有、换装、语言、战绩）。
- **绑定账号**（标题画面右上角的账号按钮 →「绑定账号」）：输入账号名与口令（两次，可不限强度），服务端校验唯一性 →
  分配 UID → 本机资料作为该账号的初始资料**整体上传**。口令已被占用时提示「该口令已被 UID xxxx 的用户使用」。
- **换设备登录**：「登录已有账号」→ 只输口令 → 拉回账号资料，与本机合并（见 §3）。
- **改口令**：账号面板里输入当前口令 + 新口令；新口令同样查重。
- **改名**：账号面板里改显示名，UID 不变。
- **退出登录**：解除绑定，资料**留在本机**，继续以游客身份玩。
- **重连/刷新**：登录状态跟着连接的重连 token 走；刷新页面仍是登录状态（token 在 `sessionStorage`）。

## 3. 同步规则

**同步的键**（`PROFILE_KEYS`）：`settings`、`diy`（自选编队）、`skins`（换装）、`ownership`（持有）、
`loadout`（潜能/练度）、`lang`。
**不同步**：`lobby.*`（上次的房间选项）、`screenFit`、`recentRooms`、`ui-plugins`（这台设备的界面布局）。

- **按键后写胜出**：每条 `{ value, at }`，`at` 是写入时刻（毫秒）；服务器按 `at` 合并，平手时服务器侧胜出。
- **本机三路比较**：`sp.pref.syncMirror` 记住"上次同步时的值"。拉取时，本机值仍等于镜子 → 接受服务器值；
  本机值不同（用户本地改过、还没推）→ 保留本机值并在下一次推送时获胜。推送时只推与镜子不同的键。
- **战绩按记录 id 合并**（`shared/accounts.js mergeStats`）：同一局在两台设备上只算一条；合并结果按 `t` 倒序、
  上限 1000 条。
- **推送时机**：登录后、每 60 秒（`main.js`）以及账号面板的「立即同步」。服务器在每次 `profile.push` 后回推
  合并后的完整资料（`profile.state`），所以一次推送就是一次双向同步。

## 4. 服务端与存储

- 账号库在项目根目录的 `accounts/`（`SP_ACCOUNTS_DIR` 可改）：`accounts.json` + `secret`。两者都**不进 git、
  不进更新包、不进打包**（打包只收版本库跟踪的文件）。
- `accounts.json`：`{ v, nextUid, accounts: { [uid]: { uid, name, key, salt, hash, createdAt, lastSeen, rev, profile } } }`，
  写入是原子的（tmp + rename），并保留一份 `.bak`；文件损坏时自动回退 `.bak`（再不行就改名保留现场、从空库开始）。
- **口令查表键** = `HMAC-SHA256(secret, NFC(口令))`，`secret` 在**单独的 `secret` 文件**（0600）。分开存放的理由：
  口令是唯一凭证，必须有 O(1) 的查找键；如果这个键和账号库放在一起，拿到账号库的人就能用它做快速离线猜测，
  `scrypt` 的代价就白费了。登录时仍会再验一次 `scrypt`（纵深防御）。
- 会话：`token → uid` 只存在内存里（重连 token 本来就随服务器重启失效），所以重启后需要重新输入一次口令。
- 限流：每个连接每分钟最多 10 次口令操作（`allowAttempt`），失败不回显口令。

## 5. 协议

C→S：`auth.bind {pass, name}` · `auth.login {pass}` · `auth.logout` · `auth.pass {oldPass, newPass}` ·
`auth.rename {name}` · `profile.push {keys, stats?}` · `profile.pull`
S→C：`auth.state {bound, uid?, name?}`（hello / bind / login / logout / rename 之后）·
`auth.conflict {operation, uid}`（口令被占用）· `profile.state {rev, keys, stats}`
错误码：`PASS_TAKEN`（detail 是冲突账号的 UID）、`PASS_UNKNOWN`、`PASS_WEAK`、`NOT_BOUND`、`TOO_BIG`。
上限：单键 64 KB、全部键 256 KB、战绩 800 KB / 1000 条（`PROFILE_LIMITS`）。

## 6. 运维

```bash
node tools/account-admin.mjs path                 # 账号库位置
node tools/account-admin.mjs list                 # UID / 名字 / 创建 / 最后登录 / 同步的键 / 战绩条数
node tools/account-admin.mjs reset <uid> <口令>    # 玩家忘了口令时重置（旧会话不受影响，旧口令立即失效）
node tools/account-admin.mjs remove <uid>         # 删除账号（资料与战绩一并删除）
node tools/account-admin.mjs export [文件]        # 导出备份（含哈希与查表键，妥善保管）
```

备份 = `accounts/accounts.json` + `accounts/secret` 两个文件一起拷走；只拷其中一个，账号将无法登录。

## 7. 安全与边界

- 页面经隧道是 https（自签证书，浏览器首次会提示一次），口令在传输中不被明文窃听。
- **口令不限制强度**是本分支的决定：内部使用，方便第一；代价是"1234"这样的口令等于把账号送人。管理员可以在
  自己的服务器上提示朋友用长一点的口令，但系统不会拒绝短口令。
- 一个账号可以同时在多台设备在线：同步不改对局座位，也不影响房间身份。
- 战绩是客户端记录后同步的（服务端不记账），所以"可信度"等同于客户端；需要防篡改的战绩是后续工作。
