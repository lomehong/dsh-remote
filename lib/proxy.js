/**
 * 反向代理核心：网关 → 回环 dsh webserver。
 * - Host 改写为 upstream authority（dsh 的 browser-trust 围栏据此天然放行）
 * - Origin/Referer 里的网关 authority 同步改写（保 dsh 与插件的同源 CSRF 检查成立）
 * - hop-by-hop 头剥离；正文/响应头（含多值 Set-Cookie）原样透传；正文不改写
 */
import { request as httpRequest } from 'node:http';
const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
    'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
export function upstreamAuthority(upstream) {
    return `${upstream.host}:${upstream.port}`;
}
export function rewriteForwardHeaders(req, upstream) {
    const headers = { ...req.headers };
    const gatewayHost = typeof req.headers.host === 'string' ? req.headers.host : undefined;
    const authority = upstreamAuthority(upstream);
    headers.host = authority;
    if (gatewayHost !== undefined) {
        for (const name of ['origin', 'referer']) {
            const value = headers[name];
            if (typeof value === 'string' && value.includes(gatewayHost)) {
                headers[name] = value.replaceAll(gatewayHost, authority);
            }
        }
    }
    for (const name of HOP_BY_HOP)
        delete headers[name];
    return headers;
}
export function proxyRequest(upstream, req, res) {
    const client = httpRequest({
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers: rewriteForwardHeaders(req, upstream),
    });
    client.on('response', (ures) => {
        const headers = {};
        for (const [name, value] of Object.entries(ures.headers)) {
            if (HOP_BY_HOP.has(name.toLowerCase()))
                continue;
            headers[name] = value;
        }
        res.writeHead(ures.statusCode ?? 502, headers);
        ures.pipe(res);
        ures.on('error', () => res.destroy());
    });
    // 客户端中断（如浏览器关页）：pipe 不传播 destroy，必须显式回收上游流，否则上游连接永久泄漏。
    // 必须在 response 之前同步挂上 —— 中断若发生在响应头到达前，response 回调永不执行，此处漏挂即永久泄漏
    res.on('close', () => { if (!res.writableFinished)
        client.destroy(); });
    client.on('error', (error) => {
        if (res.headersSent || res.destroyed) {
            // 头已发出或客户端已断开：无法再回 502，直接断开，避免向已开始的/已死的响应追加错误文本
            res.destroy();
            return;
        }
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(`远程网关无法连接本地 dsh（${upstreamAuthority(upstream)}）：${error.message}`);
    });
    req.pipe(client);
    req.on('error', () => client.destroy());
}
/** WebSocket upgrade 转发：握手请求原样转发（connection/upgrade 头恢复），双向字节透传。 */
export function proxyUpgrade(upstream, req, socket, head) {
    const headers = rewriteForwardHeaders(req, upstream);
    headers.connection = 'upgrade';
    headers.upgrade = String(req.headers.upgrade ?? 'websocket');
    let usocket;
    const teardown = () => {
        // 双向销毁：RST 不产生 FIN，pipe 不会自然结束对端，必须显式回收两侧与上游请求（destroy 幂等）
        socket.destroy();
        usocket?.destroy();
        client.destroy();
    };
    // 握手窗口期（upstream 101 返回前）Node 已摘除 socket 的内部处理，其上没有任何 error 监听；
    // 必须在创建上游请求前同步挂上，否则客户端此刻 RST 的 ECONNRESET 会以 uncaughtException 击穿进程
    socket.on('error', teardown);
    socket.on('close', teardown);
    const client = httpRequest({
        host: upstream.host,
        port: upstream.port,
        method: req.method,
        path: req.url,
        headers,
    });
    client.on('upgrade', (ures, upgraded, uhead) => {
        usocket = upgraded;
        let front = `HTTP/1.1 ${ures.statusCode ?? 101} ${ures.statusMessage ?? ''}\r\n`;
        for (const [name, value] of Object.entries(ures.headers)) {
            if (value === undefined)
                continue;
            for (const v of Array.isArray(value) ? value : [value])
                front += `${name}: ${v}\r\n`;
        }
        socket.write(`${front}\r\n`);
        if (uhead.length > 0)
            socket.write(uhead);
        upgraded.pipe(socket);
        socket.pipe(upgraded);
        upgraded.on('error', teardown);
        upgraded.on('close', teardown);
    });
    client.on('response', (ures) => {
        // upstream 拒绝升级：原样回状态码后断开
        const front = `HTTP/1.1 ${ures.statusCode ?? 502} ${ures.statusMessage ?? ''}\r\nConnection: close\r\n\r\n`;
        socket.write(front);
        socket.end();
    });
    client.on('error', teardown);
    client.end(head.length > 0 ? head : undefined);
}
