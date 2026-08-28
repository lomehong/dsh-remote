export declare function generatePairingCode(): string;
export declare function generateDeviceToken(): string;
export declare function deviceTokenFingerprint(token: string): string;
export declare function tokensMatch(a: string, b: string): boolean;
export interface Pairing {
    code: string;
    expiresAt: number;
}
/** 配对码仓：同时仅一个有效码（新码使旧码作废），消费即删除（单次使用）。 */
export declare class PairingStore {
    private ttlMs;
    private now;
    private current;
    constructor(ttlMs?: number, now?: () => number);
    create(): Pairing;
    /** 有效期内且码相符 → true 并立即作废（单次使用）；过期即清除；码不符不清除有效码，一律 false。 */
    consume(code: string): boolean;
}
