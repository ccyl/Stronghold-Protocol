# 交付说明 · 0.2.3-fusion-20p（20 人房间 + 官方 v0.2.3 自制分支）

## 这是什么

在 **0.2.1-fusion-20p**（Paper-Yuan fusion + LongQianChen 20 人房间）之上，合并了**官方 v0.2.3**（含 v0.2.2）。

- 分支/提交：`fusion-20p`，合并提交 `6a1644d7`（父提交 `be662a22` + 官方 `1db8e510`）
- 版本号：`0.2.3-fusion-20p`
- 工作目录：`/home/ccyl/stronghold/fusion-20p`
- 测试端口：**3010**（3000 仍为 Paper-Yuan 生产服，未受影响）

## 本次合并带来（官方 v0.2.2 / v0.2.3）

| 类别 | 内容 |
|---|---|
| 新内容 | 六星**克莱门莎**；黍 **GUA-Y**、乌尔比安 **CRU-Y** 模组 |
| 养成 | **潜能 1–6 与练度按干员设置**（默认满潜、精英2 60 级，`room.loadout.ops`） |
| 语音 | **日文语音**（`audio.voiceJp`）+ 逐干员语音语言、点选干员语音 |
| 界面 | 四档文字大小、攻击范围显示、场地装置说明卡、本机**统计页** |
| 对局 | 房主**重发开局**（`room.rerollSetup`/`g.rerollVote`）、**恢复本机对局**（`SESSION_IN_USE`）、AI 队友最后选择（`room.setAiPicksLast`） |
| 规则 | 一大批官方修正（蕾缪安/死芒/塞雷娅/凯尔希/赤刃明霄陈/远牙/锤击/吟游者/传送门/胶囊计数…） |

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

| 测试 | 现象 | 根因 |
|---|---|---|
| `test/es2020-syntax.test.js` | 1 失败（21 处 `??=` / 顶层 await） | Paper-Yuan 分支本就失败（原分支实测同样 1 失败） |
| `test/android-blackscreen.test.js` | 1 失败（`server/sim/` 里的 `??=`） | 同上（原分支实测同样 1 失败） |
| `test/client-static.test.js` | 挂起（未决 Promise） | 原分支同样挂起，会让整套测试不退出 |
| `test/assets.test.js` / `assets-diy.test.js` | 若干失败 | 素材清单陈旧，需 `npm run assets` 重新生成（实测：ours 原清单 9 失败、合并版 7 失败） |
| `test/docs-consistency.test.js` | 1 失败（语音 URL 语言不匹配，710 条用 `jp` 而非 `cn`） | **生成数据策略差异**：Paper-Yuan 默认日语语音、官方默认中文语音；需用统一策略重新生成 `data/assets.json` |
| `test/i18n.test.js` | 1 失败（部分 Paper-Yuan 文案未包装） | 官方 i18n 门禁是合并引入的新测试；Paper-Yuan 自有文案未 i18n 化（已修复大部分，见下） |

### 已知素材缺口：克莱门莎 `char_4231_clemnt`（上游素材库未更新，非代码问题）

官方 v0.2.3 的**数据**把克莱门莎加进了干员名单 —— `data/backups.json` 自选池 `diy.ownedPool`（72 人）含她，
分队 `band_clementia`（崇高牺牲）、战斗实现 `server/sim/content/kits/ops/op-clemnt.js`（注释：Official CN tables
2026-10-08, client 2.7.81）都齐全；但她的**美术素材在本机完全不存在**（全机器搜索 `char_4231_clemnt` = **0 个文件**），
所以自选界面里**没有头像、没有小人模型**，技能图标与语音同样缺失。

2026-10-10 核查的根因（分两类）：

| 素材 | 上游来源 | 状态 |
|---|---|---|
| **小人模型** Spine | isHarryh/Ark-Models `models_data.json` | ❌ **上游索引未收录**：线上索引 `Date: 2026-09-29`、3197 条，无 `char_4231_clemnt`；而同期实装的珊比 `char_4235_thumpy`、谬因 `char_4229_aphris`、可露希尔 `char_4228_closur`、机械师 `char_4230_mcnist` 全部在列 → 索引快照早于该干员实装（2026-10-09），需等上游更新 |
| **头像** avatar / **立绘** portrait | yuanyan3060/ArknightsGameResource | ⚠️ 上游**现已可用**（实测 `avatar/char_4231_clemnt.png`、`portrait/char_4231_clemnt_1.png` 均 HTTP 200），但本次 `data/assets.json` 是 **`--offline` 离线重建**（只扫本地磁盘、不联网下载），所以没拿到 |
| 技能图标 / 分支图标 / 中·日语音 | yuanyan `skill/`、AA2、AA2 voice 分支 | 同上，缺失（语音各 14 条） |

影响范围可控：`data/assets.json` 的 `chars` 由官方 v0.2.3 的 **210 → 209**，逐叶子比对确认**唯一丢失的就是她**（无其他损失）。
抓取报告 `downloadErrors: 0`，说明当时无网络错误，是根本没发起下载。客户端对缺失条目是**优雅降级**
（`chessAvatarUrl` 返回 `null`、无 Spine 则不画模型），不会崩溃。

修复路径（**本次未执行，待办**）：
1. 等 Ark-Models 索引更新后，`node tools/fetch-assets.mjs --refresh-index` 联网重抓（可补头像/立绘/技能图标；模型须等索引）；
2. 若不想让玩家选到无美术的干员，可在 `shared/diy.js` 过滤掉清单里查不到头像的干员。

另一个同类缺口：`char_1052_kalts2`（凯尔希·思衡托）有头像与立绘，但 Spine 被剔除 —— 其 atlas 声明了第二张贴图页
`char_1052_kalts22.png`，上游 dump 没有该页。

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
