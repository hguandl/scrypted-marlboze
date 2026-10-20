const MAX_BUFFER = 8 << 20;

export class Channel {
    seq = 0;
    buffer: Buffer = Buffer.alloc(0);
    pending = new Map<number, Buffer>();
    queued = 0;
    gap = 0;
    push(seq: number, data: Buffer): void {
        const distance = (seq - this.seq) & 0xffff;
        if (distance >= 0x8000) return;
        if (distance > 2048) throw new Error('Receive window exceeded');
        if (!this.pending.has(seq)) {
            if (this.buffer.length + this.queued + data.length > MAX_BUFFER)
                throw new Error('Receive buffer exceeded');
            this.pending.set(seq, Buffer.from(data));
            this.queued += data.length;
        }
        const chunks: Buffer[] = [];
        while (this.pending.has(this.seq)) {
            const next = this.pending.get(this.seq)!;
            chunks.push(next);
            this.queued -= next.length;
            this.pending.delete(this.seq);
            this.seq = (this.seq + 1) & 0xffff;
        }
        if (chunks.length) this.buffer = Buffer.concat([this.buffer, ...chunks]);
        // Advancing the receive sequence starts a new missing-packet deadline.
        this.gap = this.pending.size ? (chunks.length ? Date.now() : this.gap || Date.now()) : 0;
    }
}

