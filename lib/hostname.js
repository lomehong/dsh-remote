/**
 * sso-verify 自报设备名解析（形态 B 契约配套）：
 * 御符按 ai_agents.hostname 匹配 owner——该字段是**御驿 Hub 心跳的 device 登记名**，
 * 不是 OS 主机名（实测：clawith-test 机器 OS hostname=clawith-73294942s4jbu，
 * 登记名=clawith-test，os.hostname() 自报必然 403）。
 *
 * 解析顺序与 dsh-yuyi（service.ts resolveDevice）完全同源：
 *   1. remote.deviceName 显式配置
 *   2. 进程环境变量 YUYI_DEVICE
 *   3. ~/.yuyi/env 文件的 YUYI_DEVICE（设备级共享文件，多 Agent 公共安全——
 *      与 dsh-yuyi 读同一文件同一 KEY）
 *   4. os.hostname()（兜底：无御驿部署的旧形态）
 */
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
/** 读 ~/.yuyi/env 的 YUYI_DEVICE（损坏/缺席容忍：返回 undefined 走下一级）。 */
function yuyiEnvDevice() {
    try {
        const file = join(homedir(), '.yuyi', 'env');
        if (!existsSync(file))
            return undefined;
        for (const line of readFileSync(file, 'utf8').split('\n')) {
            const t = line.trim();
            if (!t || t.startsWith('#'))
                continue;
            const eq = t.indexOf('=');
            if (eq <= 0)
                continue;
            if (t.slice(0, eq).trim() === 'YUYI_DEVICE') {
                const v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
                return v === '' ? undefined : v;
            }
        }
    }
    catch {
        // 读失败视为无文件
    }
    return undefined;
}
export function resolveDeviceName(configured) {
    const c = configured?.trim();
    if (c !== undefined && c !== '')
        return c;
    const env = process.env.YUYI_DEVICE?.trim();
    if (env !== undefined && env !== '')
        return env;
    return yuyiEnvDevice() ?? hostname();
}
