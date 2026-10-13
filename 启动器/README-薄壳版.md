# 卫戍协议：盟约 —— 桌面启动器（薄壳版：.NET Framework + 系统 WebView2 内核）

exe 约 **1 MB**，浏览器内核用**系统自带的 WebView2（Edge / Chromium）**，Node 复用便携包里的
`node\node.exe`，游戏本体**不复制**——所以**项目更新只替换 `app\`（或 `git pull` + `node tools/setup.mjs`），这个 exe 不用重打包**。

```
StrongholdShell.exe                 ~62 KB   ← 启动器本体（已嵌图标）
Microsoft.Web.WebView2.Core.dll     682 KB   ┐
Microsoft.Web.WebView2.WinForms.dll  38 KB   │  WebView2 托管依赖（NuGet 的 net462 版）
WebView2Loader.dll                  190 KB   ┘  原生加载器（x64）
```

---

## 1. 摆放方式

**推荐：4 个文件直接丢进官方便携包根目录**（和 `app\`、`node\`、`启动游戏.bat` 同级）：

```
Stronghold-Protocol-Windows\
├─ StrongholdShell.exe            ← 双击它玩（不再需要「启动游戏.bat」）
├─ Microsoft.Web.WebView2.*.dll
├─ WebView2Loader.dll
├─ app\                           ← 游戏本体（更新只动这里）
├─ node\node.exe                  ← Node 22 便携版
└─ 启动游戏.bat                   ← 官方入口，仍然可用（浏览器版）
```

**或者：外壳单独放一个目录**（**本发行包就是这样**：`sp-thin-shell\` 与 `app\`、`node\` 同级），
在 exe 旁写 `shell.json` 指路 —— **用相对路径，指针跟着 exe 走，换台电脑 / 换个解压位置都不用改**：

```json
{ "gameRoot": "../app", "port": 3000 }
```

查找顺序：`--game` → 环境变量 `SP_GAME_ROOT` → `shell.json`（**相对路径按 exe 自己所在目录解析**）→
`exe同级\app` → `exe同级\game` → `exe上一级\Stronghold-Protocol-Windows\app` → `exe上一级\app`。
（`shell.json` 里写的路径万一不存在，会自动落到后面的候选，不会因为配置写错就打不开。）

> **打包分发 / 开包即用**
> 把整个包（`app\`、`node\`、`sp-thin-shell\`、`LICENSE`、`NOTICE.md`、`THIRD-PARTY-NOTICES.md`）原样压缩发出即可。
> 收包人解压到**任意路径**、双击 `sp-thin-shell\StrongholdShell.exe` 就能玩，**不需要改任何路径** ——
> `../app` 是相对 exe 自己解析的（已用「换一个完全不同的绝对路径」实测验证：`gameRoot` 正确指向新位置的 `app\`，游戏正常启动）。
> 发之前把 `shell-state.json` 清空成 `{"defaultServer":"","trustedHosts":""}`
> —— 它是**每台机器自己的状态**（记住的服务器 + 已信任证书的主机），不清会把你这边的服务器和信任记录带给别人。
> `shell.log` 是运行日志，发之前删掉即可（运行时自动重建）。
> 若把 4 个文件直接丢进包根目录（与 `app\` 同级），`shell.json` 可以删掉 —— 会自动找到 `app\`。

---

## 2. 怎么用（窗口内就能配服务器）

| 菜单位置 | 内容 |
| --- | --- |
| **设置(&S)** | **联机服务器地址…**（手动填服务器）/ 连接本机服务器（自己开服）/ 测试当前服务器连通性 / 清除记住的服务器 / 打开日志 |
| 联机(&N) | 复制本机联机地址 / 用系统浏览器打开当前地址 / 重新探测局域网地址 |
| 视图(&V) | 刷新(F5) / 全屏(F11) |
| 帮助(&H) | 打开游戏目录 / 打开日志 / 关于 |

**连别人的服务器**：`设置 → 联机服务器地址…` → 填地址（例：`https://frp-say.com:17763` 或 `192.168.1.23:3000`）
→ 勾「记住为默认」→ 连接。之后每次启动直接进那个服务器。
窗口标题和状态栏会显示**当前连接的服务器地址**；没连上时显示本机 IP。

```
StrongholdShell.exe                                   默认本机模式
StrongholdShell.exe --connect https://frp-say.com:17763   直连指定服务器（本机不起服）
StrongholdShell.exe --local                           强制本机模式
StrongholdShell.exe --port 3010                       本机模式起始端口
StrongholdShell.exe --smoke [--smoke-out f --smoke-png f]  自检后退出
```

状态栏：`已连接 · 远端 frp-say.com:17763 ｜ 本机 IP 192.168.2.97 ｜ 点击地址可复制`
本机模式时右侧变成可复制的**局域网联机地址**（`http://192.168.2.97:3000`）。

其他行为：可**复用已在跑的服务端**（用 `启动游戏.bat` 开过服就直接连上，关窗口不会杀它）；
端口自愈（3000 被占依次试 3001–3009）；存档在 `%LOCALAPPDATA%\StrongholdShell\WebView2`；
日志 `shell.log`（含 node 的 stdout/stderr）。

---

## 3. 两个已踩过的坑（这版专门修了）

### 3.1 自签名 / 不受信任证书（自建、frp 隧道最常见）

浏览器打开 `https://你的服务器:端口` 时，浏览器会弹「证书不受信任，是否继续」让你点过去；
**WebView2 没有这个 UI**，导航直接失败（`CertificateIsInvalid`），表现就是「浏览器能连、exe 连不上」。

修法：处理 `CoreWebView2.ServerCertificateErrorDetected` ——
局域网/回环地址直接放行；**公网地址问一次**「这是你正在连的联机服务器吗？」，
点「是」后把该主机记进 `shell-state.json` 的 `trustedHosts`，以后不再问。
`shell-state.json` 长这样：

```json
{ "defaultServer": "https://frp-say.com:17763/", "trustedHosts": "frp-say.com" }
```

同时给 .NET 侧的健康探测装了同样的证书回调，否则会出现「页面能开、状态栏却显示未连接」。

### 3.2 首次导航到局域网地址被 abort（系统代理的时序问题）

本机开着 Clash / v2ray 之类系统代理时，WebView2 **第一次**导航到 `http://192.168.x.x:3000`
可能报 `ERR_CONNECTION_ABORTED`（代理配置还没解析完就发出去了）。
实测 `--proxy-bypass-list` / `--no-proxy-server` 都不解决（WebView2 会忽略这类代理开关），
**改成「失败自动重试（最多 3 次、间隔 900ms）」后正常**。代理本身保持系统设置，与系统浏览器一致。

---

## 4. 实测记录

| 场景 | 结果 |
| --- | --- |
| **连你现在的服务器 `https://frp-say.com:17763`** | ✅ 页面完整启动（`appBooted=true`），标题「卫戍协议：盟约 · frp-say.com:17763」，状态栏「已连接 · 远端 frp-say.com:17763」，页面显示「● 已连接服务器」，`/healthz` 里 `sockets` 增加 → **WebSocket 通过隧道连上了** |
| 证书处理 | 首次 `certErrors=1 CertificateIsInvalid` → 信任 → 写入 `trustedHosts=frp-say.com`；第二次启动直接放行（`allow=True`，不再询问） |
| 局域网服务器（`192.168.2.97:3050/3600`） | ✅ 启动完整（靠 3.2 的重试） |
| 本机自己开服 | ✅ 起服务端 + 加载 `127.0.0.1:<port>`，标题显示局域网 IP:端口 |
| 复用已在跑的服务端 | ✅ `weStartedServer=false`，关窗口不杀别人的服务端 |
| 连不存在的服务器 | ✅ 3 次重试后给可读错误页，标题回退显示本机 IP |
| WebView2 运行时 | 154.0.4258.62（本机已装；缺失时启动器给官方安装链接或改用系统浏览器） |

---

## 5. 编译（不需要 .NET SDK / Visual Studio）

用 Windows **自带的** `csc.exe`（.NET Framework 4.8，C# 5）：

```bash
bash build-shell.sh
# C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe /nologo /target:winexe /platform:x64 \
#   /codepage:65001 /optimize+ /out:StrongholdShell.exe /win32icon:icon.ico \
#   /r:System.dll /r:System.Core.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll \
#   /r:Microsoft.Web.WebView2.Core.dll /r:Microsoft.Web.WebView2.WinForms.dll Shell.cs
```

- **必须带 `/codepage:65001`**，否则 csc 按系统代码页读源码会把中文变成乱码。
- 三个 WebView2 依赖来自 NuGet 包 `Microsoft.Web.WebView2`（这里用 1.0.4258.31，与本机运行时同分支）：
  `lib/net462/Microsoft.Web.WebView2.Core.dll`、`lib/net462/Microsoft.Web.WebView2.WinForms.dll`、
  `runtimes/win-x64/native/WebView2Loader.dll`。
- 目标机器要求：**.NET Framework 4.8**（Win10 1903+/Win11 内置）+ **WebView2 运行时**（Win11 内置），都不用额外装。

---

## 6. 文件清单

| 文件 | 说明 |
| --- | --- |
| `Shell.cs` | 启动器源码（WinForms + WebView2，C# 5） |
| `build-shell.sh` | 编译脚本 |
| `StrongholdShell.exe` | 编好的启动器（~62 KB，已嵌图标） |
| `Microsoft.Web.WebView2.Core.dll` / `.WinForms.dll` / `WebView2Loader.dll` | WebView2 依赖（必须和 exe 放一起） |
| `icon.ico` | 图标 |
| `shell.json` | 可选：`gameRoot` / `port` / `server` |
| `shell-state.json` | 启动器自己写：`defaultServer`（记住的服务器）+ `trustedHosts`（已信任证书的主机） |

---

## 7. 版本自检与一键更新（可选）

启动器可以对**你连的服务器**做版本自检，落后时一键更新（服务端要有 `/update/` 端点族，见 `docs/UPDATE.md`）。

- 启动后静默自检一次（更新源不可达不影响玩）：状态栏右侧显示 `vX · 已是最新`，落后时显示
  `有新版本 vY（本机 vX）· 点此一键更新`（点一下即更新；更新前自动停掉自己起的服务端，完成后重启窗口）。
  版本号一样但内容不一致时显示 `内容与服务器不一致（N 个文件）· 点此一键更新`。
- 菜单：`设置 → 检查更新…` / `设置 → 一键更新到最新…`。命令行：`--check-update` / `--update [--update-no-setup]`。
- 更新源：`--update-source` > 环境变量 `SP_UPDATE_SOURCE` > `shell.json` 的 `updateSource` > **当前连的服务器** > 记住的服务器。

### 信任根（公钥）放在哪

更新通道的信任根是发布方的 **ed25519 公钥**，只能随客户端包分发（**刻意不从服务器取** —— 否则能改这条链路的人
就能同时换掉公钥与内容，签名退化成自证）。可放**多把**（多发布方共存，任一把验过即通过），查找顺序：

1. `--pubkey`（可重复，文件或目录）
2. 环境变量 `SP_UPDATE_PUBKEY`（可多个，用系统路径分隔符）
3. `启动器\update-pubkey.d\*.pem`（按文件名排序）与 `启动器\update-pubkey.pem`
4. **客户端包根目录**（`app\` 的上一级）的 `update-pubkey.d\*.pem` 与 `update-pubkey.pem`

```text
Stronghold-Protocol-Windows\
├─ 启动器\
│  ├─ 启动游戏.exe
│  └─ update-pubkey.d\           ← 信任根放这儿
│     └─ stronghold.pem          ← 你服务器的发布公钥（文件名随意，*.pem 都读）
├─ update-pubkey.d\              ← 也可以放包根目录（app\ 的上一级）
│  └─ stronghold.pem
└─ app\                          ← 更新只动这里；刻意不看 app\ 里的公钥
```

自检报告会写清是**哪一把**验过的：`签名：通过（公钥 …\update-pubkey.d\stronghold.pem，指纹 407a92fe…；候选 N 把）`。
包里没有的那一家签的发布信息一律拒绝：`发布信息的签名不对（更新源不可信或公钥不匹配）`。

---

## 8. 许可提醒

非官方同人作品，素材版权归上海鹰角网络 / Yostar，**严禁任何形式的盈利**，素材**不得单独再分发**。
`app\` 里的 `NOTICE.md` / `LICENSE` / `THIRD-PARTY-NOTICES.md` 不要删。