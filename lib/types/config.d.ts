/** remote: 节的运行时形态与规范化（YAML 手改 / UI 提交共用；schema 校验由 settings 服务兜底）。 */
export interface RemoteConfig {
    enabled: boolean;
    port: number;
    bind: string;
}
export declare const REMOTE_DEFAULTS: RemoteConfig;
export declare function normalizeConfigInput(payload: unknown): RemoteConfig;
