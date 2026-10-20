import { createCipheriv, createDecipheriv, randomInt } from 'node:crypto';

// SDK wrapper: AES-128-ECB, no padding; XOR input/output with 0x3f.
export function crypt(data: Buffer, key: Buffer, decrypt = false): Buffer {
    if (key.length !== 16 || data.length % 16)
        throw new Error('Invalid AES input');
    const cipher = decrypt ? createDecipheriv('aes-128-ecb', key, null) : createCipheriv('aes-128-ecb', key, null);
    cipher.setAutoPadding(false);
    const input = Buffer.from(data);
    if (!decrypt)
        for (let i = 0; i < input.length; i++) input[i] ^= 0x3f;
    const result = Buffer.concat([cipher.update(input), cipher.final()]);
    if (decrypt)
        for (let i = 0; i < result.length; i++) result[i] ^= 0x3f;
    return result;
}

function padded(value: string, size: number): Buffer {
    const out = Buffer.alloc(size, '0');
    out.write(value, 0, size, 'utf8');
    return out;
}

export function sessionKey(uid: string, password: string): Buffer {
    const key = Buffer.alloc(16);
    key.write('hichip2105');
    return crypt(padded(uid + password, 32), key).subarray(0, 16);
}

function loginContext(): Buffer {
    const out = Buffer.alloc(32);
    out.writeUInt32LE(Number(process.hrtime.bigint() / 1000n % 1000000n));
    for (let i = 0; i < 4; i++)
        if (out[i] >= 161) out[i] = (out[i] + 95) & 255;
    for (let i = 4; i < 32; i++) out[i] = randomInt(161);
    const high = out.findIndex(v => v >= 128);
    out[high < 0 ? randomInt(32) : high] = randomInt(32) ^ 0x80;
    return out;
}

export function loginBody(uid: string, password: string, key: Buffer): Buffer {
    const layouts = [
        [14, 4, 12, 5, 35, 7, 33, 3, 85, 1, 57, 8, 16, 4, 36],
        [22, 4, 6, 5, 38, 7, 39, 3, 75, 1, 40, 8, 13, 4, 55],
    ];
    const out = Buffer.alloc(688);
    ['admin', password].forEach((value, field) => {
        const input = crypt(Buffer.concat([padded(value, 256), padded(uid, 32)]), key);
        const context = loginContext();
        let dest = 4 + 342 * field, src = 0, ctx = 0;
        layouts[field].forEach((n, run) => {
            (run % 2 ? context : input).copy(out, dest, run % 2 ? ctx : src, (run % 2 ? ctx : src) + n);
            if (run % 2) ctx += n;
            else src += n;
            dest += n;
        });
    });
    return out;
}

export function encryptPrefix(body: Buffer, key: Buffer, size: number): Buffer {
    return Buffer.concat([crypt(body.subarray(0, size), key), body.subarray(size)]);
}

function hasStartCode(data: Buffer): boolean {
    return data.length >= 4 && (data.readUInt32BE(0) === 1 || data.readUIntBE(0, 3) === 1);
}

export function decryptVideo(data: Buffer, key: Buffer, kind: number): Buffer {
    if (data.length < 4) throw new Error('Truncated video frame');
    if (kind === 1 && !hasStartCode(data)) {
        if (data.length < 96) throw new Error('Truncated keyframe');
        data = Buffer.concat([crypt(data.subarray(0, 96), key, true), data.subarray(96)]);
    }
    if (!hasStartCode(data))
        throw new Error('Invalid video start code');
    return data;
}
