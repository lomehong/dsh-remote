/**
 * 隧道适配器接口（一期占位，不实现）。
 *
 * 设计前提（见 docs/plans/2026-08-28-dsh-remote-design.md）：WAN 场景走组网层
 * （Tailscale 等），插件只做带认证的网关；当未来需要插件自管隧道（frp/cloudflared）
 * 时，实现此接口并在 remote: 配置节挂 `tunnel:` 子节。
 *
 * 契约：
 * - 适配器自行负责外部二进制的获取/升级/生命周期，产出的公网入口必须终结 TLS
 *   并把流量送回网关端口（gateway 把隧道来源视为普通远程客户端，凭证体系不变）
 * - start/stop 幂等；status 供设置页展示隧道状态
 */
export interface TunnelAdapter {
  readonly id: string
  start(): Promise<void>
  stop(): Promise<void>
  status(): Promise<{ running: boolean; publicUrl?: string; detail?: string }>
}
