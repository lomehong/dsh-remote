import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { devicesFilePath, loadDevices } from '../src/devices.ts'
import { generateDeviceToken, deviceTokenFingerprint } from '../src/tokens.ts'

let dir: string
afterEach(async () => { if (dir !== undefined) await rm(dir, { recursive: true, force: true }) })

describe('DeviceStore', () => {
  it('add → verify 往返；list 不含明文令牌', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    const store = await loadDevices(dir)
    const token = generateDeviceToken()
    const device = store.add({ token, name: '测试机', ua: 'vitest' }, 1_000)
    expect(store.verify(token)?.id).toBe(device.id)
    const token2 = generateDeviceToken()
    expect(store.verify(token2)).toBeUndefined()
    const raw = await readFile(devicesFilePath(dir), 'utf8')
    expect(raw).not.toContain(token) // 只落盘 sha256 指纹
    expect(raw).toContain(deviceTokenFingerprint(token))
  })

  it('rename / revoke / touch 语义正确，吊销后 verify 立即失效', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    const store = await loadDevices(dir)
    const token = generateDeviceToken()
    const device = store.add({ token }, 1_000)
    expect(store.rename(device.id, '手机')).toBe(true)
    expect(store.rename('nope', 'x')).toBe(false)
    store.touch(device.id, 2_000)
    expect(store.list()[0]).toMatchObject({ name: '手机', lastSeenAt: 2_000 })
    expect(store.revoke(device.id)).toBe(true)
    expect(store.verify(token)).toBeUndefined()
  })

  it('实例级短 TTL 令牌：expiresAt 过期即 verify 失败，重启加载直接丢弃', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    const store = await loadDevices(dir)
    const fresh = generateDeviceToken()
    const stale = generateDeviceToken()
    const now = Date.now()
    store.add({ token: fresh, name: 'SSO 有效', expiresAt: now + 60_000 }, now)
    store.add({ token: stale, name: 'SSO 过期', expiresAt: now - 1 }, now)
    expect(store.verify(fresh)).toBeDefined()
    expect(store.verify(stale)).toBeUndefined() // 已过期
    await store.flush()
    const reloaded = await loadDevices(dir)
    expect(reloaded.verify(fresh)?.name).toBe('SSO 有效')
    expect(reloaded.list()).toHaveLength(1) // 过期项载入即丢弃
  })

  it('ensureSso：同 uid 轮换复用（id 稳定/指纹更新/延期），不同 uid 独立', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    const store = await loadDevices(dir)
    const now = Date.now()
    // ① 首次签发：新建
    const d1 = store.ensureSso({ uid: 'u1', usr: 'hz0704027', token: 'tok-1', expiresAt: now + 1000 }, now)
    expect(d1.id).toBe(store.verify('tok-1')?.id)
    // ② 同 uid 重登：轮换复用（id 不变、旧令牌失效、新令牌生效、有效期顺延）
    const d2 = store.ensureSso({ uid: 'u1', usr: 'hz0704027', token: 'tok-2', expiresAt: now + 2000 }, now + 500)
    expect(d2.id).toBe(d1.id)
    expect(store.verify('tok-1')).toBeUndefined() // 旧令牌已被轮换失效
    expect(store.verify('tok-2')?.expiresAt).toBe(now + 2000)
    // ③ 不同 uid 独立建设备
    store.ensureSso({ uid: 'u2', usr: 'other', token: 'tok-u2', expiresAt: now + 1000 }, now)
    expect(store.verify('tok-u2')).toBeDefined()
    expect(store.verify('tok-2')).toBeDefined() // u1 的不受影响
  })

  it('ensureSso 旧版迁移：同名无 ssoUid 的存量设备被接管（补 uid，不新增条目）', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    const store = await loadDevices(dir)
    const now = Date.now()
    // 模拟旧版残留：每次登录各建一条、无 ssoUid
    const legacy1 = generateDeviceToken()
    const legacy2 = generateDeviceToken()
    store.add({ token: legacy1, name: 'SSO hz0704027', expiresAt: now + 400_000 }, now)
    store.add({ token: legacy2, name: 'SSO hz0704027', expiresAt: now + 400_000 }, now + 1)
    const before = store.list().length
    // 首次带 ssoUid 的签发：接管最新的同名存量（不新建），其余同名保留至自然过期
    const d = store.ensureSso({ uid: 'u1', usr: 'hz0704027', token: 'tok-new', expiresAt: now + 3000 }, now)
    expect(store.verify('tok-new')?.id).toBe(d.id)
    expect(d.ssoUid).toBe('u1')
    expect(store.list().length).toBe(before)
    // 再登 → 走 ssoUid 精确匹配，稳定复用同一条
    const again = store.ensureSso({ uid: 'u1', usr: 'hz0704027', token: 'tok-newer', expiresAt: now + 4000 }, now)
    expect(again.id).toBe(d.id)
  })

  it('flush 失败保留 dirty：障碍移除后再次 flush 重试落盘', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    // devices.json 先建成目录：loadDevices 读到即当全新表；rename 目标是目录 → persist 必失败
    await mkdir(devicesFilePath(dir), { recursive: true })
    const store = await loadDevices(dir)
    const token = generateDeviceToken()
    store.add({ token, name: '重试机' }, 1_000) // add 内部同步 persist 失败被吞，设备仅在内存
    await expect(store.flush()).rejects.toThrow() // flush 失败，dirty 必须保留
    await rm(devicesFilePath(dir), { recursive: true })
    await store.flush() // dirty 仍在 → 重试落盘成功
    const reloaded = await loadDevices(dir)
    expect(reloaded.verify(token)?.name).toBe('重试机')
    expect(reloaded.list()).toHaveLength(1)
  })

  it('重启加载：损坏文件当全新表，合法文件恢复设备', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-remote-test-'))
    const store = await loadDevices(dir)
    const token = generateDeviceToken()
    const device = store.add({ token, name: '笔电' }, 1_000)
    await store.flush()
    const reloaded = await loadDevices(dir)
    expect(reloaded.verify(token)?.name).toBe('笔电')
    expect(reloaded.list()).toHaveLength(1)
    await writeFileRaw(devicesFilePath(dir), '{broken')
    const fresh = await loadDevices(dir)
    expect(fresh.list()).toHaveLength(0)
  })
})

async function writeFileRaw(path: string, content: string): Promise<void> {
  await writeFile(path, content, 'utf8')
}
