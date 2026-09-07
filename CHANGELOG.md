# Changelog

本插件所有显著变更记录于此。格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；
发布纪律：**tag = release**（每个发布对应一个 GitHub 标签，自更新以标签 tarball 为源）。

## [0.2.7] — 2026-09-07

### 修复

- web-auth 桥拿不到 launch token（真机：桌面连接落在上游 401 文本页）：connection
  服务必须在**独立 inject(["connection""])** 中捕获——webServer 注入作用域只暴露
  声明的服务（cordis 语义），此前在 webServer 作用域读 connection 恒为 undefined，
  桥永远走退级分支。与 dsh-web-app 的 ctx.inject(["connection""], …) 同款姿势；
  旧版宿主无此服务则该 inject 永不触发，退级行为不变。捕获/缺失均记日志。
## [0.2.6] — 2026-09-07

### 新增

- **上游 web 认证桥** `/__remote/web-auth`（rc.1+ 宿主）：持设备凭证访问 → 302 到
  `/?token=<dsh web launchToken>` → 上游验 token 种 30 天会话 cookie → 落 / 直接可用。
  一次导航种齐「设备凭证 + 上游会话」两把 cookie，桌面远程连接不再卡上游登录墙
- pair 成功分支落点 `/` → `/__remote/web-auth`（相对路径，浏览器与桌面反代两种入口
  都解析到正确 origin）；旧版宿主（无 connection 服务）web-auth 自动退回 /，无害
- launch token 来源：宿主 rc.1+ 同 context 的 `connection` 服务（`launchToken` 字段），
  经 `webLaunchToken` 注入网关；启动日志里的 token 从此无需人工搬运

## [0.2.5] — 2026-09-04

### 修复

- 状态文件 flap 根治（二段）：双加载的幻影实例可能是「禁用」态（配置源不同，
  非启动失败），v0.2.2 的沉默规则盖不住。对账定时器改为只补写「持有中」态；
  enabled:false 只走事件路径（真实停用/卸载转换）——幻影禁用实例最多在启动时
  写一次 false，持有者的 30s 对账随即将文件稳定在真值

## [0.2.4] — 2026-09-04

### 修复

- exchange 验签自报设备名改御驿登记名：os.hostname() 与御符 ai_agents.hostname
  （御驿 Hub 心跳的 device 登记名）可能不同（实测 clawith-test 机器 OS 主机名
  为 clawith-73294942s4jbu），此前 sso-verify 必然 403。解析顺序与 dsh-yuyi 同源：
  remote.deviceName 配置 → YUYI_DEVICE 环境变量 → ~/.yuyi/env 的 YUYI_DEVICE →
  OS 主机名兜底

## [0.2.3] — 2026-09-04

### 新增

- 状态发布自证日志：gateway-state.json 每次内容变化记「网关状态已发布：…→路径」
  （含沉默分支与目标文件全路径）——双加载/路径错配类排障从猜日志变成直接读日志

## [0.2.2] — 2026-09-04

### 修复

- 双加载下状态文件 flap：启动失败（如另一实例已占用端口 EADDRINUSE）的实例
  不持有监听器，不再把 gateway-state.json 写成 enabled:false——状态文件只由
  实际持有网关的实例发布（omp 真机实测：双 30s 对账定时器互相覆盖导致
  address 上报时有时无）
- 网关启动失败此前静默吞掉（无任何日志痕迹）：现记录「网关启动失败：原因」

## [0.2.1] — 2026-09-04

### 修复

- 网关状态文件滞留态：事件驱动发布（restart/dispose 链）之外增加 30s 自愈对账——
  装配期 inject 回调与 apply 末尾的竞态、热重载次序反转等时序窗口不再导致
  「网关监听中但 gateway-state.json 停在 enabled:false」（omp 真机部署实测发现）

## [0.2.0] — 2026-09-04

### 新增

- **SSO 登录即连** `POST /__remote/exchange`：桌面端持御符 SSO JWT 调用 → 本机调御符
  sso-verify（验签 + uid==owner 一跳完成，形态 B：本插件不自持 jwtSecret/owner）→
  签发实例级短 TTL（24h）设备令牌，响应与配对同形状 `{ok, token, deviceId, name}`；
  按 IP 限速、跨站防护、坏正文/未配置/御符不可达分别映射 400/503/502
- **网关状态暴露** `gateway-state.json`（instance-address-report 契约 §1）：网关启停写
  `<dsh-home>/plugins/dsh-remote/gateway-state.json`（原子写 0600）——
  `{address, enabled:true, startedAt}` 或 `{enabled:false}`，yuyi 通道心跳透传给御符，
  `/me/instances` 的 address 由此有值；本插件不直连御符、不持任何御符凭证
- 配置项 `remote.ssoVerify`：御符 sso-verify 端点（默认内网 gateway）
- 设备令牌支持可选 `expiresAt`（实例级短 TTL 用；过期即 verify 失败、重启加载丢弃；
  配对码流令牌不受影响）

## [0.1.3] — 2026-08-29

### 修复

- 自更新换装回滚覆盖 package.json：旧元数据与旧 lib 一并移入备份目录 `lib.bak-<ts>`，
  换装后段失败（如 `.update-pending` 写入失败）时两者都还原。此前会留下
  「新 package.json + 旧 lib」，semver 守卫随即挡住重试
- `overlayEntries` 拒绝含反斜杠的条目路径：win32 把 `\` 当路径分隔符，
  `lib\..\..\evil.js` 形态可逃逸暂存区

### 变更

- tags API 请求加 `?per_page=100`（GitHub 默认仅返回 30 条，标签积累后会漏最新版本）

## [0.1.2] — 2026-08-29

### 新增

- 设置页自更新：「软件更新」分区支持检查更新（GitHub 标签 semver 比较）与一键更新；
  后台单飞执行，进度经 check 端点回报（`/dsh-remote/api/update/check`、`/dsh-remote/api/update/apply`）
- 自更新安全设计：符号链接安装（开发模式）拒绝就地覆盖；仅替换 `lib/**` 与 `package.json`
  （不动 cordis.patch.yml）；下载/解压/校验在 `.update-staging/` 完成后才换装，
  换装失败自动回滚（保留 `lib.bak-<ts>` 备份）；写 `.update-pending` 标记，重启 DSH 后生效
- 零新增运行时依赖：HTTPS 用 node:https（重定向/超时/体积上限），tar 用内置 512 字节头解析
- `scripts/boot-smoke.sh`：隔离 DSH_HOME + file:// patch 的启动冒烟（无 dsh CLI 时优雅跳过），并接入 CI
- 本 CHANGELOG

## [0.1.1] — 2026-08-29

### 新增

- 网关支持 `GET /__remote/pair?token=` 种浏览器 cookie（桌面壳对接）

### 测试

- pair?token= 用例补断言 touch 生效（lastSeenAt 前进）等测试加固

## [0.1.0] — 2026-08-28

### 新增

- 首个版本：配对认证网关（HTTP+WS 反代、设备管理、限速、设置页、CI）

