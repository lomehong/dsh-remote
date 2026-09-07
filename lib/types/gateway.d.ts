/**
 * 远程访问网关：带配对认证的反向代理。
 * - /__remote/pair 与 /__remote/exchange 是仅有的认证豁免端点，均按 IP 限速：
 *   pair（GET 浏览器流 303+cookie；POST 桌面流 JSON token）；
 *   exchange（POST {jwt} → 御符 sso-verify 验签 → 签实例级短 TTL 设备令牌，
 *   与配对响应同形状，instance-address-report 契约 §sso-verify/形态 B）
 * - 其余一切请求/upgrade 须持有效凭证（cookie dsh_remote 或 x-remote-token 头）才透传
 * - 无效令牌尝试计入限速（防爆破）；裸 401 不计（浏览器首访是正常路径）
 */
import { type IncomingMessage } from 'node:http';
import { type Upstream } from './proxy.ts';
import { type PairingStore } from './tokens.ts';
import type { DeviceStore } from './devices.ts';
import type { SsoVerifyResult } from './sso.ts';
export declare const REMOTE_COOKIE = "dsh_remote";
/** exchange 签发的实例级令牌 TTL（契约：≤24h，桌面侧随刷新重取）。 */
export declare const EXCHANGE_TOKEN_TTL_MS: number;
export interface GatewayOptions {
    bind: string;
    port: number;
    upstream: Upstream;
    store: DeviceStore;
    pairings: PairingStore;
    /** SSO exchange 的验签函数（默认走御符 sso-verify；测试注入桩）。缺省 = exchange 端点 503。 */
    verifySso?: (jwt: string) => Promise<SsoVerifyResult>;
    log: (line: string) => void;
    now?: () => number;
}
export interface GatewayHandle {
    /** 实际监听端口（配置 port=0 时由 OS 分配）。 */
    port: number;
    close(): Promise<void>;
}
/** 从请求提取凭证：x-remote-token 头优先，其次 cookie（浏览器路径）。 */
export declare function credentialToken(req: Pick<IncomingMessage, 'headers'>): string | undefined;
export declare function startGateway(options: GatewayOptions): Promise<GatewayHandle>;
