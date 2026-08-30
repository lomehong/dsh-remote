/**
 * 「远程访问」设置页：四段式——状态与配置镜像、配对、设备管理、软件更新。
 * - 状态/配置控件是只读镜像 + 修改引导：配置保存走宿主设置页通用机制
 *   （installSettingsSection 注册的 remote: 节），此处不臆造宿主写 API
 * - 5 秒轮询 /dsh-remote/api/status 展示监听状态/访问地址/最近事件
 * - 配对：生成一次性配对链接（按局域网/Tailscale 分类），复制到目标设备打开
 * - 设备：重命名（prompt）/ 吊销（confirm），操作后立即刷新
 * - 更新：检查 GitHub 最新标签；GitHub 不可达只提示检查失败，页面其余不受影响；
 *   应用后端后台执行（单飞），此处轮询 check 端点直至结束并提示重启生效
 */
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ChangeEvent } from 'react'
import type { RemoteKey } from './locales.ts'

export interface RemoteTabInjected {
  t: (key: RemoteKey) => string
}

interface AddressInfoDto {
  ip: string
  kind: 'lan' | 'tailscale'
}

interface DeviceDto {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number
}

interface StatusDto {
  ok: boolean
  enabled: boolean
  listening: boolean
  gatewayPort?: number
  port: number
  bind: string
  addresses: AddressInfoDto[]
  devices: DeviceDto[]
  log: string[]
}

/** GET /dsh-remote/api/update/check 响应（GitHub 不可达时 latest 为 null 且带 checkError） */
interface UpdateCheckDto {
  ok: boolean
  current: string
  latest: string | null
  updateAvailable: boolean
  pendingVersion: string | null
  applying: boolean
  lastError: string
  checkError?: string
}

interface AddressLink {
  ip: string
  kind: 'lan' | 'tailscale'
  url: string
}

/** api 调用选项：body 为任意可 JSON 序列化值（区别于 fetch 的 BodyInit） */
interface ApiInit {
  method?: string
  body?: unknown
}

/** fetch + JSON 头（有 body 时）+ 非 2xx 抛错 */
async function api<T>(path: string, init?: ApiInit): Promise<T> {
  const hasBody = init?.body !== undefined
  // exactOptionalPropertyTypes 下不能显式传 undefined，按需构造 RequestInit
  const req: RequestInit = hasBody
    ? { method: init?.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(init?.body) }
    : { method: init?.method ?? 'GET' }
  const res = await fetch(path, req)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text}` : ''}`)
  }
  return await res.json() as T
}

// 颜色接入 dsw-alias 设计令牌，自动适配明暗主题
const c = {
  text: 'var(--dsw-alias-label-primary, #1f2329)',
  textSecondary: 'var(--dsw-alias-label-secondary, #4e5969)',
  bgLayer: 'var(--dsw-alias-bg-layer-1, #f7f8fa)',
  border: 'var(--dsw-alias-separator-primary, #e5e6eb)',
  accent: 'var(--dsw-alias-state-business-primary, #3370ff)',
  danger: 'var(--dsw-alias-state-danger-primary, #f53f3f)',
  success: 'var(--dsw-alias-state-success-primary, #00b42a)',
} as const

const s = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 20, color: c.text,
    fontSize: 13, lineHeight: 1.6,
  } satisfies CSSProperties,
  section: {
    display: 'flex', flexDirection: 'column', gap: 10,
    padding: 14, borderRadius: 8, background: c.bgLayer,
    border: `1px solid ${c.border}`,
  } satisfies CSSProperties,
  sectionTitle: {
    fontSize: 13, fontWeight: 600, margin: 0,
  } satisfies CSSProperties,
  desc: { color: c.textSecondary, margin: 0 } satisfies CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } satisfies CSSProperties,
  input: {
    padding: '4px 8px', borderRadius: 6, border: `1px solid ${c.border}`,
    background: 'var(--dsw-alias-bg-base, #fff)', color: c.text, fontSize: 13,
  } satisfies CSSProperties,
  button: {
    padding: '4px 12px', borderRadius: 6, border: `1px solid ${c.border}`,
    background: 'var(--dsw-alias-bg-base, #fff)', color: c.text,
    fontSize: 13, cursor: 'pointer',
  } satisfies CSSProperties,
  primaryButton: {
    padding: '4px 12px', borderRadius: 6, border: 'none',
    background: c.accent, color: '#fff', fontSize: 13, cursor: 'pointer',
  } satisfies CSSProperties,
  code: {
    fontFamily: 'monospace', fontSize: 12, padding: '2px 6px',
    background: 'var(--dsw-alias-bg-base, #fff)', borderRadius: 4,
    border: `1px solid ${c.border}`, wordBreak: 'break-all',
  } satisfies CSSProperties,
  badge: {
    fontSize: 11, padding: '1px 6px', borderRadius: 4,
    background: c.border, color: c.textSecondary,
  } satisfies CSSProperties,
  hint: { fontSize: 12, color: c.textSecondary, margin: 0 } satisfies CSSProperties,
  log: {
    fontFamily: 'monospace', fontSize: 11, color: c.textSecondary,
    maxHeight: 140, overflowY: 'auto', margin: 0, whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
  } satisfies CSSProperties,
} as const

export function RemoteTab({ t }: RemoteTabInjected): React.ReactElement {
  const [status, setStatus] = useState<StatusDto | null>(null)
  const [loadError, setLoadError] = useState('')
  // 只读镜像：允许编辑，但保存经宿主设置页 remote: 节（见 saveHint 文案）
  const [enabledDraft, setEnabledDraft] = useState(false)
  const [portDraft, setPortDraft] = useState('')
  const [bindDraft, setBindDraft] = useState('')
  const [links, setLinks] = useState<AddressLink[] | null>(null)
  const [copiedUrl, setCopiedUrl] = useState('')
  const copiedTimer = useRef<ReturnType<typeof setTimeout>>(undefined)

  const refresh = useCallback(async () => {
    try {
      const st = await api<StatusDto>('/dsh-remote/api/status')
      setStatus(st)
      setLoadError('')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  // 5 秒轮询状态；卸载时清理复制反馈定时器
  useEffect(() => {
    void refresh()
    const timer = setInterval(() => { void refresh() }, 5000)
    return () => {
      clearInterval(timer)
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
    }
  }, [refresh])

  // 服务端值到达后镜像到本地草稿（仅在草稿未被用户改动前同步即可——简单起见每次轮询都覆盖，
  // 因为保存通道在宿主设置页，这里的编辑只起引导作用）
  useEffect(() => {
    if (status === null) return
    setEnabledDraft(status.enabled)
    setPortDraft(String(status.port))
    setBindDraft(status.bind)
  }, [status])

  const genLink = useCallback(async () => {
    try {
      const res = await api<{ ok: boolean; links: AddressLink[] }>('/dsh-remote/api/pairing', { body: {} })
      setLinks(res.links)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const copy = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url)
      setCopiedUrl(url)
      if (copiedTimer.current !== undefined) clearTimeout(copiedTimer.current)
      copiedTimer.current = setTimeout(() => setCopiedUrl(''), 1500)
    } catch { /* 剪贴板不可用（如非安全上下文）：静默忽略 */ }
  }, [])

  const rename = useCallback(async (id: string) => {
    const name = window.prompt(t('rename'))
    if (name === null || name.trim() === '') return
    try {
      await api('/dsh-remote/api/devices/rename', { body: { id, name: name.trim() } })
      await refresh()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh, t])

  const revoke = useCallback(async (id: string) => {
    if (!window.confirm(t('revokeConfirm'))) return
    try {
      await api('/dsh-remote/api/devices/revoke', { body: { id } })
      await refresh()
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }, [refresh, t])

  // ── 软件更新：检查（GitHub 失败仅提示，不影响页面其余部分）+ 一键应用（后台单飞，轮询进度） ──
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckDto | null>(null)
  const [checkBusy, setCheckBusy] = useState(false)
  const [applyBusy, setApplyBusy] = useState(false)
  const [applyError, setApplyError] = useState('')

  const runCheck = useCallback(async () => {
    setCheckBusy(true)
    setApplyError('')
    try {
      setUpdateInfo(await api<UpdateCheckDto>('/dsh-remote/api/update/check'))
    } catch (err) {
      // check 端点本身不可达（服务异常等）：页面其余部分不受影响
      setUpdateInfo(null)
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setCheckBusy(false)
    }
  }, [])

  const runApply = useCallback(async (tag: string) => {
    setApplyBusy(true)
    setApplyError('')
    try {
      await api('/dsh-remote/api/update/apply', { body: { tag } })
      // 后台任务：轮询 check 直至 applying 结束（服务端下载 60s 硬上限，这里放宽到 120s）
      const deadline = Date.now() + 120_000
      for (;;) {
        await new Promise((r) => setTimeout(r, 1500))
        const st = await api<UpdateCheckDto>('/dsh-remote/api/update/check')
        setUpdateInfo(st)
        if (!st.applying) {
          if (st.lastError !== '') setApplyError(st.lastError)
          break
        }
        if (Date.now() > deadline) {
          setApplyError(t('applyTimeout'))
          break
        }
      }
    } catch (err) {
      setApplyError(err instanceof Error ? err.message : String(err))
    } finally {
      setApplyBusy(false)
    }
  }, [t])

  const updateSection = (() => {
    if (updateInfo === null) return null
    if (updateInfo.checkError !== undefined && updateInfo.checkError !== '') {
      return (
        <p style={{ ...s.hint, color: c.danger }}>
          {t('checkFailed')}：{updateInfo.checkError}
        </p>
      )
    }
    // 已应用待重启：提示置顶（优先于最新版本判断）
    if (updateInfo.pendingVersion !== null) {
      return <p style={{ ...s.hint, color: c.success }}>{t('appliedPending')}（{updateInfo.pendingVersion}）</p>
    }
    if (updateInfo.updateAvailable && updateInfo.latest !== null) {
      return (
        <div style={s.row}>
          <span style={s.badge}>{t('latestVersion')}: {updateInfo.latest}</span>
          <button
            style={s.primaryButton}
            disabled={applyBusy || updateInfo.applying}
            onClick={() => { void runApply(updateInfo.latest!) }}
          >
            {applyBusy || updateInfo.applying ? t('applying') : `${t('updateTo')} ${updateInfo.latest}`}
          </button>
        </div>
      )
    }
    return <p style={s.hint}>{t('upToDate')}</p>
  })()

  const listening = status?.listening ?? false

  return (
    <div style={s.root}>
      <h3 style={{ ...s.sectionTitle, fontSize: 15 }}>{t('title')}</h3>
      <p style={s.desc}>{t('desc')}</p>
      {loadError !== '' && <p style={{ ...s.hint, color: c.danger }}>{loadError}</p>}

      {/* 段一：状态与配置镜像（只读镜像 + 修改引导，不臆造宿主写 API） */}
      <div style={s.section}>
        <h4 style={s.sectionTitle}>{t('status')}</h4>
        <label style={s.row}>
          <input
            type="checkbox"
            checked={enabledDraft}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setEnabledDraft(e.target.checked)}
          />
          {t('enabled')}
        </label>
        <label style={s.row}>
          {t('port')}
          <input style={{ ...s.input, width: 90 }} value={portDraft}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setPortDraft(e.target.value)} />
        </label>
        <label style={s.row}>
          {t('bind')}
          <input style={{ ...s.input, width: 220 }} value={bindDraft}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setBindDraft(e.target.value)} />
        </label>
        <p style={s.hint}>{t('bindHint')}</p>
        <p style={{ ...s.hint, color: c.accent }}>{t('saveHint')}</p>
        <div style={s.row}>
          <span style={s.badge}>{t('status')}: {listening ? t('listening') : t('stopped')}</span>
          {status?.gatewayPort !== undefined && (
            <span style={s.badge}>{t('gwPort')}: {status.gatewayPort}</span>
          )}
        </div>
        {status !== null && status.addresses.length > 0 && (
          <div>
            <p style={s.hint}>{t('addresses')}:</p>
            {status.addresses.map((a) => (
              <div key={`${a.kind}-${a.ip}`} style={s.row}>
                <span style={s.badge}>{a.kind === 'tailscale' ? t('ts') : t('lan')}</span>
                <span style={s.code}>{a.ip}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 段二：配对 */}
      <div style={s.section}>
        <h4 style={s.sectionTitle}>{t('pairing')}</h4>
        <div style={s.row}>
          <button style={s.primaryButton} disabled={!listening} onClick={() => { void genLink() }}>
            {t('genLink')}
          </button>
        </div>
        <p style={s.hint}>{t('linkHint')}</p>
        {links !== null && links.map((l) => (
          <div key={l.url} style={s.row}>
            <span style={s.badge}>{l.kind === 'tailscale' ? t('ts') : t('lan')}</span>
            <span style={s.code}>{l.url}</span>
            <button style={s.button} onClick={() => { void copy(l.url) }}>
              {copiedUrl === l.url ? t('copied') : t('copy')}
            </button>
          </div>
        ))}
      </div>

      {/* 段三：设备管理 */}
      <div style={s.section}>
        <h4 style={s.sectionTitle}>{t('devices')}</h4>
        {status === null || status.devices.length === 0 ? (
          <p style={s.hint}>{t('noDevices')}</p>
        ) : status.devices.map((d) => (
          <div key={d.id} style={s.row}>
            <span style={{ fontWeight: 600 }}>{d.name}</span>
            <span style={s.hint}>{new Date(d.lastSeenAt).toLocaleString()}</span>
            <button style={s.button} onClick={() => { void rename(d.id) }}>{t('rename')}</button>
            <button style={{ ...s.button, color: c.danger }} onClick={() => { void revoke(d.id) }}>
              {t('revoke')}
            </button>
          </div>
        ))}
      </div>

      {/* 最近事件 */}
      <div style={s.section}>
        <h4 style={s.sectionTitle}>{t('recent')}</h4>
        {status === null || status.log.length === 0 ? (
          <p style={s.hint}>—</p>
        ) : (
          <pre style={s.log}>{status.log.join('\n')}</pre>
        )}
      </div>

      {/* 段四：软件更新（自更新：GitHub 标签 → 覆盖 lib + package.json，重启生效） */}
      <div style={s.section}>
        <h4 style={s.sectionTitle}>{t('update')}</h4>
        <div style={s.row}>
          <span style={s.badge}>{t('currentVersion')}: {updateInfo?.current ?? '—'}</span>
          <button style={s.button} disabled={checkBusy || applyBusy} onClick={() => { void runCheck() }}>
            {checkBusy ? t('checking') : t('checkUpdate')}
          </button>
        </div>
        {updateSection}
        {applyError !== '' && <p style={{ ...s.hint, color: c.danger }}>{applyError}</p>}
        <p style={s.hint}>{t('updateHint')}</p>
      </div>
    </div>
  )
}
