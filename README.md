# dsh-remote — 带配对认证的远程访问网关

一个 dsh 插件：在 LAN / Tailscale 上开一个**带认证的网关端口**，把桌面客户端
（浏览器）的请求安全反代到本机回环上的 dsh webserver。手机/移动端不走这里——
归 `dsh-im-bot`（IM 通道）负责，两者分工明确。

## 为什么需要它

npm 上最新的 dsh（0.1.1-rc.2）webserver **没有任何认证**——谁能访问端口，谁就是
主人。局域网里挂一台陌生设备、或 Tailscale 上有别的节点时，这就是裸奔。
dsh-remote 的网关认证就是唯一防线：**默认关闭**，开启后所有请求必须持有效凭证。

**不带 TLS**：目标场景是 LAN（物理层即边界）+ Tailscale（WireGuard 已加密），
网关本身只听回环可达性之内的明文流量即可；TLS 归未来的隧道适配器在边缘终结
（见下方「隧道」）。

## 工作原理

```
浏览器/桌面客户端 ──HTTP/WS──▶ 网关 0.0.0.0:<port>
                                │  ① 配对认证：
                                │     · 一次性配对码：10 分钟有效、单次使用、只存内存
                                │     · 设备令牌：256-bit 熵，本地只存 sha256 指纹
                                │     · 坏令牌限速 30 次/分；配对端点限速 10 次/分
                                │  ② 全量反代到 127.0.0.1 的 dsh webserver：
                                │     Host/Origin/Referer 改写、hop-by-hop 头剥离、
                                │     WebSocket（含 /api/events.mux）双向透传
                                ▼
                          dsh webserver（回环）
```

## 安装与快速开始

```sh
# 从插件源码目录，或直接用远程：
dsh plugin --profile web add ./dsh-remote          # 本地目录
dsh plugin --profile web add git+https://github.com/lomehong/dsh-remote.git   # 远程
```

装完重启 dsh，然后：

1. 打开 设置 → **远程访问** Tab，开启开关；
2. 点「生成配对链接」；
3. 在目标设备的浏览器打开该链接 → 设备自动换取令牌并记住登录；
4. 之后该设备直接访问 `http://<主机>:<port>` 即全量使用 dsh。

`lib/` 构建产物随仓库提交，git 安装**无需本地构建**。

## WAN 场景：Tailscale

两端装 Tailscale 组网后，把 settings.yaml 里 `remote.bind` 填成主机的
`100.x.x.x` 地址，端口就只暴露在组网内、不碰物理 LAN——这是推荐的跨网用法。

## 配置参考

settings.yaml 的 `remote:` 节（**热重载**，改完即生效，无需重启）：

```yaml
remote:
  enabled: false     # 默认关闭
  port: 3090
  bind: 0.0.0.0      # WAN 场景建议填 Tailscale 的 100.x IP
```

已配对设备持久化在 `$DSH_HOME/dsh-remote/devices.json`（0600 权限、原子写，
**只存令牌指纹，不存令牌本体**）。可在「远程访问」Tab 里逐台移除。

## dsh-desktop 对接（API 契约）

桌面客户端二期可直接走同一套配对流程：

```
POST /__remote/pair        body: {"code": "<一次性配对码>"}
→ 200 {"ok": true, "token": "<设备令牌>", "deviceId": "...", "name": "..."}

之后所有请求带请求头：      x-remote-token: <设备令牌>
（WebSocket 握手请求同样带该头）
```

`GET /__remote/pair?code=...` 是浏览器流（303 + cookie），桌面用 POST JSON 流。

已持 token 的桌面壳（如 webview 无 cookie 场景）可用
`GET /__remote/pair?token=<设备令牌>` 为浏览器种 cookie：303 + Set-Cookie 同值，
不新建设备、仅 touch 原设备；无效 token → 403（与错误码同分支，计入配对限速）。

## 已知边界

- **配对设备 = 完全主人权限**：dsh 本身没有用户体系，网关认证只做「进不进来」，
  不做「进来能干什么」。只把配对链接发给你完全信任的设备。
- **远端设备共享同一个 dsh 会话**，没有按设备隔离。
- **无降权访客模式**：访客/受限场景归 `dsh-twin` 的 IM 通道（主人/访客双视图），
  本插件不解决这件事。
- **配置修改的保存通道是宿主设置页的 `remote` 节**：「远程访问」Tab 里的控件
  只是镜像，真正的读写走 settings。

## 隧道

`src/tunnel.ts` 目前只是接口占位；frp / cloudflared 适配器为一期**不实现**的范围。
未来实现时 TLS 在隧道边缘终结，网关仍保持明文。

## 开发

```sh
git clone https://github.com/lomehong/dsh-remote.git
cd dsh-remote
npm install
npm test            # vitest：41 个行为锁定测试（直接跑 src/*.ts 源码）
npm run typecheck   # tsc 严格类型检查（宿主端 + 客户端）
npm run build       # tsc 编译 src/ → lib/ + esbuild 重建 lib/client.js
```

- 宿主端源码是 TypeScript，`lib/*.js` 是 tsc 构建产物，类型声明在 `lib/types/`；
  客户端 bundle 用 esbuild 输出 `lib/client.js`。
- `lib/` 随仓库提交（git 安装无需本地构建）。

## 许可

MIT
