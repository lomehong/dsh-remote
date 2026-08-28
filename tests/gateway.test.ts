import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'
import { loadDevices, type DeviceStore } from '../src/devices.ts'
import { PairingStore } from '../src/tokens.ts'
import { credentialToken, REMOTE_COOKIE, startGateway, type GatewayHandle } from '../src/gateway.ts'

// ── 共享 upstream：普通请求回显 `dsh says: <url>`；upgrade 握手后字节 echo ──
let upstream: Server
let upstreamPort = 0

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`dsh says: ${req.url}`)
  })
  upstream.on('upgrade', (_req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: fake\r\n\r\n')
    if (head.length > 0) socket.write(head)
    socket.pipe(socket)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as { port: number }).port
})

afterAll(async () => {
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

/** 测试固定码配对仓：create 返回预置码，consume 只认它（单次）；子类化以免改动生产 API。 */
class FixedPairingStore extends PairingStore {
  private consumed = false
  constructor(private readonly fixed: string) { super(60_000, () => Date.now()) }
  override create(): { code: string; expiresAt: number } {
    void super.create()
    return { code: this.fixed, expiresAt: Date.now() + 60_000 }
  }
  override consume(code: string): boolean {
    if (this.consumed || code !== this.fixed) return false
    this.consumed = true
    return true
  }
}

const CODE = 'test-pairing-code'
const gateways: GatewayHandle[] = []
const dirs: string[] = []

afterEach(async () => {
  // 全量清理：网关（含连接强制回收）+ 临时目录
  for (const gw of gateways.splice(0)) await gw.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function freshStore(): Promise<DeviceStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-gw-'))
  dirs.push(dir)
  return loadDevices(dir)
}

async function startTestGateway(store: DeviceStore, pairings: PairingStore): Promise<GatewayHandle> {
  const handle = await startGateway({
    bind: '127.0.0.1',
    port: 0,
    upstream: { host: '127.0.0.1', port: upstreamPort },
    store,
    pairings,
    log: () => {},
  })
  gateways.push(handle)
  return handle
}

/** 桌面流配对：POST JSON 拿 token（先create 预置固定码）。 */
async function pairViaPost(gw: GatewayHandle, pairings: PairingStore): Promise<{ token: string; deviceId: string }> {
  pairings.create()
  const res = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE }),
  })
  expect(res.status).toBe(200)
  const data = await res.json() as { ok: boolean; token: string; deviceId: string }
  expect(data.ok).toBe(true)
  return { token: data.token, deviceId: data.deviceId }
}

describe('startGateway 认证与配对', () => {
  it('未认证 GET / → 401；无效令牌计入限速，第 31 次 → 429；裸 401 不计数', async () => {
    const gw = await startTestGateway(await freshStore(), new PairingStore())
    const base = `http://127.0.0.1:${gw.port}`
    // 裸 401（浏览器首访正常路径）：不计入限速
    const bare = await fetch(`${base}/`)
    expect(bare.status).toBe(401)
    // 无效令牌：30 次以内 401（逐次记账）
    for (let i = 0; i < 30; i++) {
      const res = await fetch(`${base}/`, { headers: { 'x-remote-token': 'bad-token' } })
      expect(res.status).toBe(401)
    }
    // 裸 401 依然放行（未被连坐）
    const bare2 = await fetch(`${base}/`)
    expect(bare2.status).toBe(401)
    // 第 31 次无效令牌 → 429
    const limited = await fetch(`${base}/`, { headers: { 'x-remote-token': 'bad-token' } })
    expect(limited.status).toBe(429)
  })

  it('浏览器流：GET 有效码 → 303 + set-cookie（HttpOnly/SameSite=Lax）；cookie 凭证透传', async () => {
    const pairings = new FixedPairingStore(CODE)
    const gw = await startTestGateway(await freshStore(), pairings)
    pairings.create() // 预置固定码
    const res = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair?code=${encodeURIComponent(CODE)}`, { redirect: 'manual' })
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('/')
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${REMOTE_COOKIE}=`))
    expect(cookie).toBeDefined()
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    const token = cookie!.slice(`${REMOTE_COOKIE}=`.length).split(';')[0]
    // 携 cookie 访问 → 透传到 upstream
    const echo = await fetch(`http://127.0.0.1:${gw.port}/api/echo`, { headers: { cookie: `${REMOTE_COOKIE}=${token}` } })
    expect(echo.status).toBe(200)
    expect(await echo.text()).toBe('dsh says: /api/echo')
  })

  it('错误码 → 403 文本；桌面流 POST JSON → 200 {ok,token}，token 经 x-remote-token 生效', async () => {
    const pairings = new FixedPairingStore(CODE)
    const gw = await startTestGateway(await freshStore(), pairings)
    pairings.create()
    // 错误码：403 文本
    const wrong = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair?code=wrong-code`)
    expect(wrong.status).toBe(403)
    expect(wrong.headers.get('content-type')).toContain('text/plain')
    // 正确码：POST JSON
    const { token } = await pairViaPost(gw, pairings)
    const echo = await fetch(`http://127.0.0.1:${gw.port}/api/echo`, { headers: { 'x-remote-token': token } })
    expect(echo.status).toBe(200)
    expect(await echo.text()).toBe('dsh says: /api/echo')
  })

  it('x-remote-token 通过后 store.revoke → 同一令牌立即 401', async () => {
    const pairings = new FixedPairingStore(CODE)
    const store = await freshStore()
    const gw = await startTestGateway(store, pairings)
    const { token, deviceId } = await pairViaPost(gw, pairings)
    const before = await fetch(`http://127.0.0.1:${gw.port}/api/echo`, { headers: { 'x-remote-token': token } })
    expect(before.status).toBe(200)
    expect(store.revoke(deviceId)).toBe(true)
    const after = await fetch(`http://127.0.0.1:${gw.port}/api/echo`, { headers: { 'x-remote-token': token } })
    expect(after.status).toBe(401)
  })

  it('跨源 POST 配对 → 403（sameOrigin 围栏）', async () => {
    const gw = await startTestGateway(await freshStore(), new PairingStore())
    const res = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://evil.example' },
      body: JSON.stringify({ code: 'anything' }),
    })
    expect(res.status).toBe(403)
    expect(await res.text()).toContain('cross-origin')
  })

  it('POST query 带有效码但正文坏 JSON → 403（正文为准，query 不回退），且码未被烧掉', async () => {
    const pairings = new FixedPairingStore(CODE)
    const gw = await startTestGateway(await freshStore(), pairings)
    pairings.create()
    const bad = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair?code=${encodeURIComponent(CODE)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{broken',
    })
    expect(bad.status).toBe(403)
    // 坏尝试不消耗有效码：随后的正常 POST 仍可配对
    const { token } = await pairViaPost(gw, pairings)
    expect(token).not.toBe('')
  })
})

describe('credentialToken（单元）', () => {
  it('头优先于 cookie；混合键 cookie 解析；缺省 → undefined', () => {
    expect(credentialToken({ headers: { 'x-remote-token': 'hdr', cookie: `${REMOTE_COOKIE}=ck` } })).toBe('hdr')
    expect(credentialToken({ headers: { cookie: `other=1; ${REMOTE_COOKIE}=ck ; x=2` } })).toBe('ck')
    expect(credentialToken({ headers: {} })).toBeUndefined()
    expect(credentialToken({ headers: { 'x-remote-token': '' } })).toBeUndefined() // 空头视同缺失
  })
})

describe('WebSocket upgrade 分流', () => {
  it('无凭证 → 裸 HTTP/1.1 401 后断开；有凭证 → 101 + 双向 echo', async () => {
    const pairings = new FixedPairingStore(CODE)
    const gw = await startTestGateway(await freshStore(), pairings)
    const denied = await wsProbe(gw.port, '/api/events.mux')
    expect(denied.status).toBe(401)
    expect(denied.echoed).toBe(false)
    const { token } = await pairViaPost(gw, pairings)
    const ok = await wsProbe(gw.port, '/api/events.mux', token)
    expect(ok.status).toBe(101)
    expect(ok.echoed).toBe(true)
  })

  it('坏令牌升级 30 次内 401，第 31 次 → 429（与 HTTP 路径共用坏令牌限速）', async () => {
    const gw = await startTestGateway(await freshStore(), new PairingStore())
    for (let i = 0; i < 30; i++) {
      const probe = await wsProbe(gw.port, '/api/events.mux', 'bad-token')
      expect(probe.status).toBe(401)
    }
    const limited = await wsProbe(gw.port, '/api/events.mux', 'bad-token')
    expect(limited.status).toBe(429)
  })
})

describe('配对端点限速', () => {
  it('连续 11 次错误码 → 第 11 次 429（pairLimiter 10/min）', async () => {
    const gw = await startTestGateway(await freshStore(), new PairingStore())
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair?code=wrong-${i}`)
      expect(res.status).toBe(403)
    }
    const limited = await fetch(`http://127.0.0.1:${gw.port}/__remote/pair?code=wrong-10`)
    expect(limited.status).toBe(429)
  })
})

// 裸 socket WS 探针（带超时兜底）：发握手请求（可带凭证），返回状态码与双向 echo 结果
async function wsProbe(port: number, path: string, token?: string): Promise<{ status: number; echoed: boolean }> {
  return new Promise((resolve) => {
    const key = Buffer.from('0123456789abcdef').toString('base64')
    const auth = token !== undefined ? `X-Remote-Token: ${token}\r\n` : ''
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${auth}\r\n`,
      )
    })
    let buffer = ''
    let status = 0
    let sent = false
    const finish = (echoed: boolean): void => {
      clearTimeout(guard)
      socket.destroy()
      resolve({ status, echoed })
    }
    const guard = setTimeout(() => finish(false), 4000) // 超时即判失败，而非挂起
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1')
      if (status === 0) {
        if (!buffer.startsWith('HTTP/1.1 ')) return
        status = Number.parseInt(buffer.slice(9, 12), 10)
      }
      if (status !== 101) return // 非 101（如 401）：等对端关闭
      if (!sent) { sent = true; socket.write('ECHO-ME') }
      if (buffer.includes('ECHO-ME')) finish(true)
    })
    socket.on('error', () => finish(false))
    socket.on('close', () => { clearTimeout(guard); resolve({ status, echoed: false }) })
  })
}
