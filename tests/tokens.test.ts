import { describe, expect, it } from 'vitest'
import { PairingStore, deviceTokenFingerprint, generateDeviceToken, generatePairingCode, tokensMatch } from '../src/tokens.ts'

describe('token 生成', () => {
  it('配对码/设备令牌为非空 base64url 且不重复', () => {
    const a = generatePairingCode()
    const b = generatePairingCode()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    const t1 = generateDeviceToken()
    const t2 = generateDeviceToken()
    expect(t1).not.toBe(t2)
    expect(t1.length).toBeGreaterThanOrEqual(40) // 32 字节 base64url ≈ 43 字符
  })

  it('指纹稳定且不等于明文', () => {
    const t = generateDeviceToken()
    expect(deviceTokenFingerprint(t)).toBe(deviceTokenFingerprint(t))
    expect(deviceTokenFingerprint(t)).not.toContain(t)
  })

  it('tokensMatch：等值为真、不等值为假、长度不同安全返回 false', () => {
    expect(tokensMatch('abc', 'abc')).toBe(true)
    expect(tokensMatch('abc', 'abd')).toBe(false)
    expect(tokensMatch('abc', 'abcd')).toBe(false)
  })
})

describe('PairingStore', () => {
  it('有效码消费一次成功，第二次失败（单次使用）', () => {
    let now = 1_000_000
    const store = new PairingStore(10 * 60_000, () => now)
    const p = store.create()
    expect(store.consume(p.code)).toBe(true)
    expect(store.consume(p.code)).toBe(false)
  })

  it('过期码消费失败', () => {
    let now = 1_000_000
    const store = new PairingStore(60_000, () => now)
    const p = store.create()
    now += 61_000
    expect(store.consume(p.code)).toBe(false)
  })

  it('新码使旧码作废；错误码不消费有效码之外的东西', () => {
    const store = new PairingStore(60_000, () => 1_000_000)
    const p1 = store.create()
    const p2 = store.create()
    expect(store.consume(p1.code)).toBe(false)
    expect(store.consume(p2.code)).toBe(true)
  })
})
