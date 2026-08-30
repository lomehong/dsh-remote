/**
 * 自更新：从 GitHub 标签 tarball 覆盖安装（设置页「软件更新」后端）。
 *
 * - 源：tags API（api.github.com）过滤 `^v数字` 后按 semver 取最大且严格新于当前者；
 *   tarball 用 codeload 的 tag 归档（HTTP 200，跟随重定向，60s 硬上限）
 * - 覆盖范围（overlay scope）：只替换 lib/** 与 package.json。绝不触碰 cordis.patch.yml
 *   （bundle 行由用户配置管理）；src/ 在 git 安装下可能保持旧内容——无害（运行时只加载 lib）
 * - 安装布局防护：包目录是符号链接（junction/软链指进源码检出）或 realpath 与自身不一致
 *   → 拒绝自更新（就地替换会污染源码树），提示改用 git pull
 * - 失败安全：下载/解压/校验全部发生在 .update-staging/（包目录内），staging 的
 *   package.json 版本 === 目标版本且 lib/index.js 在位后才换装；换装一旦开始，
 *   任何一步失败都尽力回滚（lib.bak-<ts> 还原为 lib），绝不留下半应用状态
 * - 可测性：纯函数（semver/tar/overlay/布局判定）与网络/文件系统完全解耦，
 *   网络函数是薄包装；fs 侧只在 swap/verify 触碰真实文件系统
 *
 * 已知限制：tar 解析按 512 字节头 + ustar prefix 实现，跳过 pax 扩展头与 GNU longname
 * （typeflag x/g/L）——dsh-remote 归档路径浅（package/lib/...），用不到长名字。
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import https from 'node:https'

const REPO = 'lomehong/dsh-remote'
const TAGS_API = `https://api.github.com/repos/${REPO}/tags`
/** 请求 UA（GitHub API 要求）；同时自证来源便于排障 */
const USER_AGENT = 'dsh-remote-self-update'
/** tarball 大小上限：本插件归档远小于此，超限视为异常响应 */
const TARBALL_MAX_BYTES = 32 * 1024 * 1024
const TAGS_TIMEOUT_MS = 10_000
const TARBALL_TIMEOUT_MS = 60_000

// ───────────────────────────── 纯函数：semver ─────────────────────────────

export type SemVer = readonly [number, number, number]

/** 'v0.1.2' / '0.1.2' → [0,1,2]；容忍 '-'/'+' 等后缀（忽略）；残缺/垃圾 → null */
export function parseSemver(v: string): SemVer | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(v)
  if (m === null) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

/** a>b → 1，a<b → -1，相等 → 0（逐段数字比较，非字符串序） */
export function compareSemver(a: SemVer, b: SemVer): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/**
 * 从 GitHub tags 名单挑目标标签：过滤 `^v数字` 与可解析项，
 * 取严格新于 current 的最大者；无 → null。current 无法解析时仍取最大（尽力可用）。
 */
export function pickLatestTag(names: string[], current: string): string | null {
  const cur = parseSemver(current)
  let best: SemVer | null = null
  let bestName: string | null = null
  for (const name of names) {
    if (!/^v\d/.test(name)) continue
    const v = parseSemver(name)
    if (v === null) continue
    if (cur !== null && compareSemver(v, cur) <= 0) continue
    if (best === null || compareSemver(v, best) > 0) {
      best = v
      bestName = name
    }
  }
  return bestName
}

// ───────────────────────────── 纯函数：tar ─────────────────────────────

export interface TarEntry {
  name: string
  data: Buffer
}

function headerString(header: Buffer, offset: number, length: number): string {
  return header.subarray(offset, offset + length).toString('utf8').split('\0')[0] ?? ''
}

function headerOctal(header: Buffer, offset: number, length: number): number {
  const raw = headerString(header, offset, length).trim()
  if (raw === '') return 0
  const n = parseInt(raw, 8)
  return Number.isFinite(n) && n >= 0 ? n : 0
}

/** 最小 tar 解析：512 字节头，普通文件（typeflag '0' 或 NUL）抽取；pax/longname 跳过（见文件头限制说明） */
export function tarExtractEntries(buf: Buffer): TarEntry[] {
  const entries: TarEntry[] = []
  let off = 0
  while (off + 512 <= buf.length) {
    const header = buf.subarray(off, off + 512)
    // 全零块：归档结束
    if (header.every((b) => b === 0)) break
    const size = headerOctal(header, 124, 12)
    const typeflag = header.length >= 157 ? String.fromCharCode(header[156]) : '\0'
    off += 512
    const dataStart = off
    off += Math.ceil(size / 512) * 512
    if (off > buf.length) break // 截断：丢弃残条目
    if (typeflag !== '0' && typeflag !== '\0') continue // 目录/链接/pax/longname：跳过
    const name = headerString(header, 0, 100)
    const prefix = headerString(header, 345, 155) // ustar 前缀字段
    const fullName = prefix !== '' ? `${prefix}/${name}` : name
    entries.push({ name: fullName, data: Buffer.from(buf.subarray(dataStart, dataStart + size)) })
  }
  return entries
}

/** gzip 解包 + tar 解析（apply 的真实入口） */
export function extractTarGz(buf: Buffer): TarEntry[] {
  return tarExtractEntries(gunzipSync(buf))
}

/**
 * 覆盖范围裁剪：只保留 package/package.json 与 package/lib/**，
 * 剥离 'package/' 前缀（换装时写入 staging 根）；含 '..' 的条目一律拒绝（防路径穿越）。
 */
export function overlayEntries(entries: TarEntry[]): TarEntry[] {
  const out: TarEntry[] = []
  for (const e of entries) {
    if (e.name === 'package/package.json') {
      out.push({ name: 'package.json', data: e.data })
      continue
    }
    if (e.name.startsWith('package/lib/')) {
      const rel = e.name.slice('package/'.length)
      if (rel.split('/').includes('..')) continue // 路径穿越：拒绝
      out.push({ name: rel, data: e.data })
    }
  }
  return out
}

// ─────────────────────── 纯函数：安装布局判定（防护） ───────────────────────

export interface InstallLayout {
  /** lstat 报告包目录本身是符号链接（junction/软链安装，常见于开发态） */
  isSymlink: boolean
  /** realpath(包目录) ≠ 包目录（经由链接进入源码树） */
  realpathDiffers: boolean
}

export type InstallDecision = { ok: true } | { ok: false; reason: string }

/** 符号链接安装 = 开发模式：就地覆盖会污染源码树，拒绝自更新 */
export function decideUpdateInstall(layout: InstallLayout): InstallDecision {
  if (layout.isSymlink || layout.realpathDiffers) {
    return { ok: false, reason: '检测到符号链接安装（开发模式），请用 git pull 更新源码目录' }
  }
  return { ok: true }
}

/** 用真实文件系统探测包目录布局（在 apply 里调用） */
export function inspectInstallLayout(pkgDir: string): InstallLayout {
  let isSymlink = false
  try {
    isSymlink = lstatSync(pkgDir).isSymbolicLink()
  } catch { /* 读不到按非链接处理，后续步骤自会报错 */ }
  let realpathDiffers = false
  try {
    realpathDiffers = realpathSync(pkgDir) !== pkgDir
  } catch { /* 同上 */ }
  return { isSymlink, realpathDiffers }
}

// ───────────────────────────── 路径与版本读取 ─────────────────────────────

/**
 * 插件包根目录：lib/update.js 的上两级（lib/ 的父目录）。
 * 开发仓内 src/update.ts 同理落到仓根——两处都有 package.json，读取口径一致。
 */
export function packageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/** 当前版本：包根 package.json 的 version 字段 */
export function currentVersion(pkgDir: string): string {
  const raw = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { version?: unknown }
  return typeof raw.version === 'string' ? raw.version : ''
}

/** 「已应用待重启」标记（.update-pending 内容 = 新版本号）；无标记 → null */
export function pendingVersion(pkgDir: string): string | null {
  try {
    const v = readFileSync(join(pkgDir, '.update-pending'), 'utf8').trim()
    return v === '' ? null : v
  } catch {
    return null
  }
}

/** 重启后清除待生效标记（新进程加载即视为已生效），由插件装配层在启动时调用 */
export function clearPendingMarker(pkgDir: string): void {
  rmSync(join(pkgDir, '.update-pending'), { force: true })
}

// ───────────────────────────── 网络（薄包装） ─────────────────────────────

/** node:https GET：跟随重定向（≤5）、总时长硬上限、体积上限；成功 resolve 200 响应体 */
function httpsGet(url: string, timeoutMs: number, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let redirects = 0
    const get = (target: string): void => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | undefined
      const fail = (err: Error): void => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        reject(err)
      }
      const req = https.get(target, { headers: { 'user-agent': USER_AGENT, accept: '*/*' } }, (res) => {
        const status = res.statusCode ?? 0
        const location = res.headers.location
        if (status >= 300 && status < 400 && typeof location === 'string' && location !== '') {
          res.resume() // 排干旧响应，转投新地址
          redirects += 1
          if (redirects > 5) {
            fail(new Error('重定向次数过多'))
            return
          }
          try {
            get(new URL(location, target).toString())
          } catch (err) {
            fail(new Error(`重定向地址非法：${err instanceof Error ? err.message : String(err)}`))
          }
          return
        }
        if (status !== 200) {
          res.resume()
          fail(new Error(`HTTP ${status}`))
          return
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            res.destroy()
            fail(new Error(`响应超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限`))
            return
          }
          chunks.push(chunk)
        })
        res.on('end', () => {
          if (settled) return
          settled = true
          if (timer !== undefined) clearTimeout(timer)
          resolve(Buffer.concat(chunks))
        })
        res.on('error', (err) => fail(new Error(`下载失败：${err.message}`)))
      })
      timer = setTimeout(() => {
        req.destroy()
        fail(new Error(`请求超时（${Math.round(timeoutMs / 1000)}s）：${target}`))
      }, timeoutMs)
      req.on('error', (err) => fail(new Error(`网络错误：${err.message}`)))
    }
    get(url)
  })
}

/** 最新发布标签：tags API（10s 超时）→ pickLatestTag；失败抛中文错误（调用方决定如何呈现） */
export async function latestTag(current: string): Promise<string | null> {
  let raw: Buffer
  try {
    raw = await httpsGet(TAGS_API, TAGS_TIMEOUT_MS, 2 * 1024 * 1024)
  } catch (err) {
    throw new Error(`版本列表获取失败：${err instanceof Error ? err.message : String(err)}`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.toString('utf8'))
  } catch {
    throw new Error('版本列表不是合法 JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('版本列表格式异常（非数组）')
  const names: string[] = []
  for (const item of parsed) {
    const name = (item as { name?: unknown } | null)?.name
    if (typeof name === 'string' && name !== '') names.push(name)
  }
  return pickLatestTag(names, current)
}

/** 标签 tarball 下载地址（codeload 归档，跟随重定向，60s 硬上限） */
function tarballUrl(tag: string): string {
  return `https://codeload.github.com/${REPO}/tar.gz/refs/tags/${encodeURIComponent(tag)}`
}

export interface UpdateCheck {
  current: string
  latest: string | null
  updateAvailable: boolean
  /** 「已应用待重启」标记里的新版本（非 null 时 UI 提示重启生效） */
  pendingVersion: string | null
}

/** 检查更新：当前版本 + GitHub 最新标签。网络失败原样抛出（HTTP 层转「检查失败」提示） */
export async function checkUpdate(pkgDir: string = packageDir()): Promise<UpdateCheck> {
  const current = currentVersion(pkgDir)
  const latest = await latestTag(current)
  return { current, latest, updateAvailable: latest !== null, pendingVersion: pendingVersion(pkgDir) }
}

// ───────────────────────────── 应用更新（单飞） ─────────────────────────────

export interface UpdateStatus {
  applying: boolean
  phase: string
  lastError: string
}

/** 内存态进度（跨请求可见；apply 在后台跑，check 端点据此回报） */
const status: UpdateStatus = { applying: false, phase: '', lastError: '' }

export function updateStatus(): UpdateStatus {
  return { ...status }
}

/** staging 校验：package.json 版本 === 目标版本，且 lib/index.js 在位（换装前的最后防线） */
export function verifyStaging(stagingDir: string, expectedVersion: string): void {
  let version = ''
  try {
    const raw = JSON.parse(readFileSync(join(stagingDir, 'package.json'), 'utf8')) as { version?: unknown }
    version = typeof raw.version === 'string' ? raw.version : ''
  } catch {
    throw new Error('暂存区 package.json 缺失或损坏，已中止更新')
  }
  if (version !== expectedVersion) {
    throw new Error(`暂存区版本 ${version} 与目标 ${expectedVersion} 不一致，已中止更新`)
  }
  if (!existsSync(join(stagingDir, 'lib', 'index.js'))) {
    throw new Error('暂存区缺少 lib/index.js，已中止更新')
  }
}

/**
 * 换装：lib → lib.bak-<ts>（此前清掉更早备份，恰留 1 份）→ staging lib 顶上 →
 * 覆盖 package.json → 写 .update-pending。开始后任一步失败都尽力回滚并抛中文错误；
 * 全部成功才清理 staging。
 */
export function swapInPlace(pkgDir: string, stagingDir: string, expectedVersion: string): void {
  verifyStaging(stagingDir, expectedVersion) // 双保险：调用方已验过，这里再拦一道
  const libDir = join(pkgDir, 'lib')
  const bakDir = join(pkgDir, `lib.bak-${Date.now()}`)
  // keep exactly 1 backup：换装前清掉历史备份
  for (const name of readdirSync(pkgDir)) {
    if (name.startsWith('lib.bak-')) rmSync(join(pkgDir, name), { recursive: true, force: true })
  }
  renameSync(libDir, bakDir)
  try {
    renameSync(join(stagingDir, 'lib'), libDir)
    renameSync(join(stagingDir, 'package.json'), join(pkgDir, 'package.json'))
    writeFileSync(join(pkgDir, '.update-pending'), expectedVersion, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    try {
      rmSync(libDir, { recursive: true, force: true }) // 移除可能半就位的新 lib
    } catch { /* 尽力而为 */ }
    try {
      renameSync(bakDir, libDir) // 回滚：旧 lib 原样还原
    } catch {
      // 回滚也失败：保留备份目录供手工恢复（错误信息已带原始原因）
    }
    throw new Error(`更新替换失败，已回滚到旧版本：${msg}`)
  }
  rmSync(stagingDir, { recursive: true, force: true })
}

/**
 * 应用更新（后台任务，单飞）：下载 → 解压到 staging → 校验 → 换装（备份/回滚）→
 * 写待重启标记。进度写入内存 status（check 端点回报）；失败记入 lastError 并重新抛出。
 */
export async function applyUpdate(tag: string, log?: (line: string) => void): Promise<void> {
  if (status.applying) throw new Error('已有更新任务进行中，请稍候')
  if (!/^v\d[\w.\-]{0,30}$/.test(tag)) throw new Error(`非法版本标签：${tag}`)
  status.applying = true
  status.lastError = ''
  try {
    status.phase = '准备'
    const pkgDir = packageDir()
    const current = currentVersion(pkgDir)
    const target = parseSemver(tag)
    const cur = parseSemver(current)
    if (target === null || cur === null || compareSemver(target, cur) <= 0) {
      throw new Error(`目标版本 ${tag} 不高于当前版本 ${current}，无需更新`)
    }
    const decision = decideUpdateInstall(inspectInstallLayout(pkgDir))
    if (!decision.ok) throw new Error(decision.reason)

    status.phase = '下载'
    const staging = join(pkgDir, '.update-staging')
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    const tgz = await httpsGet(tarballUrl(tag), TARBALL_TIMEOUT_MS, TARBALL_MAX_BYTES)
    writeFileSync(join(staging, 'pkg.tgz'), tgz)

    status.phase = '解压'
    const files = overlayEntries(extractTarGz(tgz))
    if (files.length === 0) throw new Error('归档中没有可应用的文件（缺 package/lib 或 package/package.json）')
    for (const file of files) {
      const dest = join(staging, file.name)
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, file.data)
    }

    status.phase = '校验'
    verifyStaging(staging, tag.slice(1))

    status.phase = '替换'
    swapInPlace(pkgDir, staging, tag.slice(1))

    status.phase = '完成'
    log?.(`自更新完成：${current} → ${tag}，重启 DSH 后生效`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    status.phase = '失败'
    status.lastError = msg
    log?.(`自更新失败：${msg}`)
    throw err instanceof Error ? err : new Error(msg)
  } finally {
    status.applying = false
  }
}
