import { describe, expect, it } from 'vitest'
import { RateLimiter } from '../src/ratelimit.ts'

describe('RateLimiter', () => {
  it('窗口内放行到上限，超限拒绝', () => {
    let now = 1_000_000
    const rl = new RateLimiter(3, 60_000, () => now)
    expect(rl.check('ip1')).toBe(true)
    expect(rl.check('ip1')).toBe(true)
    expect(rl.check('ip1')).toBe(true)
    expect(rl.check('ip1')).toBe(false)
    expect(rl.check('ip2')).toBe(true) // 不同 key 互不影响
  })

  it('窗口翻转后重新放行', () => {
    let now = 1_000_000
    const rl = new RateLimiter(1, 60_000, () => now)
    expect(rl.check('ip1')).toBe(true)
    expect(rl.check('ip1')).toBe(false)
    now += 60_001
    expect(rl.check('ip1')).toBe(true)
  })
})
