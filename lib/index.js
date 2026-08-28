/**
 * dsh-remote：远程访问插件。
 *
 * - 网关：webServer 服务在位且 remote.enabled 时，起独立 HTTP 网关（默认 0.0.0.0:3090），
 *   带配对认证，一切请求反代到回环 dsh webserver（见 gateway.ts / proxy.ts）
 * - 本地管理：dsh webserver 上的 /dsh-remote/api/*（状态 / 生成配对链接 / 设备管理），
 *   供设置页「远程访问」Tab 使用；name/ua 是不可信输入（截断已做，暴露前再剥 tokenHash）
 * - 配置：settings.yaml 的 remote: 节，热重载（enabled/port/bind 变更即重建网关）
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { normalizeConfigInput } from "./config.js";
import { PairingStore } from "./tokens.js";
import { loadDevices } from "./devices.js";
import { listAddresses } from "./addresses.js";
import { startGateway } from "./gateway.js";
export const name = 'dsh-remote';
export const Config = z.object({
    enabled: z.boolean().default(false).description('启用远程访问网关（默认关闭）'),
    port: z.number().default(3090).description('网关监听端口'),
    bind: z.string().default('0.0.0.0').description('绑定地址（可改为 Tailscale IP 等单接口地址）'),
});
const NS = settingsNamespace('remote');
/** 测试可覆盖的 DSH home：优先专用环境变量，其次宿主 DSH_HOME，兜底 ~/.dsh（对齐 model-failover）。 */
export function dshHome() {
    return process.env.DSH_REMOTE_HOME ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
/** 管理请求体是小型 JSON，超限直接拒绝（防异常请求撑爆内存）。 */
const MAX_BODY_BYTES = 64 * 1024;
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            if (chunk === undefined)
                return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error('请求体超过 64KB 上限'));
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}
function sendJson(res, status, payload) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(payload));
}
/** 跨站写入防护：带 Origin 的请求必须同源（浏览器 POST fetch 亦带 Origin，须匹配）。 */
function sameOrigin(req) {
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
}
/** 设备记录脱敏：绝不暴露 tokenHash / ua（ua 是不可信输入，客户端不需要它）。 */
function redact(d) {
    return { id: d.id, name: d.name, createdAt: d.createdAt, lastSeenAt: d.lastSeenAt };
}
export async function apply(ctx, config) {
    // 优先宿主 logger（直写 stdout 会与其重复）；logger 缺席时退回直写。
    // 注意必须以成员调用 logger.info(line) 保持 this 绑定——cordis LoggerService
    // 的方法依赖 this，摘出函数引用 detached 调用会抛 TypeError 并被 cordis 升级为 fatal
    const log = (() => {
        try {
            const logger = ctx.logger;
            if (logger !== undefined && typeof logger.info === 'function') {
                const info = logger.info.bind(logger);
                return (line) => {
                    try {
                        info(line);
                    }
                    catch { /* ignore */ }
                };
            }
        }
        catch { /* ignore */ }
        return (line) => { process.stdout.write(`[dsh-remote] ${line}\n`); };
    })();
    // ── 访问日志：环形缓冲（供设置页排查「谁连过」），记录同时打 log ──
    const accessLog = [];
    const record = (line) => {
        log(line);
        accessLog.push(`${new Date().toISOString()} ${line}`);
        if (accessLog.length > 100)
            accessLog.shift();
    };
    // ── 运行时状态 ──
    const store = await loadDevices(dshHome());
    const pairings = new PairingStore();
    const rt = normalizeConfigInput(config);
    let upstream;
    let gateway;
    // 当前注入作用域的卸载闩（按作用域一份）：webServer 服务可能被卸载后重新提供
    // （如改端口热重载），cordis 会先跑旧作用域清理、再重新注入——apply 级永久闩会让
    // 新作用域永远跳过启动。restartGateway 只看「当前作用域」的闩。
    let currentScope;
    // 网关生命周期：关闭旧实例 → enabled 且 upstream 在位时重新拉起。
    // 串行化重启（装配期 inject 回调与 apply 末尾可能各触发一次），避免并发双监听
    let restarting = Promise.resolve();
    const restartGateway = () => {
        restarting = restarting.catch(() => { }).then(async () => {
            if (currentScope !== undefined && currentScope.disposed) {
                record('跳过网关启动：当前作用域已卸载');
                return;
            }
            if (gateway !== undefined) {
                const old = gateway;
                gateway = undefined;
                await old.close();
            }
            if (rt.enabled && upstream !== undefined) {
                const handle = await startGateway({ bind: rt.bind, port: rt.port, upstream, store, pairings, log: record });
                if (currentScope === undefined || currentScope.disposed) {
                    // startGateway await 期间发生了卸载：立即关闭，不落引用（防孤儿监听）
                    await handle.close();
                    record('网关已创建但作用域已卸载，立即关闭');
                    return;
                }
                gateway = handle;
                record(`网关已监听 ${rt.bind}:${gateway.port}`);
            }
        });
        return restarting;
    };
    // ── 配置来源：settings 节（热重载），组合层 config 为基线 ──
    let readConfig = () => config;
    installSettingsSection(ctx, NS, Config, config, {
        setSource: (source) => { readConfig = source; },
        onChange: () => {
            void (async () => {
                Object.assign(rt, normalizeConfigInput(readConfig()));
                await restartGateway();
                record(`配置已应用：${rt.enabled ? `启用（${rt.bind}:${rt.port}）` : '停用'}`);
            })().catch((error) => {
                record(`配置变更应用失败：${error instanceof Error ? error.message : String(error)}`);
            });
        },
    });
    // ── 本地管理 API（webServer 在位时；供设置页「远程访问」Tab 使用） ──
    ctx.inject(['webServer'], (scoped) => {
        const web = scoped;
        // 新作用域：换 upstream（重注入可能带新端口）+ 重置卸载闩
        const scope = { disposed: false };
        currentScope = scope;
        upstream = { host: web.webServer.host ?? '127.0.0.1', port: web.webServer.port ?? 3080 };
        const disposers = [];
        // 统一防逃逸包装：处理器任何异常/拒绝都拦在 handler 内转 500——
        // 逃逸到 webserver 的异常会被 cordis 升级为 fatal 杀死整个进程（实测）
        const safe = (handler) => {
            return async (req, res) => {
                try {
                    await handler(req, res);
                }
                catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    record(`管理 API 处理器异常：${message}`);
                    try {
                        sendJson(res, 500, { ok: false, error: message });
                    }
                    catch { /* 响应头已发出 */ }
                }
            };
        };
        // GET /dsh-remote/api/status：网关状态 + 地址枚举 + 设备（脱敏）+ 访问日志尾部
        disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/status', handler: safe((_req, res) => {
                sendJson(res, 200, {
                    ok: true,
                    enabled: rt.enabled,
                    listening: gateway !== undefined,
                    gatewayPort: gateway?.port,
                    port: rt.port,
                    bind: rt.bind,
                    addresses: listAddresses(),
                    devices: store.list().map(redact),
                    log: accessLog.slice(-50),
                });
            }) }));
        // POST /dsh-remote/api/pairing：生成配对码 + 每个可达地址上的配对链接
        disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/pairing', handler: safe(async (req, res) => {
                if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { ok: false, error: 'cross-origin denied' });
                    return;
                }
                if (!rt.enabled || gateway === undefined) {
                    sendJson(res, 409, { ok: false, error: '网关未启用' });
                    return;
                }
                const gw = gateway; // 收窄进闭包（gateway 是可变绑定）
                const pairing = pairings.create();
                const links = listAddresses().map((info) => ({
                    ...info,
                    url: `http://${info.ip}:${gw.port}/__remote/pair?code=${encodeURIComponent(pairing.code)}`,
                }));
                sendJson(res, 200, { ok: true, code: pairing.code, expiresAt: pairing.expiresAt, links });
            }) }));
        // POST /dsh-remote/api/devices/rename：{id, name}（name 截断 60 字符，不可信输入）
        disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/devices/rename', handler: safe(async (req, res) => {
                if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { ok: false, error: 'cross-origin denied' });
                    return;
                }
                let body;
                try {
                    body = JSON.parse(await readBody(req));
                }
                catch {
                    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
                    return;
                }
                const id = typeof body.id === 'string' ? body.id : '';
                // name 是不可信输入：trim 后剥离控制字符/换行（防经环形日志注入伪造日志行），再截断 60
                const name = typeof body.name === 'string' ? body.name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 60) : '';
                if (id === '' || name === '') {
                    sendJson(res, 400, { ok: false, error: 'id 与 name（1-60 字符）必填' });
                    return;
                }
                if (!store.rename(id, name)) {
                    sendJson(res, 404, { ok: false, error: '设备不存在' });
                    return;
                }
                sendJson(res, 200, { ok: true });
            }) }));
        // POST /dsh-remote/api/devices/revoke：{id} → 吊销（凭证即失效）
        disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/devices/revoke', handler: safe(async (req, res) => {
                if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' });
                    return;
                }
                if (!sameOrigin(req)) {
                    sendJson(res, 403, { ok: false, error: 'cross-origin denied' });
                    return;
                }
                let body;
                try {
                    body = JSON.parse(await readBody(req));
                }
                catch {
                    sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
                    return;
                }
                const id = typeof body.id === 'string' ? body.id : '';
                if (id === '') {
                    sendJson(res, 400, { ok: false, error: 'id 必填' });
                    return;
                }
                if (!store.revoke(id)) {
                    sendJson(res, 404, { ok: false, error: '设备不存在' });
                    return;
                }
                sendJson(res, 200, { ok: true });
            }) }));
        // GET /dsh-remote/api/devices：设备列表（脱敏后）
        disposers.push(web.webServer.register({ kind: 'exact', path: '/dsh-remote/api/devices', handler: safe((_req, res) => {
                sendJson(res, 200, { ok: true, devices: store.list().map(redact) });
            }) }));
        // 卸载：路由全部注销 + 网关关闭。
        // 先置本作用域闩挡住本作用域的后续启动，再经同一条重启链关闭网关——保证与
        // in-flight 的 startGateway 串行，不会留下孤儿监听。
        // 次序假设：cordis 重注入时先跑旧作用域清理、再执行新注入。若旧清理因事件顺序
        // 反而晚于新注入执行，此处以「仍是否为当前作用域」判定：不是则不动网关——
        // 新作用域的 restartGateway 自会经链关闭旧网关并按新 upstream 拉起。
        web.effect(() => () => {
            scope.disposed = true;
            for (const dispose of disposers)
                dispose();
            void restarting.catch(() => { }).then(async () => {
                if (currentScope !== scope)
                    return;
                if (gateway !== undefined) {
                    const old = gateway;
                    gateway = undefined;
                    await old.close();
                }
            });
        });
        // webServer 就绪（含热插拔出现）：按当前配置拉起网关
        void restartGateway();
    });
    // 首次装配即按 config 状态拉起（webServer 缺席时 enabled 也无从反代，跳过）
    await restartGateway();
}
