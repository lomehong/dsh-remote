export const REMOTE_DEFAULTS = { enabled: false, port: 3090, bind: '0.0.0.0' };
export function normalizeConfigInput(payload) {
    if (payload === null || typeof payload !== 'object')
        throw new Error('配置必须是对象');
    const raw = payload;
    // null（YAML `port:` 留空）与空串按缺省处理：Number(null)/Number('') 会得 0，误入 OS 随机端口
    const portNum = raw.port == null || raw.port === '' ? Number.NaN : typeof raw.port === 'number' ? raw.port : Number(raw.port);
    const port = Number.isFinite(portNum) ? Math.round(portNum) : REMOTE_DEFAULTS.port;
    // port 0 = OS 分配（测试/高级用法）；UI 默认 3090
    if (port < 0 || port > 65_535)
        throw new Error(`port 越界（0-65535）：${raw.port}`);
    const bind = String(raw.bind ?? REMOTE_DEFAULTS.bind).trim() || REMOTE_DEFAULTS.bind;
    return { enabled: raw.enabled === true, port, bind };
}
