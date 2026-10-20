// Run with: node --experimental-strip-types --test test/r5-long-running-timeline.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createLoader } from './helpers.cjs';

test('R5 long-running RTP timeline crosses half-range and wrap', () => {
    class FakeClient extends EventEmitter { close() {} }
    const { MediaSession } = createLoader({ '../protocol/client': { Client: FakeClient } })('media/session');
    const session = new MediaSession({}, () => {}, () => {}, () => {});
    session.base = 0; // Isolate timestamp handling after the first keyframe.
    session.ready = true;
    let packets = [];
    session.write = packet => packets.push(packet);
    const video = Buffer.from([0, 0, 0, 1, 2, 1, 0x55]);
    for (const elapsed of [0, 0x7fffffe0, 0x80000010, 0xffffffe0, 0x100000020, 0x17ffffff0, 0x180000020]) {
        packets = [];
        session.frame({ video: true, stamp: elapsed >>> 0, payload: video });
        session.frame({ video: false, stamp: elapsed >>> 0, payload: Buffer.alloc(160) });
        assert.equal(packets.length, 2, `Both tracks must output at elapsed ${elapsed}`);
        assert.equal(packets[0].readUInt32BE(6), (elapsed * 90) >>> 0);
        assert.equal(packets[1].readUInt32BE(6), (elapsed * 8) >>> 0);
    }
    packets = [];
    const elapsed = 0x180000020;
    session.frame({ video: true, stamp: (elapsed + 40) >>> 0, payload: video });
    session.frame({ video: false, stamp: (elapsed + 20) >>> 0, payload: Buffer.alloc(160) });
    assert.equal(packets.length, 2, 'Audio arriving behind video must retain its timeline');
    assert.equal(packets[1].readUInt32BE(6), ((elapsed + 20) * 8) >>> 0);
    session.frame({ video: true, stamp: (elapsed + 10) >>> 0, payload: video });
    assert.equal(packets.length, 3, 'Earlier video PTS must remain valid after multiple wraps');
    assert.equal(packets[2].readUInt32BE(6), ((elapsed + 10) * 90) >>> 0);
    session.close();
});
