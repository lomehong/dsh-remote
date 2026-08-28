/** 按 key 的固定窗口限速（配对端点与无效凭证尝试用；key = 客户端 IP）。 */
export declare class RateLimiter {
    private limit;
    private windowMs;
    private now;
    private windows;
    constructor(limit: number, windowMs: number, now?: () => number);
    /** 窗口内未超限则记账并返回 true；超限返回 false（不记账）。过期窗口惰性重置。 */
    check(key: string): boolean;
}
