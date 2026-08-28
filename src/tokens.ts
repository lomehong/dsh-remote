/**
 * 配对码与设备令牌：
 * - 配对码：base64url 16 字节（128 位熵），短时效、单次使用、只存内存
 * - 设备令牌：base64url 32 字节（256 位熵），发给设备一次，本地只存 sha256 指纹
 * - 比较一律走常量时间（等长 timingSafeEqual；长度不同直接 false 不构成泄露）
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export function generatePairingCode(): string {
  return randomBytes(16).toString('base64url')
}

export function generateDeviceToken(): string {
  return randomBytes(32).toString('base64url')
}

export function deviceTokenFingerprint(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

export function tokensMatch(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export interface Pairing {
  code: string
  expiresAt: number
}

/** 配对码仓：同时仅一个有效码（新码使旧码作废），消费即删除（单次使用）。 */
export class PairingStore {
  private current: Pairing | null = null

  constructor(
    private ttlMs: number = 10 * 60_000,
    private now: () => number = Date.now,
  ) {}

  create(): Pairing {
    const pairing: Pairing = { code: generatePairingCode(), expiresAt: this.now() + this.ttlMs }
    this.current = pairing
    return pairing
  }

  /** 有效期内且码相符 → true 并立即作废（单次使用）；过期即清除；码不符不清除有效码，一律 false。 */
  consume(code: string): boolean {
    const current = this.current
    if (current === null) return false
    if (this.now() >= current.expiresAt) {
      this.current = null
      return false
    }
    if (!tokensMatch(current.code, code)) return false
    this.current = null
    return true
  }
}
