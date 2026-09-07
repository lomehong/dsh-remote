import { afterEach, describe, expect, it } from 'vitest'
import { resolveDeviceName } from '../src/hostname.ts'

describe('resolveDeviceName（sso-verify 自报御驿登记名）', () => {
  const saved = process.env.YUYI_DEVICE
  afterEach(() => {
    if (saved === undefined) delete process.env.YUYI_DEVICE
    else process.env.YUYI_DEVICE = saved
  })

  it('显式配置最高优先', () => {
    process.env.YUYI_DEVICE = 'env-device'
    expect(resolveDeviceName('configured-name')).toBe('configured-name')
    expect(resolveDeviceName('  spaced  ')).toBe('spaced')
  })

  it('YUYI_DEVICE 环境变量次之', () => {
    process.env.YUYI_DEVICE = 'env-device'
    expect(resolveDeviceName()).toBe('env-device')
    expect(resolveDeviceName('')).toBe('env-device') // 空配置视同未配
  })

  it('皆无 → 回退 ~/.yuyi/env 或 OS 主机名（非空即合格）', () => {
    delete process.env.YUYI_DEVICE
    const name = resolveDeviceName()
    expect(typeof name).toBe('string')
    expect(name.length).toBeGreaterThan(0)
  })
})
