import { type AddressInfo } from './addresses.ts';
export interface GatewayState {
    /** 可直连的网关 authority（host:port）；无可对外地址时缺省（yuyi 侧按字段缺省处理）。 */
    address?: string;
    enabled: boolean;
    startedAt?: number;
}
export declare function gatewayStatePath(homeDir: string): string;
/**
 * 对外 authority 的 host 选取（与配对链接同一套地址来源，复用 listAddresses 的
 * LAN 优先 → Tailscale 顺序）：
 * - bind 为具体非回环地址（如 Tailscale 单接口绑定）→ 直接用 bind
 * - bind 为通配（默认 0.0.0.0）→ 首个非回环网卡地址
 * - bind 为回环（纯本机用法）→ undefined：网关不在任何可达地址上，不暴露误导性 address
 */
export declare function advertisedAddress(bind: string, port: number, ifaces?: AddressInfo[]): string | undefined;
/**
 * 原子写状态文件（临时文件 + 重命名，与 devices.ts 同款）。
 * 抛错由调用方记录——状态暴露失败绝不阻断网关本身。
 */
export declare function writeGatewayState(homeDir: string, state: GatewayState): void;
