import dgram, { RemoteInfo } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { networkInterfaces } from 'node:os';
import { decryptVideo, encryptPrefix, loginBody, sessionKey } from './crypto';
import { Config, Frame, Log, uidToken, validate } from './config';
import { Channel } from './channel';

function words(...values: number[]): Buffer {
    const b = Buffer.alloc(values.length * 4);
    values.forEach((v, i) => b.writeUInt32LE(v >>> 0, i * 4));
    return b;
}

// One socket reader owns ACKs, ordering, control replies and media framing.
export class Client extends EventEmitter {
    private socket = dgram.createSocket('udp4');
    private port = 32108;
    private seq = 0;
    private channels = Array.from({ length: 5 }, () => new Channel());
    private pending = new Map<number, { packet: Buffer; sent: number; tries: number }>();
    private key: Buffer;
    private active = false;
    private closed = false;
    private timer?: NodeJS.Timeout;
    private bindIP = '';
    private lastFrame = Date.now();
    private lastPacket = Date.now();
    private streaming = false;
    private discovery?: (data: Buffer, peer: RemoteInfo) => void;

    constructor(private config: Config, private log: Log) {
        super();
        validate(config);
        this.key = sessionKey(config.uid, config.password);
        this.socket.on('error', () => this.close(new Error('Camera UDP socket failed')));
        this.socket.on('message', (data, peer) => {
            try {
                if (!this.active) this.discovery?.(data, peer);
                else this.receive(data, peer);
            }
            catch (error) { this.close(error as Error); }
        });
    }

    async open(media = true): Promise<void> {
        try {
            this.bindIP = await this.routeIP();
            if (this.closed) throw new Error('Camera session closed');
            await new Promise<void>((resolve, reject) => {
                const cleanup = () => {
                    this.socket.removeListener('error', onError);
                    this.removeListener('end', onEnd);
                };
                const onError = (error: Error) => { cleanup(); reject(error); };
                const onEnd = (error?: Error) => onError(error || new Error('Camera session closed'));
                this.socket.once('error', onError);
                this.once('end', onEnd);
                this.socket.bind(0, this.bindIP, () => { cleanup(); resolve(); });
            });
            if (this.closed) throw new Error('Camera session closed');
            await this.discover();
            if (this.closed) throw new Error('Camera session closed');
            this.lastPacket = Date.now();
            this.timer = setInterval(() => {
                try { this.tick(); }
                catch (error) { this.close(error as Error); }
            }, 100);
            const body = loginBody(this.config.uid, this.config.password, this.key);
            const ext = Buffer.alloc(8);
            ext[0] = 10;
            ext.writeUInt16LE(body.reduce((sum, v) => (sum + v) & 0xffff, 0), 1);
            ext.writeUInt32LE(Date.now() >>> 0, 4);
            const reply = this.waitCommand(0x481b, 5000);
            this.command(0x481b, encryptPrefix(body, this.key, 400), ext);
            await reply;
            if (this.closed) throw new Error('Camera session closed');
            this.log('login succeeded');
            if (!media) return;
            this.command(0xf002, encryptPrefix(words(0, this.config.stream, 0, 5, 256, 2, 10), this.key, 16));
            this.command(0x1001, encryptPrefix(words(this.config.stream, 1, 0, 2, 0), this.key, 16));
            this.command(0x3103);
            this.lastFrame = Date.now();
            this.streaming = true;
        }
        catch (error) { this.close(error as Error); throw error; }
    }

    private async routeIP(): Promise<string> {
        const socket = dgram.createSocket('udp4');
        try {
            return await new Promise<string>((resolve, reject) => {
                socket.once('error', reject);
                socket.connect(32108, this.config.ip, () => resolve(socket.address().address));
            });
        }
        finally { socket.close(); }
    }

    private discover(): Promise<void> {
        const token = uidToken(this.config.uid);
        const wake = dgram.createSocket('udp4');
        const mac = Buffer.from(this.config.mac.replace(/[:-]/g, ''), 'hex');
        const magic = Buffer.concat([Buffer.alloc(6, 255), ...Array.from({ length: 16 }, () => mac), Buffer.alloc(14)]);
        const address = Object.values(networkInterfaces()).flat().find(a => a?.address === this.bindIP && a.family === 'IPv4');
        const octets = this.config.ip.split('.').map(Number);
        const mask = address?.netmask.split('.').map(Number);
        // Routed/VPN connections may discover the device but cannot LAN-wake it.
        const broadcast = address && mask && octets.every((v, i) => (v & mask[i]) === (Number(address.address.split('.')[i]) & mask[i]))
            ? octets.map((v, i) => v | (255 ^ mask[i])).join('.') : undefined;
        return new Promise<void>((resolve, reject) => {
            let wakeReady = false, nextDiscovery = 0, finished = false;
            const finish = (error?: Error) => {
                if (finished) return;
                finished = true;
                clearInterval(interval); clearTimeout(timeout);
                this.discovery = undefined;
                this.removeListener('end', onEnd);
                wake.close();
                if (error) reject(error); else resolve();
            };
            const onEnd = (error?: Error) => finish(error || new Error('Discovery cancelled'));
            this.once('end', onEnd);
            wake.on('error', () => { wakeReady = false; });
            wake.bind(0, this.bindIP, () => {
                try { wake.setBroadcast(true); wakeReady = true; }
                catch { this.log('LAN wake unavailable'); }
            });
            this.discovery = (data, peer) => {
                if (peer.address !== this.config.ip || data.length !== 24 || data[0] !== 0xf1
                    || data.readUInt16BE(2) !== 20 || !data.subarray(4).equals(token)
                    || (data[1] !== 0x41 && data[1] !== 0x42)) return;
                this.port = peer.port;
                this.active = true;
                if (data[1] === 0x41) this.send(0x42, token);
                this.log('discovery succeeded', { port: this.port });
                finish();
            };
            const attempt = () => {
                if (wakeReady && broadcast) wake.send(magic, 50000, broadcast, () => {});
                if (Date.now() >= nextDiscovery) {
                    this.send(0x30);
                    nextDiscovery = Date.now() + 500;
                }
            };
            const interval = setInterval(attempt, 250);
            const timeout = setTimeout(() => finish(new Error('Camera discovery timed out')), 15000);
            this.log('discovery started', { ip: this.config.ip, bind: this.bindIP });
            attempt();
        });
    }

    private send(kind: number, data: Buffer = Buffer.alloc(0)): void {
        if (this.closed) return;
        const packet = Buffer.alloc(4 + data.length);
        packet[0] = 0xf1; packet[1] = kind;
        packet.writeUInt16BE(data.length, 2);
        data.copy(packet, 4);
        this.socket.send(packet, this.port, this.config.ip, error => {
            if (error) this.close(new Error('Camera UDP send failed'));
        });
    }

    private command(cmd: number, body: Buffer = Buffer.alloc(0), ext: Buffer = Buffer.alloc(0)): void {
        const packet = Buffer.alloc(28 + body.length);
        packet[0] = 0xd1;
        packet.writeUInt16BE(this.seq, 2);
        packet.writeUInt32LE(0x99999999, 4);
        packet.writeUInt32LE(body.length, 8);
        packet.writeUInt32LE(cmd, 12);
        ext.copy(packet, 20, 0, 8); body.copy(packet, 28);
        this.pending.set(this.seq, { packet, sent: Date.now(), tries: 1 });
        this.seq = (this.seq + 1) & 0xffff;
        this.send(0xd0, packet);
    }

    private waitCommand(cmd: number, ms: number): Promise<void> {
        return new Promise((resolve, reject) => {
            const cleanup = () => {
                clearTimeout(timer); this.removeListener('command', onCommand); this.removeListener('end', onEnd);
            };
            const onCommand = (reply: number) => { if (reply === cmd) { cleanup(); resolve(); } };
            const onEnd = (error?: Error) => { cleanup(); reject(error || new Error('Camera closed session')); };
            const timer = setTimeout(() => onEnd(new Error('Camera login timed out')), ms);
            this.on('command', onCommand); this.once('end', onEnd);
        });
    }

    private tick(): void {
        const now = Date.now();
        if (this.channels.some(ch => ch.gap && now - ch.gap > 3000)) throw new Error('Unrecovered packet gap');
        for (const pending of this.pending.values()) {
            if (now - pending.sent < 1000) continue;
            if (pending.tries >= 4) throw new Error('Command ACK timed out');
            this.send(0xd0, pending.packet);
            pending.sent = now; pending.tries++;
        }
        if (now - this.lastPacket > 60000) throw new Error('Camera connection timed out');
        if (this.streaming && now - this.lastFrame > 10000) throw new Error('Camera media timed out');
    }

    private receive(data: Buffer, peer: RemoteInfo): void {
        if (peer.address !== this.config.ip || peer.port !== this.port || data.length < 4
            || data[0] !== 0xf1 || data.readUInt16BE(2) !== data.length - 4) return;
        this.lastPacket = Date.now();
        const body = data.subarray(4);
        switch (data[1]) {
            case 0xe0: this.send(0xe1); break;
            case 0xf0: this.close(new Error('Camera closed session')); break;
            case 0xd1:
                if (body.length < 4 || body[0] !== 0xd1 || body[1] !== 0 || body.length !== 4 + 2 * body.readUInt16BE(2)) return;
                for (let i = 4; i < body.length; i += 2) this.pending.delete(body.readUInt16BE(i));
                break;
            case 0xd0: {
                if (body.length < 4 || body[0] !== 0xd1 || ![0, 2, 4].includes(body[1])) return;
                const ch = body[1];
                this.channels[ch].push(body.readUInt16BE(2), body.subarray(4));
                this.send(0xd1, Buffer.from([0xd1, ch, 0, 1, body[2], body[3]]));
                this.parseChannel(ch);
                break;
            }
        }
    }

    private parseChannel(ch: number): void {
        const channel = this.channels[ch];
        const control = ch !== 2;
        const header = control ? 24 : 16;
        while (channel.buffer.length >= header) {
            const b = channel.buffer;
            const magic = b.readUInt32LE(0), size = b.readUInt32LE(4);
            if (control ? magic !== 0x99999999 : ![0x46565848, 0x43215678, 0x46415848].includes(magic))
                throw new Error('Invalid camera frame header');
            if (size > (control ? 1 << 20 : 4 << 20)) throw new Error('Camera frame size exceeded');
            if (b.length < header + size) return;
            channel.buffer = b.subarray(header + size);
            if (ch === 4) {
                const command = b.readUInt32LE(8), status = b.readInt32LE(12);
                this.log('alarm command', { command, status, bytes: size });
                if (command === 0xf004 && status === 0 && size) this.emit('alarm');
            }
            else if (ch === 0) {
                if (b.readInt32LE(12)) throw new Error('Camera rejected command');
                this.emit('command', b.readUInt32LE(8));
            }
            else {
                const video = magic === 0x46565848, kind = b.readUInt32LE(12);
                let payload: Buffer = Buffer.from(b.subarray(16, 16 + size));
                if (!video && (magic === 0x46415848 || kind !== 0 || !size)) throw new Error('Unsupported camera audio');
                if (video) payload = decryptVideo(payload, this.key, kind);
                this.lastFrame = Date.now();
                this.emit('frame', { video, kind, stamp: b.readUInt32LE(8), payload } satisfies Frame);
            }
        }
    }

    close(error?: Error): void {
        if (this.closed) return;
        if (this.active) this.send(0xf0);
        this.closed = true;
        clearInterval(this.timer);
        this.pending.clear();
        try { this.socket.close(); } catch { /* not bound yet */ }
        this.emit('end', error);
    }
}
