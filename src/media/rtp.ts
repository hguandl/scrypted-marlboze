import { randomBytes } from 'node:crypto';
import { nalType } from './hevc';

// RFC 7798 RTP with RFC4571 length prefixes for Rebroadcast.
export class Packetizer {
    private videoSeq = randomBytes(2).readUInt16BE();
    private audioSeq = randomBytes(2).readUInt16BE();
    private videoSSRC = randomBytes(4).readUInt32BE();
    private audioSSRC = randomBytes(4).readUInt32BE();

    private packet(video: boolean, payload: Buffer, stamp: number, marker: boolean): Buffer {
        const out = Buffer.alloc(14 + payload.length);
        out.writeUInt16BE(12 + payload.length, 0);
        out[2] = 0x80;
        out[3] = (marker ? 0x80 : 0) | (video ? 96 : 8);
        out.writeUInt16BE(video ? this.videoSeq : this.audioSeq, 4);
        if (video) this.videoSeq = (this.videoSeq + 1) & 65535;
        else this.audioSeq = (this.audioSeq + 1) & 65535;
        out.writeUInt32BE(stamp >>> 0, 6);
        out.writeUInt32BE(video ? this.videoSSRC : this.audioSSRC, 10);
        payload.copy(out, 14);
        return out;
    }

    *video(nals: Buffer[], stamp: number): Generator<Buffer> {
        for (let i = 0; i < nals.length; i++) {
            const nal = nals[i];
            const last = i === nals.length - 1;
            if (nal.length <= 1200) { yield this.packet(true, nal, stamp, last); continue; }
            for (let offset = 2; offset < nal.length; offset += 1197) {
                const end = Math.min(offset + 1197, nal.length);
                const header = Buffer.from([(nal[0] & 0x81) | (49 << 1), nal[1],
                    nalType(nal) | (offset === 2 ? 0x80 : 0) | (end === nal.length ? 0x40 : 0)]);
                yield this.packet(true, Buffer.concat([header, nal.subarray(offset, end)]), stamp, last && end === nal.length);
            }
        }
    }

    *audio(data: Buffer, stamp: number): Generator<Buffer> {
        // PCMA: one byte per sample. Split the device's larger audio blocks
        // into 20 ms packets without changing their sample timeline.
        for (let offset = 0; offset < data.length; offset += 160)
            yield this.packet(false, data.subarray(offset, offset + 160), stamp + offset, false);
    }
}

