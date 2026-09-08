/**
 * 远程访问网关：带配对认证的反向代理。
 * - /__remote/pair 与 /__remote/exchange 是仅有的认证豁免端点，均按 IP 限速：
 *   pair（GET 浏览器流 303+cookie；POST 桌面流 JSON token）；
 *   exchange（POST {jwt} → 御符 sso-verify 验签 → 签实例级短 TTL 设备令牌，
 *   与配对响应同形状，instance-address-report 契约 §sso-verify/形态 B）
 * - 其余一切请求/upgrade 须持有效凭证（cookie dsh_remote 或 x-remote-token 头）才透传
 * - 无效令牌尝试计入限速（防爆破）；裸 401 不计（浏览器首访是正常路径）
 */
import { createServer } from 'node:http';
import { proxyRequest, proxyUpgrade, upstreamAuthority } from "./proxy.js";
import { generateDeviceToken } from "./tokens.js";
import { RateLimiter } from "./ratelimit.js";
export const REMOTE_COOKIE = 'dsh_remote';
/** exchange 签发的实例级令牌 TTL（契约：≤24h，桌面侧随刷新重取）。 */
export const EXCHANGE_TOKEN_TTL_MS = 24 * 60 * 60_000;
/** 从请求提取凭证：x-remote-token 头优先，其次 cookie（浏览器路径）。 */
export function credentialToken(req) {
    const header = req.headers['x-remote-token'];
    if (typeof header === 'string' && header !== '')
        return header;
    return cookieValue(req.headers.cookie, REMOTE_COOKIE);
}
function cookieValue(header, name) {
    if (typeof header !== 'string')
        return undefined;
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1)
            continue;
        if (part.slice(0, idx).trim() === name)
            return part.slice(idx + 1).trim();
    }
    return undefined;
}
function clientKey(req) {
    return req.socket.remoteAddress ?? 'unknown';
}
export async function startGateway(options) {
    const { bind, upstream, store, pairings, log } = options;
    const now = options.now ?? Date.now;
    const pairLimiter = new RateLimiter(10, 60_000, now);
    const badTokenLimiter = new RateLimiter(30, 60_000, now);
    // exchange 独立限速（防经 SSO 验签枚举/重放；与 pair 同强度）
    const exchangeLimiter = new RateLimiter(10, 60_000, now);
    const deny = (res, status, message) => {
        if (res.headersSent) {
            res.end();
            return;
        }
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
        res.end(message);
    };
    const rawDeny = (socket, status, message) => {
        socket.write(`HTTP/1.1 ${status} \r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${message}\n`);
        socket.destroy();
    };
    /** 带 Origin 的写请求须同源（与 model-failover sameOrigin 同款；GET/无 Origin 放行）。 */
    const sameOrigin = (req) => {
        const origin = req.headers.origin;
        if (origin === undefined)
            return true;
        const host = req.headers.host;
        if (typeof host !== 'string' || host === '')
            return false;
        try {
            return new URL(String(origin)).host === host;
        }
        catch {
            return false;
        }
    };
    const readBody = (req) => new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size > 4096) {
                reject(new Error('请求体过大'));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
    const server = createServer((req, res) => { void handle(req, res); });
    server.on('upgrade', (req, socket, head) => { handleUpgrade(req, socket, head); });
    async function handle(req, res) {
        try {
            const url = new URL(req.url ?? '/', 'http://gateway.local');
            if (url.pathname === '/__remote/pair') {
                await handlePair(req, res, url);
                return;
            }
            if (url.pathname === '/__remote/exchange') {
                await handleExchange(req, res);
                return;
            }
            const token = credentialToken(req);
            const device = token === undefined ? undefined : store.verify(token);
            if (device === undefined) {
                if (token !== undefined && !badTokenLimiter.check(clientKey(req))) {
                    deny(res, 429, '尝试过于频繁，请稍后再试');
                    return;
                }
                deny(res, 401, '此端口为 dsh 远程访问网关：请先在 dsh 设置页生成配对链接完成配对。');
                return;
            }
            store.touch(device.id, now());
            if (url.pathname === '/__remote/web-auth') {
                // 上游 web 认证桥（rc.1+ 认证模型）：302 到 /?token=<launchToken>（相对路径，
                // 浏览器与桌面反代两种入口都解析到正确 origin）→ 上游验 token 种 30 天会话
                // cookie → 落 / 即可用。旧版宿主无 launch token → 退回 /（上游忽略未知 query，
                // 无害）。本端点在设备凭证之后，未认证请求到不了这里。
                const webToken = options.webLaunchToken?.();
                const location = webToken !== undefined && webToken !== '' ? `/?token=${encodeURIComponent(webToken)}` : '/';
                options.webAuthLog?.(`web-auth 决策：token=${webToken !== undefined && webToken !== '' ? '有' : '无'} → ${location}`);
                res.writeHead(302, { location, 'cache-control': 'no-store' });
                res.end();
                return;
            }
            proxyRequest(upstream, req, res);
        }
        catch (error) {
            log(`网关请求处理异常：${error instanceof Error ? error.message : String(error)}`);
            deny(res, 500, 'internal error');
        }
    }
    async function handlePair(req, res, url) {
        if (!pairLimiter.check(clientKey(req))) {
            deny(res, 429, '配对尝试过于频繁，请稍后再试');
            return;
        }
        let code = url.searchParams.get('code') ?? '';
        let wantsJson = false;
        if (req.method === 'POST') {
            if (!sameOrigin(req)) {
                deny(res, 403, 'cross-origin denied');
                return;
            }
            code = ''; // POST 以正文为准：先清空，杜绝坏正文回退到 query 里的码
            try {
                const parsed = JSON.parse(await readBody(req));
                code = String(parsed.code ?? '');
            }
            catch { /* code 保持空 → 走失败分支 */ }
            wantsJson = true;
        }
        else if (req.method !== 'GET') {
            deny(res, 405, 'method not allowed');
            return;
        }
        // 桌面壳等原生客户端已持 token（POST 配对所得）：GET ?token= 等价“种浏览器 cookie”，
        // 不新建设备、仅 touch；无效 token 走与错误码相同的 403 分支（计入限速）
        const tokenParam = url.searchParams.get('token');
        if (!wantsJson && tokenParam !== null && tokenParam !== '') {
            const known = store.verify(tokenParam);
            if (known === undefined) {
                log(`配对失败（token 无效）来自 ${clientKey(req)}`);
                deny(res, 403, '凭证无效或已被吊销：请在 dsh 设置页重新生成配对链接。');
                return;
            }
            store.touch(known.id, now());
            // 落点改为 web-auth 桥：一次导航种齐 设备 cookie + 上游 30 天会话 cookie
            // （rc.1+ 上游有自己的 token→cookie 认证；旧版宿主 web-auth 退回 /，无害）
            res.writeHead(303, {
                location: '/__remote/web-auth',
                'set-cookie': `${REMOTE_COOKIE}=${tokenParam}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
                'cache-control': 'no-store',
            });
            res.end();
            return;
        }
        if (!pairings.consume(code)) {
            log(`配对失败（码无效或已过期）来自 ${clientKey(req)}`);
            if (wantsJson) {
                res.writeHead(403, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                res.end(JSON.stringify({ ok: false, error: '配对码无效或已过期' }));
                return;
            }
            deny(res, 403, '配对码无效或已过期：请在 dsh 设置页重新生成配对链接。');
            return;
        }
        const token = generateDeviceToken();
        // UA 攻击者可控且随设备记录落盘：截断防御（名称取自时间戳，与 UA 无关）
        const rawUa = req.headers['user-agent'];
        const ua = typeof rawUa === 'string' && rawUa !== '' ? rawUa.slice(0, 200) : undefined;
        const stamp = new Date(now()).toISOString().slice(0, 16).replace('T', ' ');
        const device = store.add({ token, name: `远程设备 ${stamp}`, ...(ua !== undefined ? { ua } : {}) }, now());
        log(`新设备已配对：${device.name}（${device.id}）`);
        if (wantsJson) {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, token, deviceId: device.id, name: device.name }));
            return;
        }
        res.writeHead(303, {
            location: '/__remote/web-auth',
            'set-cookie': `${REMOTE_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`,
            'cache-control': 'no-store',
        });
        res.end();
    }
    /**
     * SSO 登录即连：POST {jwt} → 御符 sso-verify（验签 + uid==owner 一跳完成）
     * → 签实例级短 TTL（24h）设备令牌，响应与配对同形状 {ok, token, deviceId, name}。
     * 验签拒绝 → 401；御符不可达/异常 → 502；未配置验签 → 503。
     */
    async function handleExchange(req, res) {
        const json = (status, payload) => {
            res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify(payload));
        };
        if (req.method !== 'POST') {
            json(405, { ok: false, error: 'method not allowed' });
            return;
        }
        if (!exchangeLimiter.check(clientKey(req))) {
            json(429, { ok: false, error: 'exchange 尝试过于频繁，请稍后再试' });
            return;
        }
        if (!sameOrigin(req)) {
            json(403, { ok: false, error: 'cross-origin denied' });
            return;
        }
        const verifySso = options.verifySso;
        if (verifySso === undefined) {
            json(503, { ok: false, error: '未配置 SSO 验签地址（remote.ssoVerify）' });
            return;
        }
        let jwt = '';
        try {
            const parsed = JSON.parse(await readBody(req));
            jwt = typeof parsed.jwt === 'string' ? parsed.jwt : '';
        }
        catch { /* jwt 保持空 → 走 400 */ }
        if (jwt === '') {
            json(400, { ok: false, error: '请求体须为 {jwt}' });
            return;
        }
        let verdict;
        try {
            verdict = await verifySso(jwt);
        }
        catch (error) {
            log(`sso-verify 调用失败：${error instanceof Error ? error.message : String(error)}`);
            json(502, { ok: false, error: '御符验签服务不可达' });
            return;
        }
        if (!verdict.ok) {
            log(`exchange 被拒（sso-verify 未通过）来自 ${clientKey(req)}`);
            json(401, { ok: false, error: 'sso_verify_rejected' });
            return;
        }
        const token = generateDeviceToken();
        const uid = verdict.uid ?? '';
        // 一账号一设备：同 uid 幂等签发（轮换令牌），避免每次登录堆积同名设备条目
        const verb = uid !== '' ? '轮换' : '签发';
        const device = uid !== ''
            ? store.ensureSso({ uid, usr: verdict.usr ?? '', token, expiresAt: now() + EXCHANGE_TOKEN_TTL_MS }, now())
            : store.add({ token, name: `SSO ${verdict.usr ?? '用户'}`, expiresAt: now() + EXCHANGE_TOKEN_TTL_MS }, now());
        log(`SSO 设备已${verb}实例令牌：${device.name}（${device.id}，24h）`);
        json(200, { ok: true, token, deviceId: device.id, name: device.name });
    }
    function handleUpgrade(req, socket, head) {
        try {
            const url = new URL(req.url ?? '/', 'http://gateway.local');
            if (url.pathname === '/__remote/pair') {
                rawDeny(socket, 405, 'method not allowed');
                return;
            }
            if (url.pathname === '/__remote/exchange') {
                rawDeny(socket, 405, 'method not allowed');
                return;
            }
            const token = credentialToken(req);
            const device = token === undefined ? undefined : store.verify(token);
            if (device === undefined) {
                if (token !== undefined && !badTokenLimiter.check(clientKey(req))) {
                    // 带无效令牌的升级与 HTTP 路径同规：计入坏令牌限速（防爆破）；裸 401 不计
                    log(`WS 升级被拒绝（坏令牌限速）来自 ${clientKey(req)}`);
                    rawDeny(socket, 429, '尝试过于频繁，请稍后再试');
                    return;
                }
                log(`WS 升级被拒绝（未认证）来自 ${clientKey(req)}`);
                rawDeny(socket, 401, 'unauthorized: pair required');
                return;
            }
            store.touch(device.id, now());
            proxyUpgrade(upstream, req, socket, head);
        }
        catch {
            socket.destroy();
        }
    }
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(options.port, bind, () => resolve());
    });
    const flushTimer = setInterval(() => { void store.flush().catch(() => { }); }, 5 * 60_000);
    flushTimer.unref();
    log(`远程访问网关已启动：http://${bind}:${String(portOf(server))} → http://${upstreamAuthority(upstream)}`);
    return {
        port: portOf(server),
        close: () => new Promise((resolve) => {
            clearInterval(flushTimer);
            void store.flush().catch(() => { });
            server.close(() => resolve());
            server.closeAllConnections(); // 不等待既有连接；进程退出兜底（参考 proxy 测试的关闭模式）
        }),
    };
}
function portOf(server) {
    const addr = server.address();
    return typeof addr === 'object' && addr !== null ? addr.port : 0;
}
