/**
 * 远程访问网关：带配对认证的反向代理。
 * - /__remote/pair 是唯一认证豁免端点（GET 浏览器流 303+cookie；POST 桌面流 JSON token），按 IP 限速
 * - 其余一切请求/upgrade 须持有效凭证（cookie dsh_remote 或 x-remote-token 头）才透传
 * - 无效令牌尝试计入限速（防爆破）；裸 401 不计（浏览器首访是正常路径）
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { proxyRequest, proxyUpgrade, upstreamAuthority, type Upstream } from './proxy.ts'
import { generateDeviceToken, type PairingStore } from './tokens.ts'
import type { DeviceStore } from './devices.ts'
import { RateLimiter } from './ratelimit.ts'

export const REMOTE_COOKIE = 'dsh_remote'

export interface GatewayOptions {
  bind: string
  port: number
  upstream: Upstream
  store: DeviceStore
  pairings: PairingStore
  log: (line: string) => void
  now?: () => number
}

export interface GatewayHandle {
  /** 实际监听端口（配置 port=0 时由 OS 分配）。 */
  port: number
  close(): Promise<void>
}

/** 从请求提取凭证：x-remote-token 头优先，其次 cookie（浏览器路径）。 */
export function credentialToken(req: Pick<IncomingMessage, 'headers'>): string | undefined {
  const header = req.headers['x-remote-token']
  if (typeof header === 'string' && header !== '') return header
  return cookieValue(req.headers.cookie, REMOTE_COOKIE)
}

function cookieValue(header: unknown, name: string): string | undefined {
  if (typeof header !== 'string') return undefined
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return undefined
}

function clientKey(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown'
}

export async function startGateway(options: GatewayOptions): Promise<GatewayHandle> {
  const { bind, upstream, store, pairings, log } = options
  const now = options.now ?? Date.now
  const pairLimiter = new RateLimiter(10, 60_000, now)
  const badTokenLimiter = new RateLimiter(30, 60_000, now)

  const deny = (res: ServerResponse, status: number, message: string): void => {
    if (res.headersSent) { res.end(); return }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
    res.end(message)
  }
  const rawDeny = (socket: Duplex, status: number, message: string): void => {
    socket.write(`HTTP/1.1 ${status} \r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}\n`)
    socket.destroy()
  }
  /** 带 Origin 的写请求须同源（与 model-failover sameOrigin 同款；GET/无 Origin 放行）。 */
  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers.host
    if (typeof host !== 'string' || host === '') return false
    try { return new URL(String(origin)).host === host } catch { return false }
  }
  const readBody = (req: IncomingMessage): Promise<string> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > 4096) { reject(new Error('请求体过大')); req.destroy(); return }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })

  const server: Server = createServer((req, res) => { void handle(req, res) })
  server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head) })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local')
      if (url.pathname === '/__remote/pair') {
        await handlePair(req, res, url)
        return
      }
      const token = credentialToken(req)
      const device = token === undefined ? undefined : store.verify(token)
      if (device === undefined) {
        if (token !== undefined && !badTokenLimiter.check(clientKey(req))) {
          deny(res, 429, '尝试过于频繁，请稍后再试')
          return
        }
        deny(res, 401, '此端口为 dsh 远程访问网关：请先在 dsh 设置页生成配对链接完成配对。')
        return
      }
      store.touch(device.id, now())
      proxyRequest(upstream, req, res)
    } catch (error) {
      log(`网关请求处理异常：${error instanceof Error ? error.message : String(error)}`)
      deny(res, 500, 'internal error')
    }
  }

  async function handlePair(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (!pairLimiter.check(clientKey(req))) {
      deny(res, 429, '配对尝试过于频繁，请稍后再试')
      return
    }
    let code = url.searchParams.get('code') ?? ''
    let wantsJson = false
    if (req.method === 'POST') {
      if (!sameOrigin(req)) { deny(res, 403, 'cross-origin denied'); return }
      code = '' // POST 以正文为准：先清空，杜绝坏正文回退到 query 里的码
      try {
        const parsed = JSON.parse(await readBody(req)) as { code?: unknown }
        code = String(parsed.code ?? '')
      } catch { /* code 保持空 → 走失败分支 */ }
      wantsJson = true
    } else if (req.method !== 'GET') {
      deny(res, 405, 'method not allowed')
      return
    }
    if (!pairings.consume(code)) {
      log(`配对失败（码无效或已过期）来自 ${clientKey(req)}`)
      if (wantsJson) {
        res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        res.end(JSON.stringify({ ok: false, error: '配对码无效或已过期' }))
        return
      }
      deny(res, 403, '配对码无效或已过期：请在 dsh 设置页重新生成配对链接。')
      return
    }
    const token = generateDeviceToken()
    // UA 攻击者可控且随设备记录落盘：截断防御（名称取自时间戳，与 UA 无关）
    const rawUa = req.headers['user-agent']
    const ua = typeof rawUa === 'string' && rawUa !== '' ? rawUa.slice(0, 200) : undefined
    const stamp = new Date(now()).toISOString().slice(0, 16).replace('T', ' ')
    const device = store.add({ token, name: `远程设备 ${stamp}`, ...(ua !== undefined ? { ua } : {}) }, now())
    log(`新设备已配对：${device.name}（${device.id}）`)
    if (wantsJson) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: true, token, deviceId: device.id, name: device.name }))
      return
    }
    res.writeHead(303, {
      location: '/',
      'set-cookie': `${REMOTE_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
      'cache-control': 'no-store',
    })
    res.end()
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    try {
      const url = new URL(req.url ?? '/', 'http://gateway.local')
      if (url.pathname === '/__remote/pair') { rawDeny(socket, 405, 'method not allowed'); return }
      const token = credentialToken(req)
      const device = token === undefined ? undefined : store.verify(token)
      if (device === undefined) {
        if (token !== undefined && !badTokenLimiter.check(clientKey(req))) {
          // 带无效令牌的升级与 HTTP 路径同规：计入坏令牌限速（防爆破）；裸 401 不计
          log(`WS 升级被拒绝（坏令牌限速）来自 ${clientKey(req)}`)
          rawDeny(socket, 429, '尝试过于频繁，请稍后再试')
          return
        }
        log(`WS 升级被拒绝（未认证）来自 ${clientKey(req)}`)
        rawDeny(socket, 401, 'unauthorized: pair required')
        return
      }
      store.touch(device.id, now())
      proxyUpgrade(upstream, req, socket, head)
    } catch {
      socket.destroy()
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, bind, () => resolve())
  })
  const flushTimer = setInterval(() => { void store.flush().catch(() => {}) }, 5 * 60_000)
  flushTimer.unref()
  log(`远程访问网关已启动：http://${bind}:${String(portOf(server))} → http://${upstreamAuthority(upstream)}`)
  return {
    port: portOf(server),
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(flushTimer)
        void store.flush().catch(() => {})
        server.close(() => resolve())
        server.closeAllConnections()  // 不等待既有连接；进程退出兜底（参考 proxy 测试的关闭模式）
      }),
  }
}

function portOf(server: Server): number {
  const addr = server.address()
  return typeof addr === 'object' && addr !== null ? addr.port : 0
}
