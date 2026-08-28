export interface DeviceRecord {
    id: string;
    name: string;
    tokenHash: string;
    createdAt: number;
    lastSeenAt: number;
    ua?: string;
}
export declare function devicesFilePath(homeDir: string): string;
export interface DeviceStore {
    /** 呈递令牌 → 对应设备；无效/已吊销 → undefined。 */
    verify(token: string): DeviceRecord | undefined;
    add(input: {
        token: string;
        name?: string;
        ua?: string;
    }, now: number): DeviceRecord;
    /** 返回内部引用，调用方不得修改；经管理 API 暴露前须去除 tokenHash。 */
    list(): DeviceRecord[];
    rename(id: string, name: string): boolean;
    revoke(id: string): boolean;
    /** 更新最近活跃（内存态；随 flush/其他变更落盘）。 */
    touch(id: string, now: number): void;
    /** 写入所有待落盘变更；失败时保留 dirty 并抛出，可再次 flush 重试。 */
    flush(): Promise<void>;
}
export declare function loadDevices(homeDir: string): Promise<DeviceStore>;
