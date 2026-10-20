import { createServer, Server, Socket } from 'node:net';
import { Client } from '../protocol/client';
import { Config, Frame, Log } from '../protocol/config';
import { splitNALs, nalType, resolution } from './hevc';
import { Packetizer } from './rtp';

export interface Metadata { width?: number; height?: number; bitrate?: number; keyframeInterval?: number }

export class MediaSession {
    private client: Client;
    private server?: Server;
    private socket?: Socket;
    private timer?: NodeJS.Timeout;
    private ended = false;
    private queue: Buffer[] = [];
    private queued = 0;
    private packetizer = new Packetizer();
    private sets = new Map<number, Buffer>();
    private base?: number;
    private clockStamp?: number;
    private clockTime = 0;
    private audioTime = 0;
    private leading = false;
    private ready = false;
    private onReady?: () => void;
    private onFailure?: (error: Error) => void;
    private width?: number;
    private height?: number;
    private lastKey?: number;
    private statsStart?: number;
    private statsTime = 0;
    private videoBytes = 0;

    constructor(config: Config, private log: Log, private onEnd: () => void,
        private onMetadata: (value: Metadata) => void) {
        this.client = new Client(config, log);
        this.client.on('frame', (frame: Frame) => {
            try { this.frame(frame); }
            catch (error) { this.close(error as Error); }
        });
        this.client.once('end', (error?: Error) => this.close(error || new Error('Camera session ended')));
    }

    async open(): Promise<{ url: string; sdp: string; width: number; height: number }> {
        try {
            const ready = new Promise<void>((resolve, reject) => { this.onReady = resolve; this.onFailure = reject; });
            // Attach rejection handling before network startup can fail.
            void ready.catch(() => {});
            await this.client.open();
            if (this.ended) throw new Error('Media session ended');
            if (!this.ready) this.timer = setTimeout(() => this.close(new Error('Media probing timed out')), 15000);
            await ready;
            clearTimeout(this.timer);
            if (this.ended) throw new Error('Media session ended');
            this.server = createServer(socket => this.connect(socket));
            await new Promise<void>((resolve, reject) => {
                const server = this.server!;
                const cleanup = () => {
                    server.removeListener('error', onError);
                    server.removeListener('close', onClose);
                    server.removeListener('listening', onListening);
                };
                const onError = (error: Error) => { cleanup(); reject(error); };
                const onClose = () => onError(new Error('Media server closed during startup'));
                const onListening = () => { cleanup(); resolve(); };
                server.once('error', onError);
                server.once('close', onClose);
                try { server.listen(0, '127.0.0.1', onListening); }
                catch (error) { onError(error as Error); }
            });
            if (this.ended) {
                this.server.close();
                throw new Error('Media session ended');
            }
            this.server.on('error', () => this.close(new Error('Local media server failed')));
            const port = (this.server.address() as { port: number }).port;
            this.timer = setTimeout(() => this.close(new Error('Media consumer did not connect')), 20000);
            const set = (n: number) => this.sets.get(n)!.toString('base64');
            const sdp = ['v=0', 'o=- 0 0 IN IP4 127.0.0.1', 's=Marlboze', 'c=IN IP4 0.0.0.0', 't=0 0',
                'm=video 0 RTP/AVP 96', 'a=rtpmap:96 H265/90000',
                `a=fmtp:96 sprop-vps=${set(32)};sprop-sps=${set(33)};sprop-pps=${set(34)}`,
                'a=control:trackID=0', 'm=audio 0 RTP/AVP 8', 'a=rtpmap:8 PCMA/8000/1', 'a=control:trackID=1', ''].join('\r\n');
            return { url: `tcp://127.0.0.1:${port}`, sdp, width: this.width!, height: this.height! };
        }
        catch (error) { this.close(error as Error); throw error; }
    }

    private frame(frame: Frame): void {
        if (this.ended) return;
        if (!frame.video) {
            if (this.base === undefined) return;
            const elapsed = this.timestamp(frame.stamp, false);
            if (elapsed !== undefined)
                for (const packet of this.packetizer.audio(frame.payload, elapsed * 8)) this.write(packet);
            return;
        }
        let nals = splitNALs(frame.payload);
        if (!nals.length) throw new Error('No H.265 NAL units');
        for (const nal of nals) {
            const kind = nalType(nal);
            if (kind >= 32 && kind <= 34) this.sets.set(kind, Buffer.from(nal));
        }
        // IDR/BLA/CRA are random-access points; suppress RASL leading pictures
        // when starting from CRA. Do not infer keyframes solely from SDK flags.
        const key = nals.some(n => nalType(n) >= 16 && nalType(n) <= 21);
        if (this.base === undefined) {
            if (!key || this.sets.size !== 3) return;
            Object.assign(this, resolution(this.sets.get(33)!));
            this.base = frame.stamp;
            this.leading = true;
            this.onMetadata({ width: this.width, height: this.height });
            this.log('media ready', { width: this.width, height: this.height, codec: 'h265', audio: 'pcm_alaw/8000/mono' });
        }
        if (this.leading && !key) {
            nals = nals.filter(n => nalType(n) !== 8 && nalType(n) !== 9);
            if (nals.some(n => nalType(n) < 8)) this.leading = false;
        }
        if (!nals.length) return;
        const elapsed = this.timestamp(frame.stamp, true);
        if (elapsed === undefined) return;
        if (key) {
            if (this.lastKey !== undefined)
                this.onMetadata({ keyframeInterval: (frame.stamp - this.lastKey) >>> 0 });
            this.lastKey = frame.stamp;
            nals = [...[32, 33, 34].map(n => this.sets.get(n)!), ...nals.filter(n => ![32, 33, 34].includes(nalType(n)))];
        }
        this.videoBytes += frame.payload.length;
        // Count reordered frames without moving the statistics clock backward.
        this.statsTime = Math.max(this.statsTime, elapsed);
        this.statsStart ??= this.statsTime;
        const period = this.statsTime - this.statsStart;
        if (period >= 5000) {
            this.onMetadata({ bitrate: Math.round(this.videoBytes * 8000 / period) });
            this.statsStart = this.statsTime; this.videoBytes = 0;
        }
        for (const packet of this.packetizer.video(nals, elapsed * 90)) this.write(packet);
        if (!this.ready) { this.ready = true; this.onReady?.(); }
    }

    private timestamp(stamp: number, video: boolean): number | undefined {
        // Signed deltas apply only to the rolling reference, not session age.
        // Both tracks share the clock but may arrive slightly out of order.
        const delta = (stamp - (this.clockStamp ?? this.base!)) | 0;
        const elapsed = this.clockTime + delta;
        // Video presentation order may differ from transmission order. Only
        // filter video preceding the session origin, not earlier video PTS.
        if (elapsed < 0 || (!video && elapsed < this.audioTime)) return;
        if (delta >= 0) {
            this.clockStamp = stamp;
            this.clockTime = elapsed;
        }
        if (!video) this.audioTime = elapsed;
        return elapsed;
    }

    private connect(socket: Socket): void {
        if (this.socket || this.ended) { socket.destroy(); return; }
        this.socket = socket;
        clearTimeout(this.timer);
        this.server?.close();
        socket.setNoDelay(true);
        socket.on('error', () => this.close(new Error('Media consumer socket failed')));
        socket.once('close', () => this.close());
        socket.resume();
        for (const packet of this.queue) socket.write(packet);
        this.queue = []; this.queued = 0;
        if (socket.writableLength > 8 << 20) this.close(new Error('Media consumer too slow'));
    }

    private write(packet: Buffer): void {
        if (this.socket) {
            if (this.socket.writableLength + packet.length > 8 << 20) throw new Error('Media consumer too slow');
            this.socket.write(packet);
        }
        else {
            this.queued += packet.length;
            if (this.queued > 8 << 20) throw new Error('Media startup buffer exceeded');
            this.queue.push(packet);
        }
    }

    close(error?: Error): void {
        if (this.ended) return;
        this.ended = true;
        clearTimeout(this.timer);
        this.onFailure?.(error || new Error('Media session closed'));
        this.client.close();
        this.socket?.destroy();
        this.server?.close();
        this.queue = []; this.queued = 0;
        if (error) this.log('session ended', { reason: error.message });
        this.onEnd();
    }
}
