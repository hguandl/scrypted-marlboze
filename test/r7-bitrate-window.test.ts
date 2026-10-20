// Run with: node --experimental-strip-types --test test/r7-bitrate-window.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createLoader } from './helpers.cjs';

test('R7 bitrate windows tolerate PTS reorder and timestamp wrap', () => {
    class FakeClient extends EventEmitter { close() {} }
    const { MediaSession } = createLoader({ '../protocol/client': { Client: FakeClient } })('media/session');
    for (const origin of [0, 0xfffff000]) {
        const rates = [], packets = [];
        const session = new MediaSession({}, () => {}, () => {}, metadata => {
            if (metadata.bitrate !== undefined) rates.push(metadata.bitrate);
        });
        session.base = origin;
        session.ready = true;
        session.write = packet => packets.push(packet);
        const payload = Buffer.alloc(1000, 0x55);
        Buffer.from([0, 0, 0, 1, 2, 1]).copy(payload);
        const frame = elapsed => session.frame({ video: true, stamp: (origin + elapsed) >>> 0, payload });
        for (const elapsed of [0, 5040, 4960]) frame(elapsed);
        assert.deepEqual(rates, [Math.round(2000 * 8000 / 5040)],
            'Reordered PTS after window reset must not create a false bitrate report');
        frame(5000);
        frame(10080);
        assert.deepEqual(rates, [Math.round(2000 * 8000 / 5040), Math.round(3000 * 8000 / 5040)],
            'Reordered frame bytes must count toward the next real window, including across wrap');
        assert.equal(packets.length, 5, 'Statistics must not discard reordered frames');
        session.close();
    }
});
