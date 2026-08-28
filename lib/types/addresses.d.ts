/**
 * 本机可达地址枚举：LAN IPv4 在前、Tailscale（CGNAT 100.64.0.0/10）在后。
 * 供设置页生成每个地址上的配对链接。
 */
import { type NetworkInterfaceInfo } from 'node:os';
export interface AddressInfo {
    ip: string;
    kind: 'lan' | 'tailscale';
}
/** 纯函数（接口数据注入）便于测试。 */
export declare function classifyAddresses(ifaces: Record<string, NetworkInterfaceInfo[] | undefined>): AddressInfo[];
export declare function listAddresses(): AddressInfo[];
