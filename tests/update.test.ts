/**
 * 自更新测试：核心逻辑全部走纯函数（无网络/文件系统依赖），
 * 文件系统只做 2-3 个临时目录集成用例（换装/回滚/校验失败）。
 * tar 夹具在测试内用 512 字节头手工构造（gzip 走 node:zlib），不依赖外部夹具文件。
 */
import { describe, expect, it } from 'vitest'
import { gzipSync } from 'node:zlib'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareSemver,
  decideUpdateInstall,
  extractTarGz,
  overlayEntries,
  parseSemver,
  pickLatestTag,
  swapInPlace,
  tarExtractEntries,
  verifyStaging,
  type TarEntry,
} from '../src/update.ts'

/** 构造 512 字节 ustar 头（name/size/typeflag/prefix；校验和按规范回填，尽管解析器不校验）。 */
function tarHeader(name: string, size: number, typeflag = '0', prefix = ''): Buffer {
  const b = Buffer.alloc(512)
  b.write(name, 0, 100, 'utf8')
  b.write('0000644', 100, 8, 'utf8') // mode
  b.write('0000000', 108, 8, 'utf8') // uid
  b.write('0000000', 116, 8, 'utf8') // gid
  b.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'utf8') // size：11 位八进制 + NUL
  b.write('00000000000', 136, 12, 'utf8') // mtime
  b.write('        ', 148, 8, 'utf8') // checksum 先置空格再累计
  b.write(typeflag, 156, 1, 'utf8')
  b.write('ustar\0', 257, 6, 'utf8')
  b.write('00', 263, 2, 'utf8')
  b.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const byte of b) sum += byte
  b.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'utf8')
  return b
}

/** 把若干条目拼成完整 tar（数据 512 对齐 + 1024 结束块）。 */
function tarOf(entries: Array<{ name: string; data: Buffer; typeflag?: string; prefix?: string }>): Buffer {
  const parts: Buffer[] = []
  for (const e of entries) {
    parts.push(tarHeader(e.name, e.data.length, e.typeflag ?? '0', e.prefix ?? ''))
    const padded = Buffer.alloc(Math.ceil(e.data.length / 512) * 512)
    e.data.copy(padded)
    parts.push(padded)
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}

const buf = (s: string): Buffer => Buffer.from(s, 'utf8')

describe('semver 解析与比较（纯函数）', () => {
  it('parseSemver：v 前缀可选、junk 后缀容忍、垃圾返回 null', () => {
    expect(parseSemver('0.1.2')).toEqual([0, 1, 2])
    expect(parseSemver('v0.1.2')).toEqual([0, 1, 2])
    expect(parseSemver('v0.1.2-rc.1')).toEqual([0, 1, 2]) // 后缀忽略
    expect(parseSemver('v1.2')).toBeNull()
    expect(parseSemver('latest')).toBeNull()
    expect(parseSemver('')).toBeNull()
  })

  it('compareSemver：按数字而非字符串比较', () => {
    expect(compareSemver([0, 1, 2], [0, 1, 2])).toBe(0)
    expect(compareSemver([0, 1, 9], [0, 1, 10])).toBeLessThan(0) // 字符串序会判错
    expect(compareSemver([0, 2, 0], [0, 1, 99])).toBeGreaterThan(0)
    expect(compareSemver([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0)
  })
})

describe('pickLatestTag（纯函数，GitHub tags 名单 → 目标标签）', () => {
  it('数字序取最大且严格新于当前', () => {
    expect(pickLatestTag(['v0.1.1', 'v0.1.2', 'v0.1.10'], '0.1.2')).toBe('v0.1.10')
    expect(pickLatestTag(['v0.1.1', 'v0.1.2'], '0.1.1')).toBe('v0.1.2')
  })

  it('junk 标签被过滤（非 v数字 前缀 / 无法解析）', () => {
    expect(pickLatestTag(['latest', 'vX.Y.Z', '', 'v0.1.1'], '0.1.0')).toBe('v0.1.1')
  })

  it('无更新可用 → null（含等于当前版本）', () => {
    expect(pickLatestTag(['v0.1.1'], '0.1.1')).toBeNull()
    expect(pickLatestTag(['v0.1.0', 'v0.0.9'], '0.1.1')).toBeNull()
    expect(pickLatestTag([], '0.1.1')).toBeNull()
  })

  it('当前版本无法解析时仍取最大标签', () => {
    expect(pickLatestTag(['v0.1.1', 'v0.2.0'], 'dev')).toBe('v0.2.0')
  })
})

describe('tar 解析（纯函数，测试内构造真实 tar 字节）', () => {
  const entries: Array<{ name: string; data: Buffer }> = [
    { name: 'package/package.json', data: buf('{"version":"9.9.9"}') },
    { name: 'package/lib/index.js', data: buf('console.log(1)\n') },
    { name: 'package/lib/deep/x.js', data: buf('x') },
  ]

  it('tarExtractEntries：返回全部普通文件条目，数据逐字节一致', () => {
    const out = tarExtractEntries(tarOf(entries))
    expect(out).toHaveLength(3)
    expect(out.map((e) => e.name)).toEqual(['package/package.json', 'package/lib/index.js', 'package/lib/deep/x.js'])
    expect(out[0]!.data.toString()).toBe('{"version":"9.9.9"}')
    expect(out[2]!.data.toString()).toBe('x')
  })

  it('目录条目（typeflag 5）被跳过；ustar prefix 字段参与全名拼接', () => {
    const tar = tarOf([
      { name: 'package/lib/', data: buf(''), typeflag: '5' },
      { name: 'index.js', data: buf('hi'), prefix: 'package/lib' },
    ])
    const out = tarExtractEntries(tar)
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('package/lib/index.js')
    expect(out[0]!.data.toString()).toBe('hi')
  })

  it('extractTarGz：gzip 解包后解析（覆盖 apply 的真实入口）', () => {
    const out = extractTarGz(gzipSync(tarOf(entries)))
    expect(out).toHaveLength(3)
    expect(out[1]!.data.toString()).toBe('console.log(1)\n')
  })

  it('垃圾/截断输入不抛异常（junk 容忍）', () => {
    expect(tarExtractEntries(buf('garbage'))).toEqual([])
    expect(tarExtractEntries(Buffer.alloc(0))).toEqual([])
    expect(extractTarGz(gzipSync(buf('not a tar at all, but long enough'))).length).toBeLessThanOrEqual(1)
  })
})

describe('overlayEntries（纯函数：只保留 package.json + lib/**，剥离归档根前缀）', () => {
  const all: TarEntry[] = [
    { name: 'package/package.json', data: buf('{}') },
    { name: 'package/lib/index.js', data: buf('a') },
    { name: 'package/lib/sub/b.js', data: buf('b') },
    { name: 'package/src/index.ts', data: buf('skip') },
    { name: 'package/README.md', data: buf('skip') },
    { name: 'package/cordis.patch.yml', data: buf('skip') },
  ]

  it('范围裁剪 + 前缀剥离', () => {
    expect(overlayEntries(all).map((e) => e.name)).toEqual(['package.json', 'lib/index.js', 'lib/sub/b.js'])
  })

  it('路径穿越（..）与反斜杠条目被拒绝（win32 join 会解析 \\，防逃逸暂存区）', () => {
    const evil: TarEntry[] = [
      { name: 'package/lib/../../../etc/passwd', data: buf('evil') },
      { name: 'package/lib/..\\..\\evil.js', data: buf('evil') },
      { name: 'package/lib\\evil.js', data: buf('evil') },
      { name: 'package/lib/ok.js', data: buf('ok') },
    ]
    expect(overlayEntries(evil).map((e) => e.name)).toEqual(['lib/ok.js'])
  })

  it('归档根目录不叫 package/ 时同样识别（codeload 实际为 <repo>-<ref>/）', () => {
    const all: TarEntry[] = [
      { name: 'dsh-remote-0.1.2/package.json', data: buf('{}') },
      { name: 'dsh-remote-0.1.2/lib/index.js', data: buf('a') },
      { name: 'dsh-remote-0.1.2/src/index.ts', data: buf('skip') },
    ]
    expect(overlayEntries(all).map((e) => e.name)).toEqual(['package.json', 'lib/index.js'])
  })

  it('多根/无法识别的归档 → 空输出（调用方报错中止）', () => {
    const mixed: TarEntry[] = [
      { name: 'a/package.json', data: buf('{}') },
      { name: 'b/lib/index.js', data: buf('x') },
    ]
    expect(overlayEntries(mixed)).toEqual([])
    expect(overlayEntries([{ name: 'loose-file.js', data: buf('x') }])).toEqual([])
  })

  it('空输入 → 空输出', () => {
    expect(overlayEntries([])).toEqual([])
  })
})

describe('decideUpdateInstall（纯函数：安装布局防护）', () => {
  it('符号链接安装 → 拒绝并给出中文原因', () => {
    const d = decideUpdateInstall({ isSymlink: true, realpathDiffers: false })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain('符号链接')
  })

  it('realpath 与安装目录不一致 → 同样拒绝', () => {
    const d = decideUpdateInstall({ isSymlink: false, realpathDiffers: true })
    expect(d.ok).toBe(false)
    if (!d.ok) expect(d.reason).toContain('符号链接')
  })

  it('常规安装目录 → 放行', () => {
    expect(decideUpdateInstall({ isSymlink: false, realpathDiffers: false })).toEqual({ ok: true })
  })
})

describe('换装（临时目录集成：swap + 备份 + 回滚 + 校验）', () => {
  /** 造一个假安装包目录：lib/index.js + package.json */
  function makePkg(root: string, version: string, indexSrc: string): string {
    const pkgDir = join(root, `pkg-${version}`)
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'lib', 'index.js'), indexSrc)
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'x', version }))
    return pkgDir
  }

  /** 造假暂存区：.update-staging/{lib/**, package.json} */
  function makeStaging(pkgDir: string, version: string): string {
    const staging = join(pkgDir, '.update-staging')
    mkdirSync(join(staging, 'lib'), { recursive: true })
    writeFileSync(join(staging, 'lib', 'index.js'), `// new ${version}`)
    writeFileSync(join(staging, 'lib', 'extra.js'), '// extra')
    writeFileSync(join(staging, 'package.json'), JSON.stringify({ name: 'x', version }))
    return staging
  }

  it('成功换装：lib/package.json 更新、.update-pending 写入、暂存清理、恰留 1 份备份', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-update-'))
    try {
      const pkgDir = makePkg(root, '0.1.1', '// old')
      const staging = makeStaging(pkgDir, '0.1.2')
      // 预置两份旧备份：换装后应只剩最新这一份（keep exactly 1）
      for (const old of ['lib.bak-1', 'lib.bak-2']) {
        mkdirSync(join(pkgDir, old, 'lib'), { recursive: true })
        writeFileSync(join(pkgDir, old, 'lib', 'index.js'), '// ancient')
      }

      swapInPlace(pkgDir, staging, '0.1.2')

      expect(readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')).toBe('// new 0.1.2')
      expect(existsSync(join(pkgDir, 'lib', 'extra.js'))).toBe(true)
      expect(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version).toBe('0.1.2')
      expect(readFileSync(join(pkgDir, '.update-pending'), 'utf8')).toBe('0.1.2')
      expect(existsSync(staging)).toBe(false)
      const backups = readdirSync(pkgDir).filter((n) => n.startsWith('lib.bak-'))
      expect(backups).toHaveLength(1)
      // 备份目录收着旧 lib 与旧 package.json：回滚要靠它完整还原
      expect(readFileSync(join(pkgDir, backups[0]!, 'lib', 'index.js'), 'utf8')).toBe('// old')
      expect(JSON.parse(readFileSync(join(pkgDir, backups[0]!, 'package.json'), 'utf8')).version).toBe('0.1.1')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('暂存校验失败（版本不一致）：抛错且安装目录原样不动', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-update-'))
    try {
      const pkgDir = makePkg(root, '0.1.1', '// orig')
      const staging = makeStaging(pkgDir, '0.9.9')
      expect(() => verifyStaging(staging, '0.1.2')).toThrow(/版本/)
      expect(() => swapInPlace(pkgDir, staging, '0.1.2')).toThrow(/版本/)
      expect(readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')).toBe('// orig')
      expect(existsSync(join(pkgDir, '.update-pending'))).toBe(false)
      // 未开始换装：不应产生备份
      expect(readdirSync(pkgDir).filter((n) => n.startsWith('lib.bak-'))).toHaveLength(0)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('换装后段失败（.update-pending 写入失败）：lib 与 package.json 都回滚到旧版', () => {
    // 回归：旧实现只回滚 lib——新 package.json 落地后 .update-pending 写失败会留下
    // 「新元数据 + 旧 lib」，semver 守卫随即挡住重试。现在元数据必须一并还原。
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-update-'))
    try {
      const pkgDir = makePkg(root, '0.1.1', '// orig')
      const staging = makeStaging(pkgDir, '0.1.3')
      // 让「写 .update-pending」必然失败：同名位置是目录（POSIX EISDIR / Windows EPERM）
      mkdirSync(join(pkgDir, '.update-pending'))

      expect(() => swapInPlace(pkgDir, staging, '0.1.3')).toThrow(/回滚/)

      expect(readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')).toBe('// orig')
      expect(JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')).version).toBe('0.1.1')
      // 备份目录保留（内含旧 lib + 旧 package.json），供人工兜底
      expect(readdirSync(pkgDir).filter((n) => n.startsWith('lib.bak-'))).toHaveLength(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('旧 package.json 缺失（备份失败）：抛「回滚」错误且旧 lib 完整还原', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-remote-update-'))
    try {
      const pkgDir = makePkg(root, '0.1.1', '// orig')
      rmSync(join(pkgDir, 'package.json'))
      const staging = makeStaging(pkgDir, '0.1.3')

      expect(() => swapInPlace(pkgDir, staging, '0.1.3')).toThrow(/回滚/)

      expect(readFileSync(join(pkgDir, 'lib', 'index.js'), 'utf8')).toBe('// orig')
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
