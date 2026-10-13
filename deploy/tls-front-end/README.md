# TLS 前端：隧道只放行 TLS 时，让明文游戏服务端也能被公网访问

## 为什么需要它

一些免费内网穿透节点（实测 SakuraFrp）会对 **TCP 隧道里的明文 HTTP** 做内容合规拦截：请求头一看是 HTTP，节点就直接回

```
HTTP/1.1 501 Not Implemented
Server: SakuraFrp
您正试图使用 HTTP 协议访问此隧道 …… 请使用 HTTPS 访问此隧道（或“自动 HTTPS”功能）
```

而**非 HTTP 的字节能正常穿过隧道**（可以自己验：往隧道端口手发一段不是 HTTP 的字节，回来的是你自己服务端的响应）。
所以问题是「明文 HTTP 被拦」，不是隧道不通、也不是服务端没起。

两个解法：

1. **面板侧「自动 HTTPS」**：TLS 在节点侧终止、用节点的正式证书，本地端口继续指向游戏服务端（3000）。最省事、客户端零证书警告；需要节点侧支持、且通常要实名/付费。
2. **本目录的 TLS 前端**（不需要动面板、不依赖节点功能）：在游戏服务端前面放一个极小的 TLS 终结器，把隧道来的 HTTPS/WSS 解开，**按字节**管道给明文的游戏服务端。HTTP 响应与 WebSocket 升级共用同一条管道，不需要任何协议感知。代价是自签证书 → 客户端首次会有一次证书提示。

## 怎么用

```bash
# 1) 自签证书（SAN 写你实际用的域名；内网穿透通常给多条线路域名，一并写上）
mkdir -p /opt/stronghold-tls && cd /opt/stronghold-tls
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout tls.key -out tls.crt \
  -subj "/CN=your-host.example" \
  -addext "subjectAltName=DNS:your-host.example,DNS:yd.your-host.example,DNS:dx.your-host.example,DNS:lt.your-host.example"
chmod 600 tls.key

# 2) 起前端（监听 3000 与 3443 两个端口：隧道的「本地端口」不管写哪个都能接住）
TLS_PORT=3000,3443 TARGET_HOST=127.0.0.1 TARGET_PORT=3001 node /opt/stronghold-tls/tls-proxy.mjs

# 3) 长期运行：用户级 systemd（见同目录 stronghold-tls.service，路径按需改）
systemctl --user enable --now stronghold-tls.service
```

游戏服务端本身建议只监听回环、端口错开（示例里是 `3001`），把面向公网的 `3000/3443` 留给 TLS 前端：

```bash
PORT=3001 HOST=127.0.0.1 node server/index.js
```

隧道那边的「本地地址/端口」写 `127.0.0.1:3000`（或 `3443`），公网就用 `https://<节点域名>:<端口>/`。
自测：

```bash
curl -sk https://127.0.0.1:3000/healthz        # 走 TLS 前端
curl -s  http://127.0.0.1:3001/healthz         # 直连游戏服务端（明文）
curl -sk https://<节点域名>:<端口>/healthz      # 绕公网一圈
```

## 客户端侧要了解的三件事

- **浏览器**：自签证书会提示一次不受信任，点继续即可（SAN 覆盖了你用的域名就不会报证书名不匹配）。
- **`启动器/`（薄壳）**：会问一次并把主机记进 `shell-state.json` 的 `trustedHosts`，之后不再问；
  健康探测同样走这套信任名单（注意用 `HttpWebRequest.RequestUri` 取主机 —— `Address` 在请求发出前是 null，用它会让回调自己抛异常，表现成“未能创建 SSL/TLS 安全通道”）。
- **命令行 `tools/update.mjs`**：`--insecure` 必须与 `--pubkey` 同时给 —— 传输不可信时，剩下的那道门是发布方的 ed25519 签名。

## 安全说明

- 私钥（`tls.key`）只留在服务端，权限 600；**不要**把任何私钥提交进仓库。
- 这个前端只做「TLS → 明文」的字节搬运，不解析 HTTP，也不做鉴权；真正的可信边界是更新通道的签名与游戏自身的会话协议。