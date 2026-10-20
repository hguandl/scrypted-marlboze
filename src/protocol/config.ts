import { isIPv4 } from 'node:net';

export interface Config {
    uid: string;
    mac: string;
    password: string;
    ip: string;
    stream: number;
}
export interface Frame { video: boolean; kind: number; stamp: number; payload: Buffer }
export type Log = (message: string, details?: object) => void;

export function validate(config: Config): void {
    uidToken(config.uid);
    if (!isIPv4(config.ip)) throw new Error('An IPv4 camera address is required');
    if (!/^(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}$/i.test(config.mac)) throw new Error('Invalid MAC address');
    if (!config.password || Buffer.byteLength(config.password) > 256 || config.password.includes('\0'))
        throw new Error('Invalid device password');
    if (!Number.isInteger(config.stream) || config.stream < 0 || config.stream > 0xffffffff)
        throw new Error('Stream must be a uint32');
}

export function uidToken(uid: string): Buffer {
    const parts = uid.split('-');
    if (parts.length !== 3 || !/^[!-~]{1,8}$/.test(parts[0]) || !/^[!-~]{1,8}$/.test(parts[2])
        || !/^\d+$/.test(parts[1]) || Number(parts[1]) > 0xffffffff || Buffer.byteLength(uid) > 32)
        throw new Error('Invalid device UID');
    const b = Buffer.alloc(20);
    b.write(parts[0], 0, 8, 'ascii');
    b.writeUInt32BE(Number(parts[1]), 8);
    b.write(parts[2], 12, 8, 'ascii');
    return b;
}

