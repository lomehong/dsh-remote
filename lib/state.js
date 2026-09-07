/**
 * 网关状态暴露（instance-address-report 契约 §1，
 * dsh-desktop docs/plans/2026-09-04-instance-address-report.md）：
 * dsh-remote 是 address 的事实产生者——网关绑定成功后把对外 authority 写进宿主内状态文件
 * `<dsh-home>/plugins/dsh-remote/gateway-state.json`（原子写），yuyi 通道心跳读取并以
 * remoteGateway 字段透传给御符（dsh-remote 不直连御符、不持任何御符凭证）。
 *
 * 契约形状：
 * - 网关监听中：{ "address": "<host>:<port>", "enabled": true, "startedAt": <ms> }
 * - 停用/关闭：{ "enabled": false }（区分「未安装」（文件不存在）与「已停用」）
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { listAddresses } from "./addresses.js";
export function gatewayStatePath(homeDir) {
    return join(homeDir, 'plugins', 'dsh-remote', 'gateway-state.json');
}
function isLoopback(host) {
    return host === '::1' || host.startsWith('127.');
}
/** 未指定通配地址（0.0.0.0 / :: / 空）判定。 */
function isWildcard(bind) {
    const b = bind.trim();
    return b === '' || b === '0.0.0.0' || b === '::' || b === '::0';
}
/**
 * 对外 authority 的 host 选取（与配对链接同一套地址来源，复用 listAddresses 的
 * LAN 优先 → Tailscale 顺序）：
 * - bind 为具体非回环地址（如 Tailscale 单接口绑定）→ 直接用 bind
 * - bind 为通配（默认 0.0.0.0）→ 首个非回环网卡地址
 * - bind 为回环（纯本机用法）→ undefined：网关不在任何可达地址上，不暴露误导性 address
 */
export function advertisedAddress(bind, port, ifaces = listAddresses()) {
    const b = bind.trim();
    if (!isWildcard(b)) {
        if (isLoopback(b))
            return undefined;
        return `${b}:${port}`;
    }
    const first = ifaces[0];
    return first === undefined ? undefined : `${first.ip}:${port}`;
}
/**
 * 原子写状态文件（临时文件 + 重命名，与 devices.ts 同款）。
 * 抛错由调用方记录——状态暴露失败绝不阻断网关本身。
 */
export function writeGatewayState(homeDir, state) {
    const path = gatewayStatePath(homeDir);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
    try {
        writeFileSync(tmp, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
        renameSync(tmp, path);
    }
    catch (err) {
        try {
            unlinkSync(tmp); // best-effort 清理，避免遗留孤儿 tmp
        }
        catch {
            // tmp 可能尚未创建
        }
        throw err;
    }
}
