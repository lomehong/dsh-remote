import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { proxyRequest, proxyUpgrade, rewriteForwardHeaders } from '../src/proxy.ts'

let upstream: Server
let upstreamPort = 0
const seen: Array<{
  path: string
  method: string
  host?: string | undefined
  origin?: string | undefined
  referer?: string | undefined
  body: string
}> = []

beforeAll(async () => {
  upstream = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      seen.push({
        path: req.url ?? '/',
        method: req.method ?? '',
        host: req.headers.host,
        origin: typeof req.headers.origin === 'string' ? req.headers.origin : undefined,
        referer: typeof req.headers.referer === 'string' ? req.headers.referer : undefined,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      if (req.url === '/set-cookie') {
        res.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1; HttpOnly', 'b=2'] })
        res.end('ok')
        return
      }
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-upstream': 'yes' })
      res.end(`dsh says: ${req.url}`)
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as { port: number }).port
})
afterAll(async () => {
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

function listenGateway(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

function listenOn(server: Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port))
  })
}

async function closeServer(server: Server): Promise<void> {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function closeGateway(gw: { server: Server }): Promise<void> {
  await closeServer(gw.server)
}

/** 泄漏类断言的兜底：超时即判失败（而非挂起），结算后清掉定时器避免悬挂拒绝 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}（等待超过 ${ms}ms）`)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

describe('rewriteForwardHeaders', () => {
  it('Host 改为 upstream；Origin/Referer 中的网关 authority 同步改写；剥离 hop-by-hop', () => {
    const headers = rewriteForwardHeaders(
      { headers: { host: '192.168.1.5:3090', origin: 'http://192.168.1.5:3090', referer: 'http://192.168.1.5:3090/settings', connection: 'keep-alive', 'x-keep': '1' } },
      { host: '127.0.0.1', port: 3080 },
    )
    expect(headers.host).toBe('127.0.0.1:3080')
    expect(headers.origin).toBe('http://127.0.0.1:3080')
    expect(headers.referer).toBe('http://127.0.0.1:3080/settings')
    expect(headers.connection).toBeUndefined()
    expect(headers['x-keep']).toBe('1')
  })
})

describe('proxyRequest（端到端）', () => {
  it('透传 method/path/query/body 与响应头/status；Set-Cookie 多值保留', async () => {
    const gw = await listenGateway((req, res) => proxyRequest({ host: '127.0.0.1', port: upstreamPort }, req, res))
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/api/sessions?x=1`, {
        method: 'POST', headers: { 'content-type': 'application/json', host: `127.0.0.1:${gw.port}` }, body: '{"a":1}',
      })
      expect(res.status).toBe(200)
      expect(res.headers.get('x-upstream')).toBe('yes')
      expect(await res.text()).toBe('dsh says: /api/sessions?x=1')
      expect(seen.at(-1)).toMatchObject({ method: 'POST', path: '/api/sessions?x=1', body: '{"a":1}', host: `127.0.0.1:${upstreamPort}` })

      const res2 = await fetch(`http://127.0.0.1:${gw.port}/set-cookie`)
      expect(res2.headers.getSetCookie()).toEqual(['a=1; HttpOnly', 'b=2'])
    } finally {
      await closeGateway(gw)
    }
  })

  it('upstream 不可达 → 502', async () => {
    const gw = await listenGateway((req, res) => proxyRequest({ host: '127.0.0.1', port: 1 }, req, res))
    try {
      const res = await fetch(`http://127.0.0.1:${gw.port}/x`)
      expect(res.status).toBe(502)
    } finally {
      await closeGateway(gw)
    }
  })
})

describe('proxyUpgrade（端到端）', () => {
  it('WS 握手转发：101 透传 + 双向字节 echo；Host 头改写', async () => {
    // upstream 已有 HTTP handler；这里给它挂 upgrade 处理（echo 服务）
    const seenUpgradeHosts: string[] = []
    upstream.on('upgrade', (req, socket, head) => {
      seenUpgradeHosts.push(String(req.headers.host))
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
      if (head.length > 0) socket.write(head)
      socket.pipe(socket)
    })
    const gw = await listenGateway((req, res) => proxyRequest({ host: '127.0.0.1', port: upstreamPort }, req, res))
    // 注意：listenGateway 只挂了 request handler —— 网关侧需为 upgrade 单独接 proxyUpgrade
    gw.server.on('upgrade', (req, socket, head) => {
      proxyUpgrade({ host: '127.0.0.1', port: upstreamPort }, req, socket, head)
    })
    try {
      const result = await wsEchoProbe(gw.port)
      expect(result.handshook).toBe(true)
      expect(result.echoed).toBe(true)
      expect(seenUpgradeHosts.at(-1)).toBe(`127.0.0.1:${upstreamPort}`) // Host 已改写
    } finally {
      await closeGateway(gw)
    }
  })
})

describe('proxyUpgrade 健壮性（回归 C1/I1）', () => {
  it('握手窗口期 RST 不击穿进程；已建立会话 RST 后 upstream 侧双向回收；网关后续 WS 仍可用', async () => {
    // 独立 upstream：echo 握手按路径控制延迟（/fast 立即、其余 50ms），稳定复现握手窗口
    const upgradeSockets: Duplex[] = []
    const slow = createServer(() => {})
    slow.on('upgrade', (req, sock, head) => {
      upgradeSockets.push(sock)
      sock.on('error', () => sock.destroy())
      setTimeout(() => {
        if (sock.destroyed) return
        sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
        if (head.length > 0) sock.write(head)
        sock.pipe(sock)
      }, req.url === '/fast' ? 0 : 50)
    })
    const slowPort = await listenOn(slow)
    const gw = await listenGateway((req, res) => proxyRequest({ host: '127.0.0.1', port: slowPort }, req, res))
    gw.server.on('upgrade', (req, socket, head) => {
      proxyUpgrade({ host: '127.0.0.1', port: slowPort }, req, socket, head)
    })
    try {
      // C1：RST 落在 upstream 101 返回前的握手窗口 —— 未修则 socket 无 error 监听，uncaughtException 击穿进程
      await withTimeout(rstProbe(gw.port, '/slow', 'duringHandshake'), 2000, 'RST 探针 A 未完成')
      // I1：握手完成后再 RST —— 未双向回收则 upstream socket 永久泄漏
      await withTimeout(rstProbe(gw.port, '/fast', 'afterHandshake'), 2000, 'RST 探针 B 未完成')
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(upgradeSockets.length).toBeGreaterThanOrEqual(2)
      expect(upgradeSockets.every((s) => s.destroyed)).toBe(true) // upstream 侧全部回收
      // 进程存活（能走到这里即未崩溃）+ 同一网关上后续健康 WS 仍可用
      const second = await wsEchoProbe(gw.port)
      expect(second.handshook).toBe(true)
      expect(second.echoed).toBe(true)
    } finally {
      await closeGateway(gw)
      await closeServer(slow)
    }
  })
})

describe('proxyRequest 健壮性（回归 I2）', () => {
  it('客户端响应中途 abort → upstream 流在 500ms 内被回收', async () => {
    let signalUpstreamClosed: () => void = () => {}
    const upstreamClosed = new Promise<void>((resolve) => { signalUpstreamClosed = resolve })
    // 上游持续流式输出且永不 end：网关不回收则 upstream socket 永不 close（泄漏）
    const slow = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      let i = 0
      const timer = setInterval(() => {
        if (i >= 5) { clearInterval(timer); return }
        res.write(`chunk-${i++}\n`)
      }, 50)
      res.on('close', () => { clearInterval(timer); signalUpstreamClosed() })
    })
    const slowPort = await listenOn(slow)
    const gw = await listenGateway((req, res) => proxyRequest({ host: '127.0.0.1', port: slowPort }, req, res))
    try {
      const ac = new AbortController()
      const response = await fetch(`http://127.0.0.1:${gw.port}/slow-stream`, { signal: ac.signal })
      const reader = response.body!.getReader()
      await reader.read() // 收到第一个块即中断
      ac.abort()
      const start = Date.now()
      await withTimeout(upstreamClosed, 2000, 'upstream 流未回收')
      expect(Date.now() - start).toBeLessThan(500)
    } finally {
      await closeGateway(gw)
      await closeServer(slow)
    }
  })
})

describe('proxyRequest 健壮性（回归：响应头到达前 abort）', () => {
  it('客户端在响应头到达前 abort → upstream 请求在 500ms 内被回收', async () => {
    let signalUpstreamClosed: () => void = () => {}
    const upstreamClosed = new Promise<void>((resolve) => { signalUpstreamClosed = resolve })
    // 上游 400ms 才返回响应头，之后无限慢速流且永不 end：请求 socket 不 close 即为泄漏
    const slow = createServer((req, res) => {
      req.socket.on('close', signalUpstreamClosed)
      setTimeout(() => {
        if (req.socket.destroyed) return
        res.writeHead(200, { 'content-type': 'text/plain' })
        const timer = setInterval(() => res.write('chunk\n'), 50)
        res.on('close', () => clearInterval(timer))
      }, 400)
    })
    const slowPort = await listenOn(slow)
    const gw = await listenGateway((req, res) => proxyRequest({ host: '127.0.0.1', port: slowPort }, req, res))
    try {
      const ac = new AbortController()
      const pending = fetch(`http://127.0.0.1:${gw.port}/slow-ttfb`, { signal: ac.signal })
      setTimeout(() => ac.abort(), 100) // 落在 400ms 响应头到达之前
      await expect(pending).rejects.toThrow()
      const start = Date.now()
      await withTimeout(upstreamClosed, 2000, 'upstream 请求未回收（响应头到达前中断即泄漏）')
      expect(Date.now() - start).toBeLessThan(500)
    } finally {
      await closeGateway(gw)
      await closeServer(slow)
    }
  })
})

// 裸 socket RST 探针：duringHandshake 在发出握手请求后约 15ms RST——足够让网关解析出 upgrade 并进入
// 握手窗口（Node 已摘除内部处理），又稳落在 upstream 延迟的 101 之前；afterHandshake 则等 101 后再 RST
async function rstProbe(port: number, path: string, mode: 'duringHandshake' | 'afterHandshake'): Promise<void> {
  const { connect } = await import('node:net')
  await new Promise<void>((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const key = Buffer.from('0123456789abcdef').toString('base64')
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
      if (mode === 'duringHandshake') {
        setTimeout(() => { socket.resetAndDestroy(); resolve() }, 15)
      }
    })
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (buffer.startsWith('HTTP/1.1 101')) {
        socket.resetAndDestroy()
        resolve()
      }
    })
    socket.on('error', () => resolve())
    socket.on('close', () => resolve())
  })
}

// 裸 socket WS 探针：发握手请求，验证 101 与双向字节透传（重复 resolve 无害）
async function wsEchoProbe(port: number): Promise<{ handshook: boolean; echoed: boolean }> {
  const { connect } = await import('node:net')
  return new Promise((resolve) => {
    const socket = connect(port, '127.0.0.1', () => {
      const key = Buffer.from('0123456789abcdef').toString('base64')
      socket.write(`GET /api/events.mux HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`)
    })
    let buffer = ''
    let handshook = false
    const timeout = setTimeout(() => { socket.destroy(); resolve({ handshook, echoed: false }) }, 5000)
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (!handshook && buffer.startsWith('HTTP/1.1 101')) {
        handshook = true
        buffer = ''
        socket.write('ECHO-ME')
        return
      }
      if (handshook && buffer.includes('ECHO-ME')) {
        clearTimeout(timeout)
        socket.destroy()
        resolve({ handshook: true, echoed: true })
      }
    })
    socket.on('error', () => { clearTimeout(timeout); resolve({ handshook, echoed: false }) })
    socket.on('close', () => { if (!handshook || !buffer.includes('ECHO-ME')) { clearTimeout(timeout); resolve({ handshook, echoed: false }) } })
  })
}
