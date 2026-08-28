/**
 * dsh-remote 客户端：设置面板顶级「远程访问」Tab（与 模型切换/分身设置 同级）。
 * 经 /dsh-remote/api/* 读写；网关侧凭证仅存在于远端设备。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { RemoteTab } from './RemoteTab.tsx'
import { en, zh, type RemoteKey } from './locales.ts'

export const inject = ['slots', 'locale']

const NS = 'remote'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-remote: copy dictionaries')
  const t = ctx.locale.bind(NS) as (key: RemoteKey) => string

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-remote',
    order: 26,
    label: () => t('nav'),
    locale: NS,
    inject: () => ({ t: (key: RemoteKey) => t(key) }),
  }, RemoteTab))
}
