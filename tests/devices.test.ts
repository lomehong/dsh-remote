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
