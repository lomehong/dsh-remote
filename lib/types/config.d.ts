/** remote: 节的运行时形态与规范化（YAML 手改 / UI 提交共用；schema 校验由 settings 服务兜底）。 */
export interface RemoteConfig {
    enabled: boolean;
    port: number;
    bind: string;
    /** 御符 sso-verify 内省端点（exchange 登录即连用；形态 B 契约）。 */
    ssoVerify: string;
    /** sso-verify 自报设备名（御驿 device 登记名）；缺省自动解析（YUYI_DEVICE env → ~/.yuyi/env → OS 主机名）。 */
    deviceName?: string;
}
export declare const REMOTE_DEFAULTS: RemoteConfig;
export declare function normalizeConfigInput(payload: unknown): RemoteConfig;
