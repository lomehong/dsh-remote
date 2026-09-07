import { describe, expect, it } from 'vitest'
import { normalizeConfigInput } from '../src/config.ts'

describe('normalizeConfigInput', () => {
  it('默认值：关闭 / 3090 / 0.0.0.0 / 内网御符 sso-verify', () => {
    expect(normalizeConfigInput({})).toEqual({
      enabled: false,
      port: 3090,
      bind: '0.0.0.0',
      ssoVerify: 'http://172.20.10.91:18085/api/v1/auth/sso-verify',
    })
  })
  it('ssoVerify 空串回退默认；可覆盖', () => {
    expect(normalizeConfigInput({ ssoVerify: '' }).ssoVerify).toContain('/api/v1/auth/sso-verify')
    expect(normalizeConfigInput({ ssoVerify: 'http://yufu.example/api/v1/auth/sso-verify' }).ssoVerify)
      .toBe('http://yufu.example/api/v1/auth/sso-verify')
  })
  it('port 允许 0（OS 随机，测试用）；拒绝越界', () => {
    expect(normalizeConfigInput({ enabled: true, port: 0 }).port).toBe(0)
    expect(() => normalizeConfigInput({ port: 70_000 })).toThrow()
    expect(() => normalizeConfigInput({ port: -1 })).toThrow()
  })
  it('port 为 null / 空串时归回默认 3090（而非 0）', () => {
    expect(normalizeConfigInput({ port: null }).port).toBe(3090)
    expect(normalizeConfigInput({ port: '' }).port).toBe(3090)
  })
  it('bind 空串回退 0.0.0.0；非对象拒绝', () => {
    expect(normalizeConfigInput({ bind: ' 100.101.2.3 ' }).bind).toBe('100.101.2.3')
    expect(normalizeConfigInput({ bind: '' }).bind).toBe('0.0.0.0')
    expect(() => normalizeConfigInput(null)).toThrow()
    expect(() => normalizeConfigInput('x')).toThrow()
  })
})
