// Run with: node --experimental-strip-types --test test/r6-reordered-video.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createLoader } from './helpers.cjs';

test('R6 reordered video PTS preserves frames and RTP sequence order', () => {
    class FakeClient extends EventEmitter { close() {} }
    const { MediaSession } = createLoader({ '../protocol/client': { Client: FakeClient } })('media/session');
    const video = Buffer.from([0, 0, 0, 1, 2, 1, 0x55]);
    for (const origin of [0, 0xfffffff0]) {
        const session = new MediaSession({}, () => {}, () => {}, () => {});
        session.base = origin;
        session.ready = true;
        const packets = [];
        session.write = packet => packets.push(packet);
        for (const elapsed of [0, 120, 40, 80, 160])
            session.frame({ video: true, stamp: (origin + elapsed) >>> 0, payload: video });
        assert.deepEqual(packets.map(packet => packet.readUInt32BE(6)), [0, 10800, 3600, 7200, 14400],
            'Reordered video PTS must be preserved, including across device timestamp wrap');
        for (let i = 1; i < packets.length; i++)
            assert.equal(packets[i].readUInt16BE(4), (packets[i - 1].readUInt16BE(4) + 1) & 0xffff,
                'RTP sequence numbers must follow transmission order');
        session.frame({ video: true, stamp: (origin - 40) >>> 0, payload: video });
        session.frame({ video: false, stamp: (origin - 20) >>> 0, payload: Buffer.alloc(160) });
        assert.equal(packets.length, 5, 'Frames preceding the session origin must remain filtered');
        session.close();
    }
});
