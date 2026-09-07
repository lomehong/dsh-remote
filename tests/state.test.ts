import { describe, expect, it, afterEach } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { advertisedAddress, gatewayStatePath, writeGatewayState } from '../src/state.ts'

let dir: string
afterEach(async () => { if (dir !== undefined) await rm(dir, { recursive: true, force: true }) })

describe('advertisedAddress（对外 authority 选取）', () => {
  const ifaces = [
    { ip: '192.168.1.146', kind: 'lan' as const },
    { ip: '100.64.0.7', kind: 'tailscale' as const },
  ]

  it('bind 为具体非回环地址 → 直接用 bind', () => {
    expect(advertisedAddress('100.64.0.7', 3090, ifaces)).toBe('100.64.0.7:3090')
  })

  it('bind 通配 → 首个非回环网卡（LAN 优先，与配对链接同序）', () => {
    expect(advertisedAddress('0.0.0.0', 3090, ifaces)).toBe('192.168.1.146:3090')
    expect(advertisedAddress('', 3090, ifaces)).toBe('192.168.1.146:3090')
  })

  it('bind 回环 → undefined（网关不可对外，不暴露误导性 address）', () => {
    expect(advertisedAddress('127.0.0.1', 3090, ifaces)).toBeUndefined()
  })

  it('通组无可用网卡 → undefined', () => {
    expect(advertisedAddress('0.0.0.0', 3090, [])).toBeUndefined()
  })
})

describe('writeGatewayState（yuyi 心跳透传契约）', () => {
  it('启用：写 {address, enabled:true, startedAt} 到约定路径', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-state-'))
    writeGatewayState(dir, { address: '192.168.1.146:3090', enabled: true, startedAt: 1_700_000_000_000 })
    const raw = JSON.parse(await readFile(gatewayStatePath(dir), 'utf8')) as Record<string, unknown>
    expect(raw).toMatchObject({ address: '192.168.1.146:3090', enabled: true, startedAt: 1_700_000_000_000 })
    expect(gatewayStatePath(dir)).toBe(join(dir, 'plugins', 'dsh-remote', 'gateway-state.json'))
  })

  it('停用：写 {enabled:false}（区分未安装=文件不存在 与 已停用）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-state-'))
    writeGatewayState(dir, { enabled: false })
    const raw = JSON.parse(await readFile(gatewayStatePath(dir), 'utf8')) as Record<string, unknown>
    expect(raw).toEqual({ enabled: false })
  })
})
