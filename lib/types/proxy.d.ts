import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
export interface Upstream {
    host: string;
    port: number;
}
export declare function upstreamAuthority(upstream: Upstream): string;
export declare function rewriteForwardHeaders(req: Pick<IncomingMessage, 'headers'>, upstream: Upstream): Record<string, string | string[] | undefined>;
export declare function proxyRequest(upstream: Upstream, req: IncomingMessage, res: ServerResponse): void;
/** WebSocket upgrade 转发：握手请求原样转发（connection/upgrade 头恢复），双向字节透传。 */
export declare function proxyUpgrade(upstream: Upstream, req: IncomingMessage, socket: Duplex, head: Buffer): void;
