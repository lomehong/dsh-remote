/**
 * 装配层集成测试：mock 宿主 cordis 上下文（webServer 路由 / settings 节），
 * 走 apply() 全流程验证 /dsh-remote/api/* 管理路由、网关生命周期（配置热重载），
 * 以及「管理 API 生成配对 → 网关真实 consume」端到端链路（真实 PairingStore）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: vi.fn(),
  settingsNamespace: (ns: string) => ns,
}))

import { apply } from '../src/index.ts'
import { REMOTE_COOKIE } from '../src/gateway.ts'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'

type RouteHandler = (req: {
  method?: string
  headers: Record<string, string>
  on: (event: string, cb: (c?: Buffer) => void) => void
}, res: {
  writeHead: (status: number, headers?: Record<string, string>) => void
  end: (body: string) => void
}) => void | Promise<void>

function makeHarness(upstreamPort: number) {
  const disposers: Array<() => void> = []
  const routes: Record<string, RouteHandler> = {}
  const logs: string[] = []
  const webServer = {
    host: '127.0.0.1',
    port: upstreamPort,
    register: (route: { path: string; handler: RouteHandler }) => {
      routes[route.path] = route.handler
      return () => { delete routes[route.path] }
    },
  }
  const ctx = {
    // 模拟 cordis LoggerService：方法依赖 this——detached 调用必须在此即抛错
    logger: {
      prefix: '[remote]',
      info(this: { prefix?: string }, line: string) {
        if (this === undefined || this.prefix === undefined) throw new TypeError('this is not a function')
        logs.push(`${this.prefix}${line}`)
      },
    },
    get: (_name: string) => undefined,
    inject: (names: string[], fn: (scoped: any) => void) => {
      if (names.includes('webServer')) {
        fn({ webServer, effect: (factory: () => () => void) => { disposers.push(factory()) } })
      }
    },
    effect: (factory: () => () => void) => { disposers.push(factory()) },
  }
  const call = async (path: string, init?: { method?: string; body?: unknown }): Promise<{ status: number; body: any }> => {
    const handler = routes[path]
    if (handler === undefined) throw new Error(`no route: ${path}`)
    const req = {
      method: init?.method ?? 'GET',
      headers: {} as Record<string, string>,
      on: (event: string, cb: (c?: Buffer) => void) => {
        if (event === 'data' && init?.body !== undefined) cb(Buffer.from(JSON.stringify(init.body)))
        if (event === 'end') cb()
      },
    }
    let status = 0
    let raw = ''
    await handler(req, {
      writeHead: (s: number) => { status = s },
      end: (body: string) => { raw = body },
    })
    return { status, body: JSON.parse(raw) }
  }
  return { ctx, logs, routes, call, dispose: () => { for (const d of disposers) d() } }
}

/** 轮询直至条件成立（网关启停是异步的）。 */
async function waitFor(desc: string, check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${desc}`)
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** settings hooks 从 mock 中取出（apply 必经 installSettingsSection）。 */
function settingsHooks(): { setSource: (source: () => unknown) => void; onChange: () => void } {
  const calls = vi.mocked(installSettingsSection).mock.calls
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.at(-1)![1]).toBe('remote')
  return calls.at(-1)![4] as any
}

describe('装配层（apply 全流程，mock 宿主）', () => {
  let home = ''
  let upstream: Server
  let upstreamPort = 0

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-assemble-'))
    process.env.DSH_REMOTE_HOME = home
    // 真假 upstream：普通请求回显 `dsh: <url>`
    upstream = createServer((req, res) => {
      res.end(`dsh: ${req.url}`)
    })
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
    upstreamPort = (upstream.address() as { port: number }).port
  })

  afterEach(async () => {
    upstream.closeAllConnections()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
    delete process.env.DSH_REMOTE_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('enabled:false：status 报停用、设备列表为空、无 gatewayPort', async () => {
    const h = makeHarness(upstreamPort)
    await apply(h.ctx as any, { enabled: false, port: 0, bind: '127.0.0.1' })

    const status = await h.call('/dsh-remote/api/status')
    expect(status.body).toMatchObject({ ok: true, enabled: false, listening: false, port: 0, bind: '127.0.0.1' })
    expect(status.body.gatewayPort).toBeUndefined()
    expect(status.body.devices).toEqual([])

    const devices = await h.call('/dsh-remote/api/devices')
    expect(devices.body).toEqual({ ok: true, devices: [] })
  })

  it('enabled:true：网关拉起 + 配对全链路（真实 PairingStore consume）+ 设备脱敏与吊销', async () => {
    const h = makeHarness(upstreamPort)
    await apply(h.ctx as any, { enabled: true, port: 0, bind: '127.0.0.1' })

    // status：监听中，端口为 OS 分配
    const status = await h.call('/dsh-remote/api/status')
    expect(status.body.listening).toBe(true)
    expect(typeof status.body.gatewayPort).toBe('number')
    const gwPort = status.body.gatewayPort as number

    // 无凭证访问网关 → 401
    const base = `http://127.0.0.1:${gwPort}`
    expect((await fetch(`${base}/`)).status).toBe(401)

    // 管理 API 生成配对（真实 create）
    const pairing = await h.call('/dsh-remote/api/pairing', { method: 'POST' })
    expect(pairing.status).toBe(200)
    expect(pairing.body.ok).toBe(true)
    expect(typeof pairing.body.code).toBe('string')
    expect(Array.isArray(pairing.body.links) && pairing.body.links.length > 0).toBe(true)

    // 用返回的 code 走网关真实配对流（GET → 303 + cookie）
    const link = new URL(pairing.body.links[0].url)
    const pairUrl = `http://127.0.0.1:${gwPort}${link.pathname}${link.search}`
    const pairRes = await fetch(pairUrl, { redirect: 'manual' })
    expect(pairRes.status).toBe(303)
    const setCookie = pairRes.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain(`${REMOTE_COOKIE}=`)
    const token = /dsh_remote=([^;]+)/.exec(setCookie)![1]!

    // 带 cookie 访问 → 透传到 upstream（真实 consume + verify 全链路）
    const echo = await fetch(`${base}/api/x`, { headers: { cookie: `${REMOTE_COOKIE}=${token}` } })
    expect(echo.status).toBe(200)
    expect(await echo.text()).toBe('dsh: /api/x')

    // 设备列表 1 台；响应绝不暴露 tokenHash/ua（ua 是不可信输入）
    const devices = await h.call('/dsh-remote/api/devices')
    expect(devices.body.devices).toHaveLength(1)
    const raw = JSON.stringify(devices.body)
    expect(raw.includes('tokenHash')).toBe(false)
    expect(raw.includes('"ua"')).toBe(false)
    const deviceId = devices.body.devices[0].id as string

    // 吊销后同一凭证 → 401
    const revoked = await h.call('/dsh-remote/api/devices/revoke', { method: 'POST', body: { id: deviceId } })
    expect(revoked.body.ok).toBe(true)
    await waitFor('revoked token rejected', async () =>
      (await fetch(`${base}/api/x`, { headers: { cookie: `${REMOTE_COOKIE}=${token}` } })).status === 401)
    expect((await fetch(`${base}/api/x`, { headers: { cookie: `${REMOTE_COOKIE}=${token}` } })).status).toBe(401)

    h.dispose()
    await waitFor('gateway closed', async () => {
      try { await fetch(`${base}/`, { redirect: 'manual' }); return false } catch { return true }
    })
  })

  it('settings 热重载：onChange 应用新配置 → 网关关闭（listening 变 false）', async () => {
    const h = makeHarness(upstreamPort)
    await apply(h.ctx as any, { enabled: true, port: 0, bind: '127.0.0.1' })
    await waitFor('gateway up', () => h.logs.length > 0)

    const hooks = settingsHooks()
    hooks.setSource(() => ({ enabled: false, port: 0, bind: '127.0.0.1' }))
    hooks.onChange()

    await waitFor('gateway down', async () =>
      (await h.call('/dsh-remote/api/status')).body.listening === false)
      .catch(() => {}) // 超时则落到下方显式断言，给出可读的失败信息
    const status = await h.call('/dsh-remote/api/status')
    expect(status.body.enabled).toBe(false)
    expect(status.body.listening).toBe(false)
  })

  it('dispose 后到达的配置变更不拉起网关（孤儿监听回归）', async () => {
    // 回归：onChange 的重启链在 startGateway await 期间发生卸载时，句柄会在 dispose
    // 检查之后才赋值 → 留下一个永远无人关闭的监听。现在 disposed 置位后彻底跳过启动。
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)

    const h = makeHarness(upstreamPort)
    await apply(h.ctx as any, { enabled: false, port: 0, bind: '127.0.0.1' })
    const hooks = settingsHooks()

    // 先卸载（scoped effect 清理：置 disposed + 注销路由），再来的配置变更必须被挡住
    h.dispose()
    hooks.setSource(() => ({ enabled: true, port: 0, bind: '127.0.0.1' }))
    hooks.onChange()

    await waitFor('restart chain settles', () => h.logs.some((l) => l.includes('插件已卸载')))
    expect(h.logs.some((l) => l.includes('网关已监听'))).toBe(false)
    const status = await h.call('/dsh-remote/api/status').catch(() => null) // 路由已注销 → null
    expect(status).toBeNull()

    // 让微任务队列彻底排空后再检查无 unhandled rejection
    await new Promise((r) => setTimeout(r, 50))
    process.off('unhandledRejection', onUnhandled)
    expect(unhandled).toEqual([])
  })
})
