/**
 * dsh-remote：远程访问插件。
 *
 * - 网关：webServer 服务在位且 remote.enabled 时，起独立 HTTP 网关（默认 0.0.0.0:3090），
 *   带配对认证，一切请求反代到回环 dsh webserver（见 gateway.ts / proxy.ts）；
 *   /__remote/exchange 支持御符 SSO 登录即连（sso-verify 验签 → 签 24h 实例令牌）
 * - 状态暴露：网关启停写 <dsh-home>/plugins/dsh-remote/gateway-state.json（state.ts），
 *   yuyi 通道心跳透传给御符 → /me/instances 的 address（instance-address-report 契约）
 * - 本地管理：dsh webserver 上的 /dsh-remote/api/*（状态 / 生成配对链接 / 设备管理 / 自更新检查与应用），
 *   供设置页「远程访问」Tab 使用；name/ua 是不可信输入（截断已做，暴露前再剥 tokenHash）
 * - 自更新：GitHub 标签 tarball 覆盖 lib/** + package.json（见 update.ts；
 *   符号链接安装拒绝，暂存校验 + 备份回滚，重启 DSH 后生效）
 * - 配置：settings.yaml 的 remote: 节，热重载（enabled/port/bind 变更即重建网关）
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
// 纯类型导入：载入 @deepseek-ai/dsh-settings 对 Context 的 `.settings` 增补
// （alpha.2 起 settingsNamespace()/installSettingsSection() 已移除，须经此取服务）。
import type {} from '@deepseek-ai/dsh-settings'
import { normalizeConfigInput, REMOTE_DEFAULTS, type RemoteConfig } from './config.ts'
import { PairingStore } from './tokens.ts'
import { loadDevices, type DeviceRecord } from './devices.ts'
import { listAddresses, type AddressInfo } from './addresses.ts'
import { startGateway, type GatewayHandle } from './gateway.ts'
import { advertisedAddress, gatewayStatePath, writeGatewayState } from './state.ts'
import { verifySsoJwt } from './sso.ts'
import { resolveDeviceName } from './hostname.ts'
import type { Upstream } from './proxy.ts'
import * as updater from './update.ts'

export const name = 'dsh-remote'

export const Config = z.object({
  enabled: z.boolean().default(false).description('启用远程访问网关（默认关闭）'),
  port: z.number().default(3090).description('网关监听端口'),
  bind: z.string().default('0.0.0.0').description('绑定地址（可改为 Tailscale IP 等单接口地址）'),
  ssoVerify: z.string().default(REMOTE_DEFAULTS.ssoVerify).description('御符 sso-verify 验签端点（SSO 登录即连）'),
  deviceName: z.string().default('').description('sso-verify 自报设备名（御驿 device 登记名；留空自动解析 YUYI_DEVICE → ~/.yuyi/env → OS 主机名）'),
})

// alpha.2 起模块级 settingsNamespace()/installSettingsSection() 移除：命名空间用裸
// 字符串（类型层 SettingsNamespaceInput 校验），经 inject(['settings']) 取提供方再
// 调 SettingsProvider.installSection()。
const NS = 'remote'

/** 测试可覆盖的 DSH home：优先专用环境变量，其次宿主 DSH_HOME，兜底 ~/.dsh（对齐 model-failover）。 */
export function dshHome(): string {
  return process.env.DSH_REMOTE_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

interface WebServerLike {
  host?: string
  port?: number
  register: (route: { kind: 'exact'; path: string; handler: (req: ReqLike, res: ResLike) => void | Promise<void> }) => () => void
}
/** rc.1+ 宿主在同一 context 上提供的 web 连接服务（launch token 持有者）。
 * 字段缺失 = 旧版宿主（无 web 认证桥，web-auth 端点自动退化为直落 /）。 */
interface ConnectionLike {
  launchToken?: string
  authenticatedUrl?: (baseUrl: string) => string
}
interface ScopedCtx {
  webServer: WebServerLike
  connection?: ConnectionLike
  effect: (fn: () => () => void) => void
}

interface ReqLike {
  method?: string
  headers: Record<string, string | string[] | undefined>
  on: (event: string, cb: (chunk?: Buffer) => void) => void
}

interface ResLike {
  writeHead: (status: number, headers: Record<string, string>) => void
  end: (body: string) => void
}

/** 管理请求体是小型 JSON，超限直接拒绝（防异常请求撑爆内存）。 */
const MAX_BODY_BYTES = 64 * 1024

function readBody(req: ReqLike): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk) => {
      if (chunk === undefined) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('请求体超过 64KB 上限'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: ResLike, status: number, payload: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 跨站写入防护：带 Origin 的请求必须同源（浏览器 POST fetch 亦带 Origin，须匹配）。 */
function sameOrigin(req: ReqLike): boolean {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    return new URL(String(origin)).host === host
  } catch {
    return false
  }
}

/** 设备记录脱敏：绝不暴露 tokenHash / ua（ua 是不可信输入，客户端不需要它）。 */
function redact(d: DeviceRecord): { id: string; name: string; createdAt: number; lastSeenAt: number } {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt }
}

export async function apply(ctx: Context, config: RemoteConfig): Promise<void> {
  // 优先宿主 logger（直写 stdout 会与其重复）；logger 缺席时退回直写。
  // 注意必须以成员调用 logger.info(line) 保持 this 绑定——cordis LoggerService
  // 的方法依赖 this，摘出函数引用 detached 调用会抛 TypeError 并被 cordis 升级为 fatal
  const log: (line: string) => void = (() => {
    try {
      const logger = (ctx as { logger?: { info?: (line: string) => void } }).logger
      if (logger !== undefined && typeof logger.info === 'function') {
        const info = logger.info.bind(logger)
        return (line: string) => {
          try { info(line) } catch { /* ignore */ }
        }
      }
    } catch { /* ignore */ }
    return (line: string) => { process.stdout.write(`[dsh-remote] ${line}\n`) }
  })()

  // 自更新「待重启生效」标记：进程能加载新代码走到这里，即视为已生效（best-effort 清除）
  try {
    updater.clearPendingMarker(updater.packageDir())
  } catch { /* 标记残留仅影响 UI 提示，不致命 */ }

  // ── 访问日志：环形缓冲（供设置页排查「谁连过」），记录同时打 log ──
  const accessLog: string[] = []
  const record = (line: string): void => {
    log(line)
    accessLog.push(`${new Date().toISOString()} ${line}`)
    if (accessLog.length > 100) accessLog.shift()
  }

  // ── 运行时状态 ──
  const store = await loadDevices(dshHome())
  const pairings = new PairingStore()
  const rt: RemoteConfig = normalizeConfigInput(config)
  let upstream: Upstream | undefined
  let gateway: GatewayHandle | undefined
  let gatewayStartedAt = 0
  /** rc.1+ 宿主 web 连接服务（webServer 注入时捕获；launch token 持有者）。 */
  let webConnection: ConnectionLike | undefined

  // 启动失败标记：本实例未持有监听器时（如双加载下另一实例已占用端口），
  // 无权把状态文件写成 enabled:false（omp 真机实测：双实例 flap 互相覆盖）。
  let lastStartFailed = false
  // 发布去重记录：状态变化才记日志（30s 对账不刷屏），排障时可直接看到谁在写什么
  let lastPublished = ''

  /**
   * 状态暴露（instance-address-report 契约 §1）：按当前网关实况写 gateway-state.json，
   * yuyi 心跳透传给御符 → /me/instances 的 address。
   * 失败只记录不阻断——状态文件是旁路产物，绝不影响网关本身。
   */
  const publishState = (): void => {
    try {
      let payload: string | undefined
      if (gateway !== undefined) {
        const address = advertisedAddress(rt.bind, gateway.port)
        const state = {
          enabled: true,
          startedAt: gatewayStartedAt,
          ...(address !== undefined ? { address } : {}),
        }
        writeGatewayState(dshHome(), state)
        payload = JSON.stringify(state)
      } else if (!lastStartFailed) {
        // 仅在「本应无网关」时写停用；启动失败的实例不持有监听器，保持沉默
        writeGatewayState(dshHome(), { enabled: false })
        payload = '{"enabled":false}'
      } else {
        payload = '(沉默：本实例未持有监听器)'
      }
      if (payload !== lastPublished) {
        lastPublished = payload
        record(`网关状态已发布：${payload} → ${gatewayStatePath(dshHome())}`)
      }
    } catch (error) {
      record(`网关状态文件写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // 当前注入作用域的卸载闩（按作用域一份）：webServer 服务可能被卸载后重新提供
  // （如改端口热重载），cordis 会先跑旧作用域清理、再重新注入——apply 级永久闩会让
  // 新作用域永远跳过启动。restartGateway 只看「当前作用域」的闩。
  let currentScope: { disposed: boolean } | undefined

  // 网关生命周期：关闭旧实例 → enabled 且 upstream 在位时重新拉起。
  // 串行化重启（装配期 inject 回调与 apply 末尾可能各触发一次），避免并发双监听
  let restarting: Promise<void> = Promise.resolve()
  const restartGateway = (): Promise<void> => {
    restarting = restarting.catch(() => {}).then(async () => {
      if (currentScope !== undefined && currentScope.disposed) {
        record('跳过网关启动：当前作用域已卸载')
        return
      }
      if (gateway !== undefined) {
        const old = gateway
        gateway = undefined
        await old.close()
      }
      if (rt.enabled && upstream !== undefined) {
        let handle: GatewayHandle
        try {
          handle = await startGateway({
            bind: rt.bind,
            port: rt.port,
            upstream,
            store,
            pairings,
            // SSO 登录即连：验签走御符 sso-verify（形态 B：dsh-remote 不自持 jwtSecret/owner）
            // 自报御驿 device 登记名（非 OS 主机名——sso-verify 按 ai_agents.hostname 匹配）
            verifySso: (jwt) => verifySsoJwt(rt.ssoVerify, jwt, resolveDeviceName(rt.deviceName)),
            // rc.1+ web 认证桥：/__remote/web-auth 302 到 /?token=<launchToken> 种上游会话
            webLaunchToken: () => {
              const conn = webConnection
              if (conn === undefined) return undefined
              if (typeof conn.launchToken === 'string' && conn.launchToken !== '') return conn.launchToken
              // rc.1 字段形态兜底：authenticatedUrl 公开方法内部读真正的 token——
              // 借任意 base 生成完整认证 URL 后抽出 token 参数
              if (typeof conn.authenticatedUrl === 'function') {
                try {
                  const u = new URL(conn.authenticatedUrl('http://127.0.0.1:3080'))
                  return u.searchParams.get('token') ?? undefined
                } catch {
                  return undefined
                }
              }
              return undefined
            },
            webAuthLog: record,
            log: record,
          })
        } catch (error) {
          // 启动失败（典型：双加载下另一实例已占用端口 → EADDRINUSE）。
          // 必须记日志（此前静默吞掉，排障时无任何痕迹）；本实例不持有监听器，
          // 状态文件保持沉默（publishState 见 lastStartFailed 跳过 enabled:false 写入）。
          lastStartFailed = true
          record(`网关启动失败：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        lastStartFailed = false
        if (currentScope === undefined || currentScope.disposed) {
          // startGateway await 期间发生了卸载：立即关闭，不落引用（防孤儿监听）
          await handle.close()
          record('网关已创建但作用域已卸载，立即关闭')
          return
        }
        gateway = handle
        gatewayStartedAt = Date.now()
        record(`网关已监听 ${rt.bind}:${gateway.port}`)
      }
      publishState()
    })
    return restarting
  }

  // ── 配置来源：settings 节（热重载），组合层 config 为基线 ──
  // alpha.2 起模块级 installSettingsSection() 移除：经 inject(['settings']) 取提供方，
  // 调用 SettingsProvider.installSection()（hooks 形状不变，参考 dsh-yuyi 的迁移）。
  let readConfig: () => RemoteConfig = () => config
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, NS, Config, config, {
      setSource: (source: () => RemoteConfig) => { readConfig = source },
      onChange: () => {
        void (async () => {
          Object.assign(rt, normalizeConfigInput(readConfig()))
          await restartGateway()
          record(`配置已应用：${rt.enabled ? `启用（${rt.bind}:${rt.port}）` : '停用'}`)
        })().catch((error) => {
          record(`配置变更应用失败：${error instanceof Error ? error.message : String(error)}`)
        })
      },
    })
  })

  // ── 本地管理 API（webServer 在位时；供设置页「远程访问」Tab 使用） ──
  ctx.inject(['webServer'], (scoped: unknown) => {
    const web = scoped as unknown as ScopedCtx
    // 新作用域：换 upstream（重注入可能带新端口）+ 重置卸载闩
    const scope = { disposed: false }
    currentScope = scope
    upstream = { host: web.webServer.host ?? '127.0.0.1', port: web.webServer.port ?? 3080 }
    const disposers: Array<() => void> = []

    // 统一防逃逸包装：处理器任何异常/拒绝都拦在 handler 内转 500——
    // 逃逸到 webserver 的异常会被 cordis 升级为 fatal 杀死整个进程（实测）
    const safe = (handler: (req: ReqLike, res: ResLike) => void | Promise<void>): ((req: ReqLike, res: ResLike) => Promise<void>) => {
      return async (req, res) => {
        try {
          await handler(req, res)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          record(`管理 API 处理器异常：${message}`)
          try { sendJson(res, 500, { ok: false, error: message }) } catch { /* 响应头已发出 */ }
        }
      }
    }

    // GET /dsh-remote/api/status：网关状态 + 地址枚举 + 设备（脱敏）+ 访问日志尾部
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/status', handler: safe((_req, res) => {
      sendJson(res, 200, {
        ok: true,
        enabled: rt.enabled,
        listening: gateway !== undefined,
        gatewayPort: gateway?.port,
        port: rt.port,
        bind: rt.bind,
        addresses: listAddresses(),
        devices: store.list().map(redact),
        log: accessLog.slice(-50),
      })
    }) }))

    // POST /dsh-remote/api/pairing：生成配对码 + 每个可达地址上的配对链接
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/pairing', handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      if (!rt.enabled || gateway === undefined) {
        sendJson(res, 409, { ok: false, error: '网关未启用' })
        return
      }
      const gw = gateway // 收窄进闭包（gateway 是可变绑定）
      const pairing = pairings.create()
      const links = listAddresses().map((info: AddressInfo) => ({
        ...info,
        url: `http://${info.ip}:${gw.port}/__remote/pair?code=${encodeURIComponent(pairing.code)}`,
      }))
      sendJson(res, 200, { ok: true, code: pairing.code, expiresAt: pairing.expiresAt, links })
    }) }))

    // POST /dsh-remote/api/devices/rename：{id, name}（name 截断 60 字符，不可信输入）
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/devices/rename', handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      let body: { id?: unknown; name?: unknown }
      try {
        body = JSON.parse(await readBody(req)) as { id?: unknown; name?: unknown }
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const id = typeof body.id === 'string' ? body.id : ''
      // name 是不可信输入：trim 后剥离控制字符/换行（防经环形日志注入伪造日志行），再截断 60
      const name = typeof body.name === 'string' ? body.name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60) : ''
      if (id === '' || name === '') {
        sendJson(res, 400, { ok: false, error: 'id 与 name（1-60 字符）必填' })
        return
      }
      if (!store.rename(id, name)) {
        sendJson(res, 404, { ok: false, error: '设备不存在' })
        return
      }
      sendJson(res, 200, { ok: true })
    }) }))

    // POST /dsh-remote/api/devices/revoke：{id} → 吊销（凭证即失效）
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/devices/revoke', handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      let body: { id?: unknown }
      try {
        body = JSON.parse(await readBody(req)) as { id?: unknown }
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const id = typeof body.id === 'string' ? body.id : ''
      if (id === '') {
        sendJson(res, 400, { ok: false, error: 'id 必填' })
        return
      }
      if (!store.revoke(id)) {
        sendJson(res, 404, { ok: false, error: '设备不存在' })
        return
      }
      sendJson(res, 200, { ok: true })
    }) }))

    // GET /dsh-remote/api/devices：设备列表（脱敏后）
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/devices', handler: safe((_req, res) => {
      sendJson(res, 200, { ok: true, devices: store.list().map(redact) })
    }) }))

    // GET /dsh-remote/api/update/check：当前版本 + GitHub 最新标签 + 更新任务进度。
    // GitHub 不可达时不抛 500——照常返回当前版本并附 checkError，设置页保持可用。
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/update/check', handler: safe(async (req, res) => {
      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      const st = updater.updateStatus()
      const base = { ok: true, applying: st.applying, lastError: st.lastError, pendingVersion: updater.pendingVersion(updater.packageDir()) }
      let current = ''
      try {
        current = updater.currentVersion(updater.packageDir())
      } catch { /* package.json 异常：仍尽力返回其余字段 */ }
      try {
        const latest = await updater.latestTag(current)
        sendJson(res, 200, { ...base, current, latest, updateAvailable: latest !== null })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        sendJson(res, 200, { ...base, current, latest: null, updateAvailable: false, checkError: `检查失败：${message}` })
      }
    }) }))

    // POST /dsh-remote/api/update/apply：{tag} → 后台应用更新（单飞；进度经 check 端点回报）
    disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/update/apply', handler: safe(async (req, res) => {
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return
      }
      if (!sameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin denied' })
        return
      }
      let body: { tag?: unknown }
      try {
        body = JSON.parse(await readBody(req)) as { tag?: unknown }
      } catch {
        sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      const tag = typeof body.tag === 'string' ? body.tag : ''
      // tag 是不可信输入：收紧为合法标签形态（v数字 + 有限字符）
      if (!/^v\d[\w.\-]{0,30}$/.test(tag)) {
        sendJson(res, 400, { ok: false, error: '非法版本标签' })
        return
      }
      if (updater.updateStatus().applying) {
        sendJson(res, 409, { ok: false, error: '更新已在进行中' })
        return
      }
      record(`收到自更新请求：${tag}`)
      // 后台执行：异常已在 applyUpdate 内记录（phase=失败/lastError），由 check 端点呈现
      void updater.applyUpdate(tag, record).catch(() => { /* 已记录 */ })
      sendJson(res, 200, { ok: true })
    }) }))

    // 卸载：路由全部注销 + 网关关闭。
    // 先置本作用域闩挡住本作用域的后续启动，再经同一条重启链关闭网关——保证与
    // in-flight 的 startGateway 串行，不会留下孤儿监听。
    // 次序假设：cordis 重注入时先跑旧作用域清理、再执行新注入。若旧清理因事件顺序
    // 反而晚于新注入执行，此处以「仍是否为当前作用域」判定：不是则不动网关——
    // 新作用域的 restartGateway 自会经链关闭旧网关并按新 upstream 拉起。
    web.effect(() => () => {
      scope.disposed = true
      for (const dispose of disposers) dispose()
      void restarting.catch(() => {}).then(async () => {
        if (currentScope !== scope) return
        if (gateway !== undefined) {
          const old = gateway
          gateway = undefined
          await old.close()
          publishState() // 卸载即声明停用（yuyi 下次心跳带 enabled:false）
        }
      })
    })

    // webServer 就绪（含热插拔出现）：按当前配置拉起网关
    void restartGateway()
  })

  // ── rc.1+ web 认证桥的 token 来源：单独注入 connection 服务（与 dsh-web-app
  // 同款姿势 ctx.inject(["connection"], …)——webServer 作用域里读不到它，实测踩坑）。
  // 旧版宿主无此服务 → 本 inject 永不触发 → webConnection 保持 undefined，
  // /__remote/web-auth 自动退化为直落 /（无害）。
  ctx.inject(['connection'], (connectionCtx: unknown) => {
    const conn = (connectionCtx as { connection?: ConnectionLike }).connection
    webConnection = conn
    if (conn === undefined) {
      record('已注入 connection 但字段缺失（web 认证桥不可用）')
      return
    }
    const keys = Object.keys(conn).join(',')
    const hasUrl = typeof conn.authenticatedUrl === 'function'
    const hasTok = typeof conn.launchToken === 'string' && conn.launchToken.length > 0
    record(`已捕获宿主 connection 服务：keys=[${keys}] authenticatedUrl=${hasUrl} launchToken字段=${hasTok}`)
  })

  // 首次装配即按 config 状态拉起（webServer 缺席时 enabled 也无从反代，跳过）
  await restartGateway()

  // 状态文件自愈对账：事件驱动发布（restartGateway/dispose 链）之外，每 30s 按
  // 网关实况重写一次 gateway-state.json——装配期 inject 回调与 apply 末尾的竞态、
  // 热重载次序反转等时序问题一律兜住（实测：omp 部署曾出现「网关监听中但文件停在
  // enabled:false」的滞留态）。写失败只记录，30s 后自愈重试。
  // 对账只补「持有中」态：enabled:false 的写入只走事件路径（用户停用/卸载等真实
  // 状态转换，由持有过网关的实例发布）。双加载的幻影实例可能是禁用态（配置源不同），
  // 若对账也补写 false，flap 会复活（omp 实测）；而「持有中」每 30s 必重写，
  // 文件稳定在真值。
  const reconcileTimer = setInterval(() => {
    if (gateway === undefined) return
    try {
      publishState()
    } catch {
      // publishState 内部已记录；防御性兜底
    }
  }, 30_000)
  reconcileTimer.unref()
  // 卸载时停表（cordis ctx.effect；mock 宿主无此方法时跳过——unref 已保证不拖退出）
  ;(ctx as { effect?: (fn: () => () => void) => void }).effect?.(() => () => clearInterval(reconcileTimer))
}
