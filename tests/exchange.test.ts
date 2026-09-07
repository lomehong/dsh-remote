/**
 * /__remote/exchange（SSO 登录即连）契约测试：
 * POST {jwt} → 注入的 verifySso 验签 → 签实例级短 TTL 令牌（响应与配对同形状）。
 * 全回路断言：exchange 所得令牌直接能过网关凭证校验（透传到 upstream）。
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadDevices, type DeviceStore } from '../src/devices.ts'
import { PairingStore } from '../src/tokens.ts'
import { EXCHANGE_TOKEN_TTL_MS, startGateway, type GatewayHandle } from '../src/gateway.ts'
import type { SsoVerifyResult } from '../src/sso.ts'

let upstream: Server
let upstreamPort = 0

beforeAll(async () => {
  upstream = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
    res.end(`dsh says: ${req.url}`)
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  upstreamPort = (upstream.address() as { port: number }).port
})

afterAll(async () => {
  upstream.closeAllConnections()
  await new Promise<void>((resolve) => upstream.close(() => resolve()))
})

const gateways: GatewayHandle[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const gw of gateways.splice(0)) await gw.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function startWith(verifySso?: (jwt: string) => Promise<SsoVerifyResult>): Promise<{ gw: GatewayHandle; store: DeviceStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-remote-xchg-'))
  dirs.push(dir)
  const store = await loadDevices(dir)
  const gw = await startGateway({
    bind: '127.0.0.1',
    port: 0,
    upstream: { host: '127.0.0.1', port: upstreamPort },
    store,
    pairings: new PairingStore(),
    ...(verifySso !== undefined ? { verifySso } : {}),
    log: () => {},
  })
  gateways.push(gw)
  return { gw, store }
}

async function postExchange(port: number, body: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const resp = await fetch(`http://127.0.0.1:${port}/__remote/exchange`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return { status: resp.status, json: (await resp.json()) as Record<string, unknown> }
}

describe('/__remote/exchange', () => {
  it('验签通过 → 200 与配对同形状；令牌即刻可用（全回路透传）且带 24h 过期', async () => {
    const before = Date.now()
    const { gw, store } = await startWith(async (jwt) => {
      expect(jwt).toBe('good-jwt')
      return { ok: true, uid: 'u1', usr: 'hz0704027' }
    })
    const { status, json } = await postExchange(gw.port, JSON.stringify({ jwt: 'good-jwt' }))
    expect(status).toBe(200)
    expect(json.ok).toBe(true)
    expect(typeof json.token).toBe('string')
    expect(json.deviceId).toBeTypeOf('string')
    expect(String(json.name)).toContain('hz0704027')
    // 实例级短 TTL：落在 24h 窗口内
    const rec = store.list().find((d) => d.id === json.deviceId)
    expect(rec?.expiresAt).toBeGreaterThanOrEqual(before + EXCHANGE_TOKEN_TTL_MS)
    expect(rec?.expiresAt).toBeLessThanOrEqual(Date.now() + EXCHANGE_TOKEN_TTL_MS)
    // 全回路：exchange 令牌直接过网关凭证校验
    const resp = await fetch(`http://127.0.0.1:${gw.port}/`, { headers: { 'x-remote-token': String(json.token) } })
    expect(resp.status).toBe(200)
    expect(await resp.text()).toBe('dsh says: /')
  })

  it('验签未通过 → 401 sso_verify_rejected', async () => {
    const { gw } = await startWith(async () => ({ ok: false }))
    const { status, json } = await postExchange(gw.port, JSON.stringify({ jwt: 'bad-jwt' }))
    expect(status).toBe(401)
    expect(json.ok).toBe(false)
  })

  it('御符不可达（验签抛错）→ 502', async () => {
    const { gw } = await startWith(async () => { throw new Error('connect refused') })
    const { status } = await postExchange(gw.port, JSON.stringify({ jwt: 'x' }))
    expect(status).toBe(502)
  })

  it('未配置验签 → 503；GET → 405；坏正文 → 400', async () => {
    const { gw } = await startWith(undefined)
    expect((await postExchange(gw.port, JSON.stringify({ jwt: 'x' }))).status).toBe(503)

    const { gw: gw2 } = await startWith(async () => ({ ok: true }))
    const get = await fetch(`http://127.0.0.1:${gw2.port}/__remote/exchange`)
    expect(get.status).toBe(405)
    expect((await postExchange(gw2.port, 'not json')).status).toBe(400)
  })
})
