/**
 * 自更新管理端点装配测试：mock updater 模块（无网络/无文件系统），
 * 验证 /dsh-remote/api/update/check 与 /apply 的方法/同源/输入校验与状态回报。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@deepseek-ai/dsh-settings', () => ({
  installSettingsSection: vi.fn(),
  settingsNamespace: (ns: string) => ns,
}))

// updater 整体 mock：端点装配层测试不触网、不动文件系统
vi.mock('../src/update.ts', () => ({
  clearPendingMarker: vi.fn(),
  packageDir: vi.fn(() => '/fake/pkg'),
  currentVersion: vi.fn(() => '0.1.1'),
  pendingVersion: vi.fn(() => null),
  latestTag: vi.fn(),
  updateStatus: vi.fn(() => ({ applying: false, phase: '', lastError: '' })),
  applyUpdate: vi.fn(async () => {}),
}))

import { apply } from '../src/index.ts'
import { applyUpdate, latestTag, updateStatus } from '../src/update.ts'

type RouteHandler = (req: {
  method?: string
  headers: Record<string, string>
  on: (event: string, cb: (c?: Buffer) => void) => void
}, res: {
  writeHead: (status: number, headers?: Record<string, string>) => void
  end: (body: string) => void
}) => void | Promise<void>

function makeHarness() {
  const routes: Record<string, RouteHandler> = {}
  const webServer = {
    host: '127.0.0.1',
    port: 3080,
    register: (route: { path: string; handler: RouteHandler }) => {
      routes[route.path] = route.handler
      return () => { delete routes[route.path] }
    },
  }
  const ctx = {
    inject: (names: string[], fn: (scoped: unknown) => void) => {
      if (names.includes('webServer')) fn({ webServer, effect: () => () => {} })
    },
    effect: () => () => {},
  }
  const call = async (path: string, init?: { method?: string; body?: unknown; origin?: string; host?: string }): Promise<{ status: number; body: any }> => {
    const handler = routes[path]
    if (handler === undefined) throw new Error(`no route: ${path}`)
    const headers: Record<string, string> = {}
    if (init?.origin !== undefined) headers.origin = init.origin
    if (init?.host !== undefined) headers.host = init.host
    const req = {
      method: init?.method ?? 'GET',
      headers,
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
  return { ctx, call }
}

describe('自更新端点（mock updater，装配层）', () => {
  let home = ''

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'dsh-remote-update-api-'))
    process.env.DSH_REMOTE_HOME = home
    vi.clearAllMocks()
  })

  afterEach(async () => {
    delete process.env.DSH_REMOTE_HOME
    await rm(home, { recursive: true, force: true })
  })

  it('check：GitHub 正常 → current/latest/updateAvailable', async () => {
    vi.mocked(latestTag).mockResolvedValue('v0.1.2')
    const h = makeHarness()
    await apply(h.ctx as never, { enabled: false, port: 0, bind: '127.0.0.1' })
    const res = await h.call('/dsh-remote/api/update/check')
    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ ok: true, current: '0.1.1', latest: 'v0.1.2', updateAvailable: true, applying: false, pendingVersion: null })
  })

  it('check：GitHub 不可达 → 200 + checkError，设置页不炸', async () => {
    vi.mocked(latestTag).mockRejectedValue(new Error('版本列表获取失败：网络错误：getaddrinfo ENOTFOUND'))
    const h = makeHarness()
    await apply(h.ctx as never, { enabled: false, port: 0, bind: '127.0.0.1' })
    const res = await h.call('/dsh-remote/api/update/check')
    expect(res.status).toBe(200)
    expect(res.body.updateAvailable).toBe(false)
    expect(res.body.latest).toBeNull()
    expect(res.body.current).toBe('0.1.1')
    expect(res.body.checkError).toContain('检查失败')
    expect(res.body.checkError).toContain('ENOTFOUND')
  })

  it('apply：非法标签 400；进行中 409；正常受理 200 且后台单飞启动', async () => {
    const h = makeHarness()
    await apply(h.ctx as never, { enabled: false, port: 0, bind: '127.0.0.1' })

    const bad = await h.call('/dsh-remote/api/update/apply', { method: 'POST', body: { tag: 'latest' } })
    expect(bad.status).toBe(400)

    vi.mocked(updateStatus).mockReturnValueOnce({ applying: true, phase: '下载', lastError: '' })
    const busy = await h.call('/dsh-remote/api/update/apply', { method: 'POST', body: { tag: 'v0.1.2' } })
    expect(busy.status).toBe(409)

    const ok = await h.call('/dsh-remote/api/update/apply', { method: 'POST', body: { tag: 'v0.1.2' } })
    expect(ok.status).toBe(200)
    expect(ok.body).toEqual({ ok: true })
    expect(vi.mocked(applyUpdate)).toHaveBeenCalledWith('v0.1.2', expect.any(Function))
  })

  it('两个端点都拒绝跨源与错误方法', async () => {
    const h = makeHarness()
    await apply(h.ctx as never, { enabled: false, port: 0, bind: '127.0.0.1' })

    const cross = await h.call('/dsh-remote/api/update/check', { origin: 'http://evil.example', host: '127.0.0.1:3080' })
    expect(cross.status).toBe(403)
    const post = await h.call('/dsh-remote/api/update/check', { method: 'POST' })
    expect(post.status).toBe(405)
    const get = await h.call('/dsh-remote/api/update/apply', { method: 'GET' })
    expect(get.status).toBe(405)
    const crossApply = await h.call('/dsh-remote/api/update/apply', { method: 'POST', origin: 'http://evil.example', host: '127.0.0.1:3080' })
    expect(crossApply.status).toBe(403)
  })
})
