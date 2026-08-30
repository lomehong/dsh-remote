export type SemVer = readonly [number, number, number];
/** 'v0.1.2' / '0.1.2' → [0,1,2]；容忍 '-'/'+' 等后缀（忽略）；残缺/垃圾 → null */
export declare function parseSemver(v: string): SemVer | null;
/** a>b → 1，a<b → -1，相等 → 0（逐段数字比较，非字符串序） */
export declare function compareSemver(a: SemVer, b: SemVer): number;
/**
 * 从 GitHub tags 名单挑目标标签：过滤 `^v数字` 与可解析项，
 * 取严格新于 current 的最大者；无 → null。current 无法解析时仍取最大（尽力可用）。
 */
export declare function pickLatestTag(names: string[], current: string): string | null;
export interface TarEntry {
    name: string;
    data: Buffer;
}
/** 最小 tar 解析：512 字节头，普通文件（typeflag '0' 或 NUL）抽取；pax/longname 跳过（见文件头限制说明） */
export declare function tarExtractEntries(buf: Buffer): TarEntry[];
/** gzip 解包 + tar 解析（apply 的真实入口） */
export declare function extractTarGz(buf: Buffer): TarEntry[];
/**
 * 覆盖范围裁剪：归档内只保留 package.json 与 lib/**，剥离归档根前缀（换装时写入 staging 根）。
 * 根目录名不固定——GitHub codeload 归档是 <repo>-<ref>/（如 dsh-remote-0.1.2/），
 * 此处取全体条目的公共首段作为根并剥离；首段不一致视为无法识别的归档（返回空，调用方报错中止）。
 * 含 '..' 或反斜杠的条目一律拒绝（win32 把 \ 当分隔符，反斜杠路径可逃逸暂存区）。
 */
export declare function overlayEntries(entries: TarEntry[]): TarEntry[];
export interface InstallLayout {
    /** lstat 报告包目录本身是符号链接（junction/软链安装，常见于开发态） */
    isSymlink: boolean;
    /** realpath(包目录) ≠ 包目录（经由链接进入源码树） */
    realpathDiffers: boolean;
}
export type InstallDecision = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** 符号链接安装 = 开发模式：就地覆盖会污染源码树，拒绝自更新 */
export declare function decideUpdateInstall(layout: InstallLayout): InstallDecision;
/** 用真实文件系统探测包目录布局（在 apply 里调用） */
export declare function inspectInstallLayout(pkgDir: string): InstallLayout;
/**
 * 插件包根目录：lib/update.js 的上两级（lib/ 的父目录）。
 * 开发仓内 src/update.ts 同理落到仓根——两处都有 package.json，读取口径一致。
 */
export declare function packageDir(): string;
/** 当前版本：包根 package.json 的 version 字段 */
export declare function currentVersion(pkgDir: string): string;
/** 「已应用待重启」标记（.update-pending 内容 = 新版本号）；无标记 → null */
export declare function pendingVersion(pkgDir: string): string | null;
/** 重启后清除待生效标记（新进程加载即视为已生效），由插件装配层在启动时调用 */
export declare function clearPendingMarker(pkgDir: string): void;
/** 最新发布标签：tags API（10s 超时）→ pickLatestTag；失败抛中文错误（调用方决定如何呈现） */
export declare function latestTag(current: string): Promise<string | null>;
export interface UpdateCheck {
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    /** 「已应用待重启」标记里的新版本（非 null 时 UI 提示重启生效） */
    pendingVersion: string | null;
}
/** 检查更新：当前版本 + GitHub 最新标签。网络失败原样抛出（HTTP 层转「检查失败」提示） */
export declare function checkUpdate(pkgDir?: string): Promise<UpdateCheck>;
export interface UpdateStatus {
    applying: boolean;
    phase: string;
    lastError: string;
}
export declare function updateStatus(): UpdateStatus;
/** staging 校验：package.json 版本 === 目标版本，且 lib/index.js 在位（换装前的最后防线） */
export declare function verifyStaging(stagingDir: string, expectedVersion: string): void;
/**
 * 换装：旧 lib 与旧 package.json 一并移入备份目录 lib.bak-<ts>（此前清掉更早备份，
 * 恰留 1 份）→ staging 的 lib 与 package.json 顶上 → 写 .update-pending。
 * 开始后任一步失败都尽力回滚：移除半就位的新内容，把备份目录里的旧 lib 与旧
 * package.json 原样还原——元数据不同滚会让 semver 守卫挡住重试（新版本号 + 旧 lib）。
 * 回滚也失败的极端情况保留备份目录供手工恢复；全部成功才清理 staging。
 */
export declare function swapInPlace(pkgDir: string, stagingDir: string, expectedVersion: string): void;
/**
 * 应用更新（后台任务，单飞）：下载 → 解压到 staging → 校验 → 换装（备份/回滚）→
 * 写待重启标记。进度写入内存 status（check 端点回报）；失败记入 lastError 并重新抛出。
 */
export declare function applyUpdate(tag: string, log?: (line: string) => void): Promise<void>;
