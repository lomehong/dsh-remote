/** remote: 节的运行时形态与规范化（YAML 手改 / UI 提交共用；schema 校验由 settings 服务兜底）。 */
export interface RemoteConfig {
  enabled: boolean
  port: number
  bind: string
}

export const REMOTE_DEFAULTS: RemoteConfig = { enabled: false, port: 3090, bind: '0.0.0.0' }

export function normalizeConfigInput(payload: unknown): RemoteConfig {
  if (payload === null || typeof payload !== 'object') throw new Error('配置必须是对象')
  const raw = payload as Record<string, unknown>
  const portNum = typeof raw.port === 'number' ? raw.port : Number(raw.port)
  const port = Number.isFinite(portNum) ? Math.round(portNum) : REMOTE_DEFAULTS.port
  // port 0 = OS 分配（测试/高级用法）；UI 默认 3090
  if (port < 0 || port > 65_535) throw new Error(`port 越界（0-65535）：${raw.port}`)
  const bind = String(raw.bind ?? REMOTE_DEFAULTS.bind).trim() || REMOTE_DEFAULTS.bind
  return { enabled: raw.enabled === true, port, bind }
}
