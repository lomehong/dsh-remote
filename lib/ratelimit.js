/** 按 key 的固定窗口限速（配对端点与无效凭证尝试用；key = 客户端 IP）。 */
export class RateLimiter {
    limit;
    windowMs;
    now;
    windows = new Map();
    constructor(limit, windowMs, now = Date.now) {
        this.limit = limit;
        this.windowMs = windowMs;
        this.now = now;
    }
    /** 窗口内未超限则记账并返回 true；超限返回 false（不记账）。过期窗口惰性重置。 */
    check(key) {
        const now = this.now();
        const w = this.windows.get(key);
        if (w === undefined || now - w.start >= this.windowMs) {
            // 防御性清理：key 数异常膨胀时丢弃已过期窗口（正常部署 key 数 = 访问 IP 数，极小）
            if (this.windows.size > 10_000) {
                for (const [k, win] of this.windows) {
                    if (now - win.start >= this.windowMs)
                        this.windows.delete(k);
                }
            }
            this.windows.set(key, { start: now, count: 1 });
            return true;
        }
        if (w.count >= this.limit)
            return false;
        w.count += 1;
        return true;
    }
}
