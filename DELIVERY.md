# 交付说明 · 0.2.4-fusion-20p（20 人房间 + 官方 v0.2.4 自制分支）

## 这是什么

在 **0.2.1-fusion-20p**（Paper-Yuan fusion + LongQianChen 20 人房间）之上，先后合并了**官方 v0.2.3**（含 v0.2.2）与**官方 v0.2.4**。

- 分支/提交：`fusion-20p`，本次合并提交 `993e1b3e`（父提交 `31f245ff` + 官方 `bc50cac0`），随后 `ed8d97bd` 修复合并暴露的问题
- 版本号：`0.2.4-fusion-20p`
- 工作目录：`/home/ccyl/stronghold/fusion-20p`
- 测试端口：**3010**（3000 仍为 Paper-Yuan 生产服 `0.2.3-fusion-20p`，未受影响）

## 本次合并带来（官方 v0.2.4）

| 类别 | 内容 |
|---|---|
| 规则（核心） | **共享卡池与装备库存按官方补齐**：同盟干员份数为单人 2 倍（部分低阶例外）；装备也有全队共享库存，普通 / 进阶分别占 1 / 2 份，商店展示不占份数、购买时再查一次，机变卡用尽不能再选，消耗 / 销毁 / 出售 / 淘汰都会归还份数 |
| 规则 | 突袭成员复活后按嘲讽优先重新选落点、首领战可跳空半场（#475）；浊心斯卡蒂一技能 × 坚守 伤害互相反弹的死循环修复；克莱门莎二技能溅射修正（#467）；哈洛德 / 涤火杰西卡 / 家族徽章 / 松果 / 琳琅诗怀雅香槟炸弹 / 白面鸮复制 等社区修正 |
| 界面 | 大厅标题栏改版、自选编队详情与干员调配共用同一套数值 / 技能 / 练度显示、日语界面改用官方日服用语（#448）、渲染资源加载失败自动重试并可恢复 3D 画面 |
| 人机 | AI 队友买高阶卡时减少与队友抢开局盟约；有真人参与时发送有限表情（`SP_BOT_EMOTES=0` 关闭） |

### 分组库存适配（本分支关键改动）

官方 v0.2.4 的共享库存是**全局一份**；本分支的 20 人房间把玩家分成固定组，库存必须落在**每组一份**上，否则一个组会把别人的份数吃掉：

- `createPoolGroups()` 为每组各建一个 `SharedPool` + **`SharedItemPool`**，份数按组人数缩放（`shared/playerCapacity.js` 的 `poolGroupSizes` / `poolCopyScale`，`poolCopyScale = max(1, 组人数 / 4)`）。
- `Match` 暴露 `get itemPool()`（第一组，仅供诊断）与 **`itemPoolFor(player)`**（按玩家所在组取库存）；`player/economy.js`、`player/acquire.js`、`player/prep.js`、`match/views.js`、`match/spDraft.js`、`invariants.js` 全部改用「按玩家的库存」。
- 机变草稿按组校验装备库存（`spCardAvailable`）；某组库存用尽时**立即结束该组页面**，不影响其余各组的回合与计时（`choices.js generateGroupDrafts` 由 `return null` 改为 `continue` 省略该组）。
- 组内份数与官方一致：四人组 = 单人原始量、三人组 = 当前同盟基准、五人组另有三阶下限规则。

## 合并过程与冲突处理

本次合并 **17 个文件冲突**。处理原则：**本分支与 LongQianChen 基线 `9815b3af` 逐字节相同的文件，直接采用其合并后版本 `2e12cdfe`**（我们的 20p 移植正源自该基线，其合并提交已完成同样的库存适配）；有自有改动的文件先取其版本、再重新施加本分支的改动。

| 文件 | 处理 |
|---|---|
| `server/match/pool.js`、`choices.js`、`invariants.js`、`effectsMeta.js`、`player/economy.js`、`player/acquire.js`、`player/prep.js`、`test/match/{pool,shared-stock}.test.js` 等 | **直接采用其合并后版本**（含分组库存适配） |
| `server/match/Match.js`、`match/spDraft.js`、`match/views.js` | 采用其版本 **+** 重新施加本分支的 `aiPicksLast`（官方开关语义）与皮肤字段（`skins` / `skin`） |
| `public/js/screens/lobby.js` | 采用官方标题栏改版（设置 / 说明 / 添加到桌面 移入左侧工具栏，博士名片成为统计入口）**+** 保留本分支的延迟波动读数与在线人数；移除因此重复的「统计」按钮 |
| `public/js/screens/diy.js` | 两边 import 合并（保留 `useData`，加入官方 `skillTags`） |
| `shared/constants.js`、`package.json`、`package-lock.json` | 版本号统一为 `0.2.4-fusion-20p` |
| `CHANGELOG.md` / `README.md` / `docs/DESIGN.md` | 保留本分支条目与 Capacity 段，补入官方 0.2.4 说明（DESIGN §29） |
| `data/assets.json` | 保留本分支清单（含皮肤与语音），不改用官方版 |

## 上一轮：官方 v0.2.2 / v0.2.3

- 合并提交 `6a1644d7`（父提交 `be662a22` + 官方 `1db8e510`），版本号 `0.2.3-fusion-20p`。

| 类别 | 内容 |
|---|---|
| 新内容 | 六星**克莱门莎**；黍 **GUA-Y**、乌尔比安 **CRU-Y** 模组 |
| 养成 | **潜能 1–6 与练度按干员设置**（默认满潜、精英2 60 级，`room.loadout.ops`） |
| 语音 | **日文语音**（`audio.voiceJp`）+ 逐干员语音语言、点选干员语音 |
| 界面 | 四档文字大小、攻击范围显示、场地装置说明卡、本机**统计页** |
| 对局 | 房主**重发开局**（`room.rerollSetup`/`g.rerollVote`）、**恢复本机对局**（`SESSION_IN_USE`）、AI 队友最后选择（`room.setAiPicksLast`） |
| 规则 | 一大批官方修正（蕾缪安/死芒/塞雷娅/凯尔希/赤刃明霄陈/远牙/锤击/吟游者/传送门/胶囊计数…） |

## 交付物（0.2.4-fusion-20p）

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `stronghold-0.2.4-fusion-20p-update.zip` | **12 MB（增量包，0.2.3 → 0.2.4）** | `0abf395e3173c85582fc0f067af8cfdc1d10d01a5f439e19adcdae7c20a8b6a1` |
| `stronghold-0.2.4-fusion-20p-server.zip` | 21 MB（代码包，仅 174 个 git 跟踪素材） | `e8a2da8549a13005d061c8619a34ee5a0d32fec77fa210eafb7f9035afacf4b1` |
| `stronghold-0.2.4-fusion-20p-full.zip` | **587 MB（完整包，含 13709 个素材文件 + 本地客户端素材）** | `37ada16eb6273b01646bc1ddecab91088278c58805c7306d8c27a9aafc1eb9f3` |
| `android/app/build/outputs/apk/release/Stronghold-Protocol-release.apk` | 622 MB（`versionCode 23` / `versionName 0.2.4-fusion-20p`） | `9240fda9fd05339455d7aec454a4c14e6f857ac1918b82a3fcfa2c40e8caf90f` |

- 四个产物均为 **0 个隐藏条目**；APK 内含 `assets/app_bundle.zip`（598 MB / 18095 个文件，含 1482 个本地素材）。
- APK 签名证书 SHA-256：`0ac3456d69c7f73a68f6ed27c2b161b7d8b7495fab9af41ea65b12f9e56e78ba`（`CN=Stronghold Protocol 20p`，与上一版同一把签名密钥，可覆盖安装）。
- 完整包与 APK **均含完整克莱门莎素材**（头像 / E2 头像 / 两张立绘 / 三个技能图标 / Front+Back 小人模型）。
- `data/local-assets.json`（本机生成的本地素材清单）**只进完整包、增量包与 APK**，不进代码包 —— 代码包不含 `public/assets/local`，带上清单会指向不存在的文件。

### 增量包（`-update.zip`）—— 0.2.3 的玩家用这个更新

面向**已经装过 0.2.3-fusion-20p** 的玩家：解压覆盖到安装目录即可，**存档 / 配置 / 已下载的素材缓存 / `node_modules` 全部保留**。

- 内容：相对 `stronghold-v0.2.3-fusion-20p-full.zip` **新增 647 个、变更 430 个、删除 0 个**文件（共 1077 个），压缩后 12 MB。
- 素材只补**新增/修正**的部分（克莱门莎 13 个文件、343 个规范化后的皮肤 atlas、131 个模组图标、补齐的音效），**不需要重下整套素材**。
- 本版**没有任何文件需要删除**，所以增量包不附带删除清单；包内 `如何更新.txt` 写了步骤。
- 生成方式：`/tmp/make-delta.mjs` 用 `unzip -v` 取旧包的 size+CRC32、用 `zlib.crc32` 算新树，得出差异清单再打包。
  **为什么不用项目自带的 `tools/package.mjs --update`**：它要求基准包带 `MANIFEST.json` 且是 `Stronghold-Protocol/` 嵌套布局，而我们历次发布的是**扁平 zip**（且没有 `MANIFEST.json`），直接用它会对不上玩家的目录结构。
- **端到端验证**：把 `v0.2.3 完整包` 解压后叠加本增量包，与 `v0.2.4 完整包` **逐文件 CRC 比对 —— 缺失 0、内容不同 0**（只多出 `如何更新.txt` 本身）；再补上 `node_modules` 启动，版本 `0.2.4-fusion-20p`、克莱门莎素材 200、本地素材清单 1481 条、清单 210 人，日志无错误。

## 仍然保留（Paper-Yuan 自有）

## 仍然保留（Paper-Yuan 自有）

20 人房间（`ROOM_CAPACITIES` 4/8/10/16/20，默认 8）+ `room.setCapacity` · 座位分组与分组机变 ·
干员皮肤系统（`room.skins` / 换装 `SkinSection` / `skinsStore`）· 管理端（`AdminService`、`/api/admin/*`、运维 CLI）·
房间与局内文字聊天（`room.chat`）· 服务器负载监控（`serverLoad`）· 自动撮合（`Matchmaker`）· 停服维护 · 安卓打包 ·
**默认日语语音**（`voiceLang='jp'`）

## 关键决策与分歧

1. **机变 skip 语义保留本分支**（`prioritizeDraftOrder` + lone-human 守卫）：官方新测试
   `test/match/ai-picks-last.test.js` 有 3 处期望与之矛盾（选项恒开、离场真人留在 order、lone human 可跳到末尾），
   属**有意分歧**；本分支的 `draft.test.js` / `group-drafts.test.js` 明确要求现有语义（20 人固定池分组的地基）。
2. **默认语音语言 = 日语**（Paper-Yuan 行为）：官方默认中文；已同步修改 `test/feedback7-voices.test.js` 的 3 处断言
   并在文件里注明原因。
3. **`data/assets.json` 重新生成**（按项目硬规则「不手工编辑生成数据」）：
   `node tools/fetch-assets.mjs --offline --allow-shrink` + `node tools/inject-skins-assets.mjs`
   - 干员 138 → **209**（官方全集）；新增 **`voiceJp` 2674 条**；皮肤 271 套保留
   - 清理 131 条指向**磁盘上并不存在**文件的 `modules` 陈旧条目
   - 效果：`docs-consistency` 由 1 失败 → **24/24 通过**；`assets.test.js` 由 7 失败 → 2 失败

## 交付物

| 文件 | 说明 |
|---|---|
| `stronghold-v0.2.3-fusion-20p-server-release.tar.gz` | 代码包（19MB） |
| `stronghold-v0.2.3-fusion-20p-server-release-full.tar.gz` | **完整包（623MB，含 13066 个素材文件）** |
| `/home/ccyl/stronghold/fusion-20p/` | 完整源码工作区 |
| 3010 运行中的服务 | 合并后代码，素材软链自生产服 |

## 如何运行

```bash
bash /tmp/run3010.sh start|stop|status|log
# 或
cd /home/ccyl/stronghold/fusion-20p && PORT=3010 node server/index.js
```

---


## 这是什么

把 **LongQianChen 的 20 人房间功能**（`v0.2.1-20p.2fix`）移植进 **Paper-Yuan 的 fusion 分支**，
形成自制分支 `fusion-20p`。它在保留 Paper-Yuan 全部自有功能的基础上，加入了 20 人房间。

- 分支/提交：`fusion-20p`，合并提交 `710c65df`
- 版本号：`0.2.1-fusion-20p`（用于区分于 Paper-Yuan 的 `0.2.1-fusion`）
- 工作目录：`/home/ccyl/stronghold/fusion-20p`
- 测试端口：**3010**

## 功能一览

### 新增（来自 20 人房间移植）
| 功能 | 说明 |
|---|---|
| 20 人房间 | 容量可选 **4 / 8 / 10 / 16 / 20**（`ROOM_CAPACITIES`），默认 8 人；房主可开局前用 `room.setCapacity` 调整（只收缩空尾座位，绝不移动/踢出玩家） |
| 座位分组 | 每组独立卡池，组内并行选牌（`groupId`） |
| 分组机变/选牌 | 每格 6 张（`MAX_DRAFT_CARDS`），支持投票跳过后续机变 |
| 联防扩展 | 按分组数扩展联防强度 |
| 官方 0.2.1 规则 | 干员数值、满潜能计算、持有名单上限 64→160、卡池与结算规则 |

### 保留（Paper-Yuan 自有）
干员皮肤系统（局外调配 + 局内换装）· 管理端面板（`/admin`、`/api/admin/*`、运维 CLI）·
房间与局内文字聊天 · 服务器负载监控（主页预载提示）· 自动撮合 · 停服维护 · 安卓打包 · i18n 语言包

## 交付物

| 文件 | 说明 |
|---|---|
| `stronghold-v0.2.1-fusion-20p-server-release.tar.gz` | 服务端发布包（含 server/shared/public/data/tools/deploy，18MB 代码） |
| `/home/ccyl/stronghold/fusion-20p/` | 完整源码工作区（git 仓库） |
| 端口 3010 运行中的服务 | 由工作区启动，素材软链接自 Paper-Yuan 生产服，供即时测试 |

> **客户端素材**：`public/assets/` 是 git-ignored 的大素材目录（约 820MB），不随发布包完整提供。
> 按你的说明，客户端素材从 Paper-Yuan 的发布包获取即可（或直接用生产服 `../server/public/assets`）。

## 如何运行（3010 测试）

```bash
bash /tmp/run3010.sh start      # 启动（自动补齐素材软链接）
bash /tmp/run3010.sh status     # 查看 healthz
bash /tmp/run3010.sh log        # 看日志
bash /tmp/run3010.sh stop       # 停止
```

或手动：

```bash
cd /home/ccyl/stronghold/fusion-20p
PORT=3010 HOST=0.0.0.0 ADMIN_SECRET=你的密钥 node server/index.js
```

打开 `http://<主机>:3010/` 即可；`/healthz` 返回 `{"ok":true,"app":"0.2.1-fusion-20p",...}`。
管理端：`http://<主机>:3010/admin`（需 `ADMIN_SECRET`）。

## 如何部署到正式服

发布包是「代码包」，素材需与 Paper-Yuan 的客户端素材合并：

1. 解包：`tar xzf stronghold-v0.2.1-fusion-20p-server-release.tar.gz -C 你的部署目录`
2. 把 Paper-Yuan 的 `public/assets/`（完整素材）放进 `public/assets/`
3. `npm install --omit=dev`（或复用已有 `node_modules`）
4. `PORT=3000 node server/index.js`

> 请注意：**3010 是本分支测试服；3000 仍是 Paper-Yuan 正式服**，未被本次改动触碰。

## 已做的验证

- 全树 1315 个 `.js` 通过 `vm.SourceTextModule` 解析（无重复声明/语法错误）
- 所有相对导入的具名绑定都能在目标模块导出中找到
- 3010 实测：
  - 创建 20 人房 → `capacity:20`、`seats` 长度 20 ✓
  - 加满 20 个 AI → 占座 20，第 21 个正确返回 `ROOM_FULL` ✓
  - 空房收缩 20→16→20 ✓；座位有占用时拒绝收缩（正确行为）✓
  - 非法容量 5 → `BAD_MSG: bad field capacity` ✓
  - **20 人开局** → `inMatch:true`，收到 `welcome`/`m.private`/`m.public`，零错误 ✓
  - Paper-Yuan 功能：`room.chat` 回显 ✓、`room.skins` 接受 ✓
- 服务端测试：`test/match/*` 804 通过 / 0 失败；`test/lobby.test.js` 66/66；
  `test/admin.test.js` 通过；skins 系列通过

## 已知遗留问题（均为**合并前既有**，非本次引入）

合并后逐项与合并前 `31f245ff` 对比确认，**无新增失败**（`assets.test.js` 反而由 5 失败降到 2 失败）：

| 测试 | 现象 | 与合并前对比 | 根因 |
|---|---|---|---|
| `test/match/ai-picks-last.test.js` | 3 失败（选项关闭 / 托管 / 跳过的顺序语义） | 同样 3 失败 | **有意分歧**：本分支保留 `prioritizeDraftOrder` + lone-human 守卫，官方期望 `humansFirst` 分区；这是 20 人固定池分组的地基 |
| `test/ui/audio.test.js` | 4 失败（S3 技能攻击 / 命中音库） | 同样 4 失败 | 清单里缺 `attacks` / `hits` 表（官方清单同样缺） |
| `test/ui/text-scale.test.js` | 3 失败 | 同样 3 失败 | 本分支 UI 选择器与 `theme.css` 根字号（24px vs 官方 40px）不同，排除表未同步 |
| `test/ui/standin-ui.test.js`、`test/ui/match-info.test.js` | 各 1 失败 | 同样各 1 失败 | 既有 |
| `test/es2020-syntax.test.js`、`test/android-blackscreen.test.js` | 1 / 2 失败（`??=`、顶层 await） | 同样 | 本分支自有代码使用较新语法，旧版 Android WebView 门禁 |
| `test/assets.test.js`、`test/assets-diy.test.js` | 2 / 2 失败 | **5 → 2 失败（改善）** | 素材清单与磁盘的差异（含克莱门莎缺口，见下） |
| `test/feedback7-voices.test.js` | 1 失败 | 同样 1 失败 | 磁盘日语语音 191 个干员 vs 官方 192（同一素材源滞后） |
| `test/client-static.test.js` | 挂起（未决 Promise） | 原分支同样 | 会让整套测试不退出，需单独排除 |
| `test/docs-consistency.test.js`、`test/i18n.test.js`、`test/docs-paths.test.js` | **全部通过** | 24/24、10/10、7/7 | 0.2.3 轮已修复 |

### 素材缺口：克莱门莎 `char_4231_clemnt` —— 已修复

官方 v0.2.3 的**数据**把克莱门莎加进了干员名单（`data/backups.json` 自选池 `diy.ownedPool`、分队
`band_clementia`、战斗实现 `server/sim/content/kits/ops/op-clemnt.js` 都齐全），但 0.2.3-fusion-20p 打包时她的
**美术素材磁盘上完全没有**（全机器搜索 = 0 个文件），所以自选界面里没有头像、没有小人模型。

**2026-10-10 的根因**（已记录，现已解决）：

| 素材 | 上游来源 | 当时状态 |
|---|---|---|
| 头像 avatar / 立绘 portrait / 技能图标 | yuanyan3060/ArknightsGameResource | 上游已可用，但清单是 **`--offline` 离线重建**（只扫磁盘、不联网），没抓到 |
| 小人模型 Spine | fexli/ArknightsResource `spine/{id}/{id}/{Front,Back}/` | 当时上游 dump 未收录 → 抓取报告 `missing skel` |

**2026-10-11 联网重抓后已全部补齐**（`node tools/fetch-assets.mjs --add-only --allow-shrink`，下载 643 个文件 /
10.4 MB）：头像、E2 头像、两张立绘、三个技能图标、Front + Back 战斗小人模型全部到位；`chars` **209 → 210**，
`charsWithBack` 205 → 207。**她的语音仍缺**（镜像尚未收录，`voiceChars` 保持 191），客户端不播放。

**顺带修好的同类缺口**：`char_1052_kalts2`（凯尔希·思衡托）此前因 atlas 声明了第二张贴图页
`char_1052_kalts22.png` 而整体被剔除；该页本次已抓到，模型随之入清单。

**顺带发现并修复的系统性问题：皮肤 atlas 未做后处理。** `tools/fetch-skin-spines.mjs` 只下载、不规范化，它抓的
**343 个皮肤 atlas 一直缺少 `size:` 行**（`processModels` 对「不是本次下载的既有文件」不重写，`--add-only` 更窄），
而 `test/assets.test.js` 明确要求每个 atlas 都有 `size:`。已用 `processModels` 同一套 `normalizeAtlas`
（`tools/assets/atlas.mjs`，尺寸取自 PNG 头）补齐 **1014/1014** 全部合规 —— 这也是 kalts2 模型能解析的前提。

### 本次合并（0.2.4）修复与验证

- **「统计数据 → 对局记录」只收录前 6 名玩家**（玩家反馈）：`public/js/ui/stats.js` 的 `MAX_PLAYERS = 6` 是官方
  4 人时代的记录上限，归一化时 `.slice(0, MAX_PLAYERS)` 把第 7 名起整行丢掉。已改为 `MAX_SEATS`（本分支 20 座）。
  实测 4/6/7/15/20 人记录现在都能完整保留。
- **`b.result` 的 `RESULT_LIMITS.players = 4`**（同一类遗漏，一并修）：本分支 `e32edbb0`（20 人容量）只把
  `sources` 提到了 `MAX_SEATS`，漏了 `players` —— 后果是**任何超过 4 人的房间**，客户端权威结算都会被
  `isBattleResult()` 判为非法、`runner.js` 置 `wire = null` 并**静默降级为服务端重算（`b.yield`）**。已改为
  `MAX_SEATS`。
- 官方的 `test/ui/stats.test.js`（写死「保留 6 人 / < 40000 字符」）按本分支 20 座适配为 `MAX_SEATS` 与其比例上限，
  **44/44 通过**；真实 20 人记录约 24 KB，仍远低于 `MAX_CHARS`(800 KB) 存储预算。
- **房主离开时广播了旧房主的 `room.state`**（本次合并暴露的真实缺陷）：本分支独有的 `matchmaker.cancelRoomQueue()`
  内部会 `broadcastState()`，而它原先排在 `migrateHost()` **之前** —— 于是先广播了一帧「房主仍是将离开者」的状态；
  客户端若匹配「第一帧显示该玩家已断线」的状态，就会读到旧房主。已改为**先迁移房主、再取消排队**。
  修好后官方新测试 `test/match/leaver-isolation-ws.test.js` 由 **3 失败 → 6/6 通过**。
- **分组草稿的 0.2.4 空页契约**：`generateGroupDrafts` 在 LongQianChen 的合并里由 `return null` 改为 `continue`
  （某组库存用尽时省略该组，不阻塞其他组），但他的分支**漏改了对应测试**（那边同样失败）。本分支更新该测试为
  新契约并补上「部分组被省略、其余组保留」的用例 → `test/match/group-draft-generation.test.js` **14/14 通过**。
- **`test/match/player-capacity.test.js`**：期望值是 0.2.4 之前的（同盟未翻倍），改用其更新后的期望
  （同盟份数为单人 2 倍）→ **30/30 通过**。

### 验证结果（合并后）

| 套件 | 结果 |
|---|---|
| `test/match/*` | **915 通过 / 3 失败**（3 个为既有的有意分歧，见下；合并前同样 3 个） |
| `test/sim/*` | **850 通过 / 0 失败** |
| `test/content/*` | **2207 通过 / 0 失败** |
| `test/ui/*` | **761 通过 / 5 失败**（剩余 5 个为既有失败：text-scale 3、standin-ui 1、match-info 1；素材补齐另修好了 4 个音效测试） |
| `test/assets.test.js`、`test/assets-diy.test.js` | **54/0、6/0 全部通过**（合并后曾为 52/2、4/2；联网补素材 + atlas 规范化后转绿） |
| `test/docs-consistency.test.js`、`test/i18n.test.js`、`test/docs-paths.test.js` | **24/0、10/0、7/0** |
| `npm run golden` | **全部匹配**（49+46+22+20+10+140 场景） |
| `npm run lint` / `check:imports` / `typecheck` | **0 errors / exit 0** |
| 客户端 htm 模板 `<div>` 平衡扫描 | 143 个文件**全部平衡**（此前 `h.push` 崩溃的根因） |
| 3010 实机 | 20 人房间、房间聊天、`room.skins`、容量收缩/恢复、AI 补满 20 座、第 21 个 `ROOM_FULL`、有占用时拒绝收缩、开局 `INFO_CHECK` ✓ |
| 增量包端到端 | 旧完整包 + 增量包 与 新完整包**逐文件 CRC 一致**（缺 0 / 差 0），启动后版本与素材均正确 ✓ |

### 本次修复的问题
- **`/sim/simdata.js` 浏览器安全转换丢失**（真实回归）：模块化服务端把静态处理移到 `server/http/static.js`，
  遗漏了 Paper-Yuan 原有的「剥离 Node-only 顶层 await 块」逻辑 → 旧版安卓 WebView 会报
  `Unexpected reserved word`。**已移植回并实测**（`curl /sim/simdata.js` 中 `await import` 出现 0 次）。
- **`public/sim` / `public/shared` / `public/data` 静态镜像陈旧**（真实回归）：合并改了源目录未重新同步，
  已用 `tools/sync-static-web.mjs` 同步；`test/docs-paths.test.js` 由 1 失败 → 7/7 通过。
- **i18n**：用官方 `tools/i18n.mjs codemod` 包装 44 处中文文案、`seed` 补 57 条英文译文
  （`check en --strict` = 0 missing / 0 errors）。
- `test/admin.test.js` 硬编码版本号 → 改用 `APP_VERSION`
- `test/client-static.test.js` 的 hello 断言补上 `client` 字段（原分支既有失败）
- `test/docs-consistency.test.js` 的 `voiceChars` 断言改为只统计 `char_*` 键
  （`audio.voice` 是多用途结构：jp/cn 语言视图 + 扁平干员槽 + 文件映射）

## 关于 data/assets.json（素材清单）

`data/assets.json` 是**生成文件**（`npm run assets` 生成），合并时由人工深合并（以 Paper-Yuan 版为底，并入官方的 261 条条目）。

**为什么保留合并版而不是直接用官方版**：官方清单**没有皮肤条目**（0 条 skin 路径、无 `skins` 字段），
直接采用会**破坏 Paper-Yuan 的皮肤系统**。实测对比（失败数）：

| 清单 | assets | assets-diy | feedback5-prisoners | 合计失败 |
|---|---|---|---|---|
| 合并版（保留） | 7 | 2 | 3 | **12** |
| 官方版 | 5 | 1 | 0 | 6 |

官方版测试成绩更好，但会让皮肤失效 —— 故保留合并版。

余下与清单相关的失败（囚犯 prefab、语音 `jp`/`cn` 路径、stats 计数）属**生成数据策略差异**
（Paper-Yuan 默认日语语音、官方默认中文语音），需用统一策略重新执行 `npm run assets`
（需要完整素材 + 网络）后即可消除。

## 两个已修复的合并回归

1. **快速匹配（matchmaking）**：`targetPlayers` 原用 `MAX_SEATS`（Paper-Yuan 时代=4），
   20 人移植后 `MAX_SEATS=20` 导致要凑满 20 人才发车；且 `formRoom` 未传容量会用 `DEFAULT_SEATS=8`。
   已改为固定的经典 4 人组队并把房间容量设为该值 → `test/matchmaking.test.js` 10/10 通过。
2. **`Battle.onOwnBoard`**：官方模块版只接受玩家状态，而 Paper-Yuan 的 API 也接受干员单位
   （测试仍如此调用）。已加兼容 → `test/sim/feedback3-ulpia-move.test.js` 9/9 通过。

## i18n

官方 i18n 门禁（`test/i18n.test.js`）是合并引入的新测试。已完成两轮迁移：
- 官方 `codemod` 共包装 **130 处**中文字面量（客户端 + 服务端）
- `seed` 共补 **132 条**英文译文进 `public/i18n/en.json`（`check en --strict` = 0 missing）
- **`test/i18n.test.js` 10/10 通过**
- 顺带修复 `skinPicker.js` 中局部 `const t` 遮蔽 i18n `t` 的真实运行时 bug
