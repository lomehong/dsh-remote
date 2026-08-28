/**
 * 设备表：配对成功的设备（id/名称/令牌指纹/时间/UA）。
 * 持久化 $DSH_HOME/dsh-remote/devices.json（临时文件 + 原子重命名 + 0600，dsh-memory 同款）。
 * 明文令牌绝不落盘：verify 用 sha256(呈递令牌) 与指纹做常量时间比较。
 * 落盘用同步写：add/rename/revoke 同步返回前文件已就位（无半落盘窗口，后续读/清理不与写入竞争）；
 * 设备表量极小，同步开销可忽略。
 */
import { mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { deviceTokenFingerprint, tokensMatch } from "./tokens.js";
export function devicesFilePath(homeDir) {
    return join(homeDir, 'dsh-remote', 'devices.json');
}
export async function loadDevices(homeDir) {
    const devices = new Map();
    try {
        const raw = JSON.parse(await readFile(devicesFilePath(homeDir), 'utf8'));
        if (raw !== null && typeof raw === 'object' && raw.version === 1 && Array.isArray(raw.devices)) {
            for (const item of raw.devices) {
                if (item === null || typeof item !== 'object')
                    continue;
                if (typeof item.id !== 'string' || item.id === '')
                    continue;
                if (typeof item.tokenHash !== 'string' || item.tokenHash === '')
                    continue;
                devices.set(item.id, {
                    id: item.id,
                    name: typeof item.name === 'string' && item.name !== '' ? item.name : '远程设备',
                    tokenHash: item.tokenHash,
                    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
                    lastSeenAt: typeof item.lastSeenAt === 'number' ? item.lastSeenAt : 0,
                    ...(typeof item.ua === 'string' ? { ua: item.ua } : {}),
                });
            }
        }
    }
    catch {
        // 不存在或损坏：全新设备表（0600 文件，损坏即视为不可信）
    }
    let dirty = false;
    /**
     * 临时文件 + 原子重命名，全程同步（单线程内无交错，tmp 名不会自撞）。
     * 成功路径末尾才清 dirty；失败清理 tmp 后原样抛出、dirty 保留，由后续 flush 重试。
     */
    const persist = () => {
        const path = devicesFilePath(homeDir);
        mkdirSync(dirname(path), { recursive: true });
        const payload = { version: 1, devices: [...devices.values()] };
        const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
        try {
            writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            renameSync(tmp, path);
        }
        catch (err) {
            try {
                unlinkSync(tmp); // best-effort 清理，避免遗留孤儿 tmp
            }
            catch {
                // tmp 可能尚未创建
            }
            throw err;
        }
        dirty = false;
    };
    return {
        verify(token) {
            if (token === '')
                return undefined;
            const fingerprint = deviceTokenFingerprint(token);
            for (const device of devices.values()) {
                if (tokensMatch(device.tokenHash, fingerprint))
                    return device;
            }
            return undefined;
        },
        add(input, now) {
            const device = {
                id: randomBytes(6).toString('hex'),
                name: input.name ?? '远程设备',
                tokenHash: deviceTokenFingerprint(input.token),
                createdAt: now,
                lastSeenAt: now,
                ...(input.ua !== undefined ? { ua: input.ua } : {}),
            };
            devices.set(device.id, device);
            dirty = true;
            try {
                persist();
            }
            catch {
                // 落盘失败不阻断内存操作；dirty 仍为 true，由 flush 兜底重试
            }
            return device;
        },
        list() {
            return [...devices.values()];
        },
        rename(id, name) {
            const device = devices.get(id);
            if (device === undefined)
                return false;
            device.name = name;
            dirty = true;
            try {
                persist();
            }
            catch {
                // 落盘失败不阻断内存操作；dirty 仍为 true，由 flush 兜底重试
            }
            return true;
        },
        revoke(id) {
            const deleted = devices.delete(id);
            if (deleted) {
                dirty = true;
                try {
                    persist();
                }
                catch {
                    // 落盘失败不阻断内存操作（已吊销在内存即时生效）；dirty 仍为 true，由 flush 兜底重试
                }
            }
            return deleted;
        },
        touch(id, now) {
            const device = devices.get(id);
            if (device === undefined || now <= device.lastSeenAt)
                return;
            device.lastSeenAt = now;
            dirty = true; // 仅标记；由 5 分钟 flush 兜底落盘（gateway 负责 interval）
        },
        async flush() {
            if (!dirty)
                return;
            persist(); // 成功时在 persist 末尾清 dirty；失败保留 dirty 并向上抛出
        },
    };
}
