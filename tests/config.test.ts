import { describe, expect, it } from 'vitest'
import { normalizeConfigInput } from '../src/config.ts'

describe('normalizeConfigInput', () => {
  it('默认值：关闭 / 3090 / 0.0.0.0', () => {
    expect(normalizeConfigInput({})).toEqual({ enabled: false, port: 3090, bind: '0.0.0.0' })
  })
  it('port 允许 0（OS 随机，测试用）；拒绝越界', () => {
    expect(normalizeConfigInput({ enabled: true, port: 0 }).port).toBe(0)
    expect(() => normalizeConfigInput({ port: 70_000 })).toThrow()
    expect(() => normalizeConfigInput({ port: -1 })).toThrow()
  })
  it('bind 空串回退 0.0.0.0；非对象拒绝', () => {
    expect(normalizeConfigInput({ bind: ' 100.101.2.3 ' }).bind).toBe('100.101.2.3')
    expect(normalizeConfigInput({ bind: '' }).bind).toBe('0.0.0.0')
    expect(() => normalizeConfigInput(null)).toThrow()
    expect(() => normalizeConfigInput('x')).toThrow()
  })
})
