import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type RemoteConfig } from './config.ts';
export declare const name = "dsh-remote";
export declare const Config: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    port: z<number, number>;
    bind: z<string, string>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    port: z<number, number>;
    bind: z<string, string>;
}>>;
/** 测试可覆盖的 DSH home：优先专用环境变量，其次宿主 DSH_HOME，兜底 ~/.dsh（对齐 model-failover）。 */
export declare function dshHome(): string;
export declare function apply(ctx: Context, config: RemoteConfig): Promise<void>;
