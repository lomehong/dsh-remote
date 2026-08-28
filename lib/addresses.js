/**
 * 本机可达地址枚举：LAN IPv4 在前、Tailscale（CGNAT 100.64.0.0/10）在后。
 * 供设置页生成每个地址上的配对链接。
 */
import { networkInterfaces } from 'node:os';
/** 纯函数（接口数据注入）便于测试。 */
export function classifyAddresses(ifaces) {
    const lan = [];
    const tailscale = [];
    for (const list of Object.values(ifaces)) {
        for (const iface of list ?? []) {
            if (iface.internal || iface.family !== 'IPv4')
                continue;
            const m = /^100\.(\d+)\.\d+\.\d+$/.exec(iface.address);
            if (m !== null && Number(m[1]) >= 64 && Number(m[1]) <= 127) {
                tailscale.push({ ip: iface.address, kind: 'tailscale' });
            }
            else {
                lan.push({ ip: iface.address, kind: 'lan' });
            }
        }
    }
    return [...lan, ...tailscale];
}
export function listAddresses() {
    return classifyAddresses(networkInterfaces());
}
