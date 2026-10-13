# 交付说明 · 0.2.6-fusion-20p（20 人房间 + 官方 v0.2.6 + 一键更新）

> 上一版交付记录：见 [`DELIVERY-0.2.5.md`](DELIVERY-0.2.5.md)；0.2.4 及更早见各 Release tag 中的同名文件

## 这是什么

在 **0.2.1-fusion-20p**（Paper-Yuan fusion + LongQianChen 20 人房间）之上，先后合并了
**官方 v0.2.3**（含 v0.2.2）、**官方 v0.2.4**、**官方 v0.2.5**，以及本次的**官方 v0.2.6**。

- 分支 / 提交：`fusion-20p`，HEAD `cdaf7e77`（合并提交 `065b154c`，基线官方 `488db49f` = `v0.2.6`）
- 版本号：`0.2.6-fusion-20p`（`package.json` / `package-lock.json` / `shared/constants.js APP_VERSION` 三处一致）
- Git tag：`v0.2.6-fusion-20p` → `cdaf7e77`（annotated）
- 工作目录：`/home/ccyl/stronghold/fusion-20p`（源码）· `/home/ccyl/stronghold/server`（生产）
- 端口：**3000 = 生产**（本次已升级到 0.2.6）· **3010 = 测试**（未动，仍 0.2.5）

## 交付物

**GitHub Release：<https://github.com/ccyl/Stronghold-Protocol/releases/tag/v0.2.6-fusion-20p>**

| 资产 | 大小 | SHA-256 |
|---|---|---|
| `stronghold-0.2.6-fusion-20p-client-win-x64.zip` | 655 MB | `0d53c700ba9b7f7970ec5172a1d55b88e2c9240479beb849a507123567418e4f` |
| `stronghold-0.2.6-fusion-20p-update.zip`（玩家增量） | 0.6 MB | `815c6d015ed919159de38a1f55ad0e6625a89b28a66b281e324b6aa9134c83d1` |
| `stronghold-0.2.6-fusion-20p-server.zip` | 20.2 MB | `d9c710d878256aab79481a35ac84395e66bf902946edf30c39cd83bd9feec56d` |
| `stronghold-0.2.6-fusion-20p-server-update.zip`（服务端增量） | 2.3 MB | `633d51902ffca08581cad8492baecf4d2611d656a50f609e3e471f86f4ca1732` |

本机留档：`/home/ccyl/stronghold/release/0.2.6-fusion-20p/`（含 `更新源-客户端渠道/` 与两份说明文档）。

### 客户端包（Windows 薄壳版，本版新的交付形态）

```
Stronghold-Protocol-Windows\
├─ app\          游戏本体 0.2.6-fusion-20p：869 MB 素材 + 11 个战场场景 + tools\update.mjs + 生产 node_modules
├─ node\         便携 Node v22.23.3（Windows x64）
├─ sp-thin-shell\  启动器：StrongholdShell.exe（76 KB，x64）+ 3 个 WebView2 DLL + shell.json + 源码
├─ update-pubkey.d\update-pubkey.pem   更新源信任根（公钥，必须在 app\ 之外）
└─ LICENSE / NOTICE.md / THIRD-PARTY-NOTICES.md / 组装说明-0.2.6.md
```

- **解压即用**：双击 `sp-thin-shell\StrongholdShell.exe`，菜单里可填服务器、检查更新、开本机服
- 与 0.2.5 的 `-full.zip`（扁平游戏目录）不同：本版按**薄壳版客户端**分层（`app\` 可被更新单独替换）
- 启动器 exe 已编译好放入包内；只有改了 `Shell.cs` 才需要重编（见包内组装说明）

## 上线（3000 生产）

2026-10-13 13:09 UTC 完成，**停机约 3 秒**：

1. `kill`（SIGTERM）旧进程 → 端口 1 秒释放
2. `unzip -o stronghold-0.2.6-fusion-20p-update.zip -d /home/ccyl/stronghold/server`
3. 更新源放入 `server/updates/`
4. 用原命令原样启动（`ADMIN_SECRET=… PORT=3000 HOST=0.0.0.0 nohup node server/index.js`）

启动日志：**「已更新到 v0.2.6-fusion-20p：1860 个文件校验通过，删除 0 个旧文件」**；
`/healthz` → `app: 0.2.6-fusion-20p, build: fbf20f300dba`；重启前在线的 8 名玩家浏览器自动重连。

- 部署脚本：`/home/ccyl/stronghold/deploy-0.2.6.sh`（`ADMIN_SECRET` 已脱敏为占位符）
- **回滚**：`/home/ccyl/stronghold/rollback-0.2.5-fusion-20p/`（167 个被覆盖文件原件 + `_NEW_FILES.txt`
  列出 72 个新增文件）。回滚 = 停服 → 把该目录覆盖回 `server/` → 删掉 `_NEW_FILES.txt` 里的文件 → 启动。

## 本次合并（官方 v0.2.6）

基线 `cf7a9400`（0.2.5）→ `488db49f`（v0.2.6），**58 提交 / 93 文件（+5750 −254）**。
实际产生冲突的是 **17 个文件**（其余含文档在内都自动合并）。

### 冲突处理（原则：保留本分支特色 + 融入上游新功能）

| 文件 | 处理 |
|---|---|
| `shared/constants.js` / `package.json` / `package-lock.json` / README 徽章 | 版本号 → `0.2.6-fusion-20p`（沿用 `-fusion-20p` 后缀惯例） |
| `server/http/routes.js` / `server/index.js` | **三者并存**：本分支 `update`(更新源) + `admin`(管理端) + 上游 `trustProxy` / `traffic` / `assetIndex` / `views` |
| `server/http/files.js` | 并入上游 brotli + 内容哈希常量；**保留本分支「vendor 不长缓存」**（`327cb98a` 的有意修复） |
| `public/js/render/app.js` | 并入上游 BatchRenderer(impostor #542) 修复；**保留本分支 Android WebView 的 try/catch 回退**；`announceDeploy`（本分支：放置语音 + 部署音效）与 `landPiece`（上游 PR #416 落地动画）并存，且**避免重复调用 `onDeploy`** |
| `public/js/ui/gameLogic/settings.js` / `ui/settings.js` / `render/app.js` 默认值 | 保留本分支 `voiceLang:'jp'` / `board` / `highRefresh`，并入上游 `ammoCount` |
| `public/js/ui/fieldHost.js` | OPTIONAL 数组取并集（`setThermalThrottle` + `replayDeploys`） |
| `public/js/screens/bandDraft.js` | **保留本分支手动优先** `hasManualTeammateAfter`；上游 `c9197947` 只是「最后一个不能跳过」的修复，本分支判定更严、已覆盖该场景 |
| `server/match/match/phases.js` | 跳过被拒时**区分两种理由**：「后面没人」→ `nobody to pass to`（对齐官方 #546 测试）；「后面只有非手动玩家」→ 保留本分支文案 |
| `docs/DESIGN.md` / `docs/ASSETS.md` / `README.md` | 本分支专属段落（Capacity 分支说明、Known gaps、Android 段、手机要求行）与上游 0.2.6 段落**两者都保留** |
| 3 个测试文件 | 适配本分支差异（`gd.ready` 依赖、`highRefresh` 默认、`setThermalThrottle` 可选方法）的断言 |

### 合并后追加提交

| 提交 | 内容 |
|---|---|
| `957ee600` | `fix: 重新同步 public/ 静态镜像（合并 v0.2.6 后已陈旧）` —— 沿用本分支惯例，新增 `assetPaths.js`、更新 `media.js` / `op-wisdel.js` |
| `3a4292f0` | `fix(match): 跳过被拒区分「后面没人」与「后面没有手动玩家」` |
| `cdaf7e77` | `test: 适配 v0.2.6 新测试对本分支 gd.ready / highRefresh / setThermalThrottle 断言的差异` |

## 本分支新增：服务端自带更新源 + 客户端一键更新

- 服务端 `/update/` 端点族（`server/http/update.js` + `server/updateSet.js`）：`latest.json`（**ed25519 签名**）、
  `MANIFEST.json`（受管文件 size+sha256）、`<name>.zip`（支持 Range 续传）、`file?path=`（逐文件同步）
- 发布侧：`tools/make-update.mjs --to <新树> --from <旧树> --out <目录> --url-base <地址> --key <私钥>`
- 客户端：启动器「检查更新」或 `node tools/update.mjs check|apply --root app --source <服务器>`
  —— **更新只替换 `app\`，启动器与 Node 不用重打包**
- **本版更新源按「客户端渠道」发布**（`--to` = 客户端 `app\`，`--from` = 0.2.5 客户端完整包）：
  受管 **971** 文件、更新包 **655 KB**、digest `35816e7041e922f1ad55fe2e7747e437f618e1f54c5148fe5dc4d9c69b44641e`
- **端到端验证**：客户端 `app\` 对着 `http://127.0.0.1:3000` 自检 → **「结论：已是最新」**（签名通过）
- 旧的「服务端全树渠道」更新源已归档到 `/home/ccyl/stronghold/.feed-server-old/`

### 签名密钥

- 公钥：`/home/ccyl/stronghold/keys/update-pubkey.pem`（指纹 **`6a1f4a7c2ee9ff87`**），随客户端包分发在 `update-pubkey.d\`
- **私钥：`/home/ccyl/stronghold/keys/release-private.pem`** —— 只留在发布机，**务必备份、切勿外传或进仓库**
- `tools/update.mjs` **刻意不读安装目录内的公钥**（那份会被更新覆盖，等于让更新源自己给自己发通行证）

## 打包审计与精简（客户端）

- ✅ **无敏感 / 垃圾文件**：无密钥、无 `.env`、无日志 / 缓存 / `.pyc`、无 `MANIFEST.json` / `UPDATE.json` 元文件、
  无 `.git`、无 `shell-state.json`；`app\` 内 0 个仓库外文件。历史包里的 `tools/local-extract/__pycache__/*.pyc` 已排除。
- ✅ **补回缺失**：`data/local-assets.json`（1574 个本地提取素材的清单，缺了客户端用不上本地模型）
- ✅ **补回缺失**：`app\` 内置**生产依赖 `node_modules`**（33 项 / 81 MB）—— 启动器只跑 `node server/index.js`、
  **不会**装依赖，历史 `-full.zip` 不含它（靠玩家自己 `npm ci`），薄壳版必须内置
- ✅ **清理 47 个未列入清单的素材 / 26.8 MB**：12 个陈旧远端素材（如 `skchr_huang_1.png` —— 清单里该键映射的
  已是 `skchr_huang_2.png`）+ 35 个未用的场景 PNG 光照图（客户端读 `.webp`）
  **例外：保留 `public/assets/local/map/autochess/tiles.json`** —— 它未列入 `local-assets.json`，但
  `boardArt.js` / `board3d/atlas.js` **按路径直接引用**，删了会坏 3D 棋盘
- ✅ **精简维护侧工具 32 项** + `tools/i18n/` + `public/dev/`；`package.json` scripts 精简为
  `start / dev / vendor / assets / postinstall / setup / doctor`（规则：脚本命名的文件都在才保留）。
  保留 `update.mjs` 及其依赖 `package-update.mjs`、`setup` 依赖的 `assets/`，逐一 `import` 验证通过

## 测试结论：零回归

`check:imports` / `typecheck` / `eslint`（0 error）/ docs 测试 32/32 / 关键测试全部通过。
跑完 **595 个测试文件**，并把所有失败项**逐个在合并前基点 `da60048d` 上复跑对比**，结论是**全部预先存在**：

| 失败项 | 基点 0.2.5 | 合并后 | 判定 |
|---|---|---|---|
| ES2020 语法门（24 个违规文件） | 24 | 24（清单逐一致） | 既有 |
| `version.test.js`（CHANGELOG 首条 `0.2.6` vs `0.2.6-fusion-20p`） | 同样失败 | 同样失败 | **既有** |
| `ai-picks-last` ×3、`feedback7-voices`、`android-blackscreen` ×2、`match-info`、`text-scale` ×3、`windows-bundle` | 相同 | 相同 | 既有 |
| `lobby` 等 5 个（并行负载偶发） | — | 单独跑全绿 | 偶发 |

> 已知待办：`version.test.js` 要求 CHANGELOG 首条标题等于 `APP_VERSION`，而 CHANGELOG 用的是上游平铺名
> `## 0.2.6`（0.2.5 时同样如此）。一行可修：把首条改成 `## 0.2.6-fusion-20p — 2026-10-13`。

## 踩坑记录

1. **WSL 不可用时怎么编启动器**：`bash build-shell.sh` 会报 `execvpe /bin/bash failed`（WSL 没装发行版）。
   直接在 cmd 里跑 `csc.exe` 一行命令即可（见客户端包内 `组装说明-0.2.6.md`），或存成 `build-shell.bat`。
2. **`--source` 语义**：`tools/update.mjs --source` 填**不含 `/update`** 的基地址；更新源里 `feed.manifest.url`
   是生成时的绝对地址（本项目为隧道 `https://frp-say.com:17763/update`），自签证书链路上需要 `--insecure`
   （启动器在配了公钥时会自动加）。
3. **素材删除不能只看「是否在清单」**：`tiles.json` 就不在清单里但被代码直接引用 —— 删素材前要同时查
   代码 / 数据里的路径引用。
4. **`cp -al`（硬链接）在本机沙箱里会失败**，会退化成整盘拷贝；`mv` 跨目录也可能变成拷贝（移动 7.6 GB 的
   `android/` 曾超时并留下半成品）。大目录操作前先确认。
5. **更新源渠道必须与客户端形态一致**：服务端全树（含 `test/` `docs/`）当发布源会让客户端「检查更新」
   把 800+ 个开发文件补进 `app\`。发布源要用客户端渠道生成。

## 尚未做 / 下一步

- **安卓 APK**：按要求跳过（0.2.5 的 APK 仍在旧 Release；Android 工程在 `android/`）
- `-server.zip` **不含 `node_modules`**，新机器首次需 `npm ci --omit=dev`（Node ≥ 22）
- 客户端包尚未做代码签名（Windows SmartScreen 可能提示）；如需可加 `signtool`
