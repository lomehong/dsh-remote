/**
 * 御符 sso-verify 内省客户端（验签形态 B 配套，
 * dsh-desktop docs/plans/2026-09-04-instance-address-report.md §sso-verify）：
 * POST {jwt, hostname=本机} → 200 {ok:true, uid, usr, rol} 即「验签通过且 uid==owner」；
 * 403 / ok:false = 无效或越权；网络/5xx 异常向上抛（由调用方映射 502）。
 * dsh-remote 只信 verify 的 200，不自持 jwtSecret、不自持 owner。
 */

export interface SsoVerifyResult {
  ok: boolean
  uid?: string
  usr?: string
  rol?: string
}

export async function verifySsoJwt(
  verifyUrl: string,
  jwt: string,
  hostname: string,
  timeoutMs = 10_000,
): Promise<SsoVerifyResult> {
  const resp = await fetch(verifyUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jwt, hostname }),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (resp.status === 403) return { ok: false }
  if (!resp.ok) throw new Error(`sso-verify HTTP ${resp.status}`)
  const body = (await resp.json()) as Record<string, unknown>
  if (body.ok !== true) return { ok: false }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined)
  const uid = str(body.uid)
  const usr = str(body.usr)
  const rol = str(body.rol)
  return { ok: true, ...(uid !== undefined ? { uid } : {}), ...(usr !== undefined ? { usr } : {}), ...(rol !== undefined ? { rol } : {}) }
}
