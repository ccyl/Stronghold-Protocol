# 版本自检与自更新（/update/ 端点 + tools/update.mjs + 启动器一键更新）

服务端既是游戏服务器，也是**更新源**：它在 `/update/` 上发布"当前版本是什么、内容长什么样、要改哪些文件"，
客户端的启动器与 `tools/update.mjs` 照它自检，发现落后（或版本号相同但内容不一致）就一键更新。

- 发布信息（latest.json / MANIFEST.json / *.zip / *.sig）由 `tools/make-update.mjs` 生成，放在 **SP_UPDATE_DIR**
  （默认 `<ROOT>/updates`；蓝绿部署请放 `/opt/stronghold-updates`，**不要放进** `/opt/stronghold-blue|green`，
  否则 `hot-swap.sh` 会把发布目录一起换掉）。
- 端点（`server/http/update.js`，由 `server/http/routes.js` 在 `/update/` 前缀上转进去）：

| 地址 | 内容 |
| --- | --- |
| `GET /update/` | 自述 JSON（排障：更新源在哪、里面有什么、当前发布是什么） |
| `GET /update/latest.json` | 发布信息：`app` 版本、`order`、内容摘要 `digest`、适用版本 `from`、更新包名/sha256/大小、`removed`、`notes` |
| `GET /update/latest.json.sig` | 上面那份的 ed25519 签名 |
| `GET /update/MANIFEST.json` | 受管文件的 `size + sha256`（客户端逐文件比对；也是 `/update/file` 的准入表） |
| `GET /update/<name>.zip` | 更新包（Range 续传由 `server/http/files.js` 提供，206/416 都对） |
| `GET /update/file?path=<受管相对路径>` | 服务端这份安装里某个文件的字节（逐文件同步用；只允许清单里的路径，大小与清单不一致时返回 503） |

## 1. 受管集合与摘要（口径只有一处实现：`server/updateSet.js`）

**受管集合 controlled set** = 安装目录里"更新负责"的文件：排掉元文件（`MANIFEST.json` / `UPDATE.json` /
`.update-applied.json` / `latest.json` / `*.sig`）、素材（`public/assets/`、`public/fonts/`、`data/assets.json`、
`data/local-assets.json` —— 归 `tools/setup.mjs` 管）、`node_modules/`、点开头的文件与缓存日志
（`.cache`、`logs`、`updates`、`.git`、`.venv*`、`handoff`、`.claude`）。

- **内容摘要 digest** = 对**发布清单里的那些路径**（排序后）取 `sha256(path\0size\0sha256\n)`。
  客户端按同一份清单算本地状态（文件不在就按 `missing` 记），所以**客户端渠道里多出来的开发文件
  （`android/`、`docs/design`…）不影响摘要**：它们不在清单里。
- **素材指纹** = 只按 `(路径, 大小)` 算（不读内容，834 MB 读一遍太慢）：够发现"素材集合不一样"
  —— 0.2.4 那份客户端就少 70 个 spine atlas 的 `size:` 行（每个少 14 字节），指纹立刻不一致。
  素材只报不修（更新包与逐文件同步都不搬 `public/assets`），修复走 `node tools/setup.mjs`。
- **版本比较**：先比 `order`（发布脚本按 `YYYYMMDDNN` 生成，只为排序），再回落 `x.y.z[-pre]`。
  `0.2.4-fusion-20p` 这类分支号**不要**用字符串比。

## 2. 发布（维护者的机器上）

```bash
# 1) 一次性：生成发布密钥（私钥只留在发布机；公钥随客户端包分发 —— 见第 3 节的 update-pubkey.d）
node -e "const c=require('node:crypto'),fs=require('node:fs');const{publicKey,privateKey}=c.generateKeyPairSync('ed25519');
fs.writeFileSync('release-private.pem',privateKey.export({type:'pkcs8',format:'pem'}));
fs.writeFileSync('update-pubkey.pem',publicKey.export({type:'spki',format:'pem'}));"
#    把 update-pubkey.pem 复制进客户端包的 update-pubkey.d\（文件名随你，*.pem 都读）；
#    同一个目录里可以放多把（多发布方），客户端任一把验过即通过。

# 2) 每个版本：从"新版本树"生成发布目录（--from 必须是你自己渠道发出去的包/目录）
node tools/make-update.mjs \
  --to <新版本树> \
  --from <上一个客户端包的 app 目录 或 完整包.zip>[,<再上一个>] \
  --out <发布目录> \
  --url-base https://frp-say.com:17763/update \
  --key release-private.pem \
  --notes "<这一版做了什么>" \
  [--keep android/,docs/design/,...]   # 客户端渠道里服务端树没有的开发文件：永不删除
  [--no-art]                            # 只发程序与数据（素材交给 setup）；不发就带上改动过的素材

# 3) 放到服务端
scp <发布目录>/* 服务器:/opt/stronghold-updates/    # 先传 zip 与 MANIFEST.json，最后覆盖 latest.json
```

产物：`latest.json`、`latest.json.sig`、`MANIFEST.json`、`Stronghold-Protocol-v<版本>-update.zip`
（zip 里是"相对 --from 的差异文件" + 清单，裸根路径 —— 直接映射到客户端的 `app\`）。
不依赖 git：`tools/package.mjs` 要用 `git ls-files`，这里按目录树自己走。

发布后自检一次：

```bash
curl -s https://你的服务器:端口/update/            # 自述
curl -s https://你的服务器:端口/update/latest.json | head -c 400
```

## 3. 客户端（玩家机器上）

```bash
node tools/update.mjs check  [--root <app目录>] [--source <主机:端口|目录>] [--pubkey <公钥.pem|目录>]… [--json] [--deep]
node tools/update.mjs apply  [同上] [--mode auto|zip|files] [--no-setup] [--force] [--dry-run]
```

`check` 的四种结论：`current`（版本与内容都对）、`outdated`（发布方版本新，并说明本机版本是否在 `from` 里
—— 在就能用更新包）、`drifted`（**版本号一样但内容不一样**）、`server-behind`（本机比发布方新，不降级）。

`apply` 怎么选路：

- 能用更新包（本机版本在 `from` 里，或 `--zip <本地包>`）→ 下载 zip（**断点续传**）→ 校验 sha256 →
  解压（工具自带 `readZip`，逐条 `pathProblem` 防目录穿越，先写 `.sp-tmp` 再改名）→ 交给 `server/update.js`
  的 `applyPendingUpdate` 收尾：按新版本的 `MANIFEST.json` 核对整个安装、删掉新版本不再用的旧文件
  （只删内容与旧版本一致的文件）、把 `UPDATE.json` 改名 `.update-applied.json`；
- 用不了更新包（版本对不上、或只是内容漂移）→ **逐文件同步**：按发布清单只取缺的与内容不对的文件
  （`/update/file?path=`，每个文件校验 sha256），再按发布方的 `removed` 删旧文件；
- 收尾：重算摘要与发布方比对；然后（默认）跑 `node tools/setup.mjs --quiet` 补素材（`--no-setup` 跳过）。

**更新前必须停本机服务端**：`apply` 会探测本机端口（`shell.json` / 3000-3002）并在发现服务端在跑时拒绝，
`--force` 可强制（正被 node 加载的模块文件换掉会读到半个版本）。

启动器（`启动器\启动游戏.exe`）：

- 启动后**静默**自检一次（失败静默，不影响玩）：状态栏右侧显示 `v0.2.4-fusion-20p · 已是最新`，
  落后时显示 `有新版本 vX（本机 vY）· 点此一键更新`（点一下即更新，更新前自动停掉自己起的服务端，完成后重启窗口）。
- 菜单：`设置 → 检查更新…` / `设置 → 一键更新到最新…`。
- 命令行（无窗口，写 JSON 报告）：`启动游戏.exe --check-update --game <app目录> --update-source <地址> --pubkey update-pubkey.pem --smoke-out <报告.json>`
  / `启动游戏.exe --update [--update-no-setup] …`。
- 配置（`shell.json`）：`updateSource`（不写就取"当前连的服务器 / 记住的服务器"）、`updatePubkey`（可多个，用 `;` `|` `,` 分隔）。
  环境变量：`SP_UPDATE_SOURCE`。

**信任根（公钥）放哪** —— 可放**多把**（多发布方共存，任一把验过即通过），查找顺序：

| 顺序 | 位置 |
|---|---|
| 1 | `--pubkey`（可重复；给**文件**或**目录**都行） |
| 2 | 环境变量 `SP_UPDATE_PUBKEY`（可多个，用系统路径分隔符） |
| 3 | `启动器\update-pubkey.d\*.pem`（按文件名排序）与 `启动器\update-pubkey.pem` |
| 4 | **客户端包根目录**（= `app` 的上一级）的 `update-pubkey.d\*.pem` 与 `update-pubkey.pem` |

刻意**不读**安装目录（`app`）里的那一份：更新包会覆盖安装目录，等于让更新源自己给自己发通行证。
包里默认可只带**你自己服务器**那一把；想同时接受上游/官方服的发布，把他们的 `update-pubkey.pem`
也丢进同一个 `update-pubkey.d\`（文件名随意）即可。自检报告会写清是**哪一把**验过的：
`签名：通过（公钥 …\update-pubkey.d\stronghold.pem，指纹 407a92fe…；候选 N 把）`。

## 4. 安全

- `latest.json` **必须签名**（ed25519）：这条链路走的是 frp + 自签证书（SakuraFrp 自动证书），
  传输本身不可信 ⇒ 签名 + 每个文件的 sha256 是唯一的两道门。客户端 `--insecure`（自签证书）**必须**同时给 `--pubkey`，
  否则直接拒绝运行 —— 传输不可信时不能只剩"没校验"。
- 不用 `--insecure` 也能用：给服务器配一个受信任的证书，或让启动器把该主机记进 `trustedHosts`（那是给**页面**用的，
  更新通道不继承这套豁免）。
- `/update/file` 只服务发布清单里列出的路径，路径穿越与非受管路径一律 403；服务端文件与清单大小不一致时 503
  （部署做到一半时宁可不给字节，客户端会重试）。
- **信任根不从服务器取**：公钥只随客户端包分发。若允许服务器下发公钥，能改这条链路的人（隧道节点、机房、
  被入侵的服务器）就能同时换掉公钥与内容 —— 签名退化成"自证"，等于任意代码执行通道。
- **多把公钥 = 多发布方**：任一把验过即通过；包里没有的那一家签的 `latest.json` 一律拒绝
  （实测：只放无关公钥时报 `发布信息的签名不对（更新源不可信或公钥不匹配）`）。新增发布方 = 往
  `update-pubkey.d\` 丢一个 `.pem`，不用改代码。
- 一把公钥都没有时只做 sha256 校验（弱一档）：启动器记日志「没有公钥：只报警，不自动接受」，`--insecure`
  链路直接拒绝运行。发行包务必带上公钥。

## 5. 回环测试（本地就能跑完的验收）

```bash
# 服务端（0.2.4 树）当更新源
SP_UPDATE_DIR=<发布目录> PORT=3100 HOST=127.0.0.1 node server/index.js &
node tools/make-update.mjs --to <0.2.4树> --from <0.2.3客户端app目录> --out <发布目录> \
  --url-base http://127.0.0.1:3100/update --no-art --key release-private.pem

# 客户端（0.2.3 包里的 app 目录）
node tools/update.mjs check --root <客户端app> --source http://127.0.0.1:3100 --pubkey update-pubkey.pem
node tools/update.mjs apply --root <客户端app> --source http://127.0.0.1:3100 --pubkey update-pubkey.pem --no-setup
node tools/update.mjs check --root <客户端app> --source http://127.0.0.1:3100 --pubkey update-pubkey.pem   # → current
```

2026-10-12 的实测（0.2.3-fusion-20p 客户端 → 0.2.4-fusion-20p 服务端树）：

| 场景 | 结果 |
| --- | --- |
| 自检（`check`） | `outdated`；1019 个受管文件 / 59 MB，`from` 含本机 ⇒ 可用更新包；签名校验通过 |
| 一键更新（更新包路径） | 下载 1.3 MB zip，写 97 个文件，删 41 个旧文件 → 版本 0.2.4，摘要与服务端逐字节一致 |
| 一键更新（逐文件路径，版本号相同） | 只取 6 个不一致的文件（53 KB）→ 摘要一致、`current` |
| 真实客户端只读自检（你手上那份 0.2.4） | `drifted`：8 个文件内容不同 + **素材指纹不一致（13718 个素材）** ⇒ 版本号看不出来的漂移 |
| 本机服务端在跑时更新 | 拒绝并提示先停服（启动器会自动停） |
| 更新包被篡改（同尺寸） | 拒绝：`sha256 不符` |
| 服务端给的字节被篡改（同尺寸） | 拒绝：`data/config.json: sha256 不符` |
| 服务端文件与清单大小不符 | `/update/file` → 503 |
| 伪造公钥 / 发布方比本机旧 / 更新源不在 | 签名不对报错 / `server-behind` 不降级 / 报错并静默 |
| 更新后重新启动本机服务端 | `/healthz`、页面、`/sim/`、`/packs/index.json` 全部正常；没配 SP_UPDATE_DIR 时 `/update/` 优雅降级（不是 500） |

## 6. 边界（这一版没做/不做的事）

- **素材不进摘要**（只比路径+大小）：`public/assets` 的变动靠素材指纹报警 + `setup.mjs`；更新包在**不带** `--no-art`
  时会把改动过的素材一起打进去（那才是完整的客户端更新包）。
- **`node_modules` 不在清单里**：服务端发布树本来就没有它；依赖升级要靠完整包（或自己装）。
- **`--from` 只认你自己渠道发出去的包**：上游 Releases 的 zip 装出来的目录与服务端全量树的基线不同，
  拿它当基线会算出成百上千个"改动"。
- **一次只跳到最新**：玩家从很老的版本（例如 0.2.1）过来时，若不在 `from` 里就走逐文件同步（大改版时文件多、
  走隧道慢）——需要时用完整包。
- 更新源的带宽/流量：zip 与逐文件同步都从服务器出，玩家多时注意出口带宽（可把 zip 放对象存储，`latest.json` 留服务器，
  地址写在 `latest.json` 的 `zip.url` 里）。
- 合并上游：这套新增/改动集中在 `server/http/update.js`、`server/updateSet.js`、`tools/update.mjs`、
  `tools/make-update.mjs` 与 `server/http/{routes,config}.js`、`server/index.js` 的挂钩处；上游若改
  `server/http/routes.js` 的路由表或 `serveDirs`，冲突点就在这两处。