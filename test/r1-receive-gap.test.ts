// Run with: node --experimental-strip-types --test test/r1-receive-gap.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createLoader } from './helpers.cjs';

test('R1 current receive gap gets its own timeout', () => {
    const originalNow = Date.now;
    let now = 1000;
    let client;
    class NoNetworkSocket extends EventEmitter {
        send() { throw new Error('Regression check must not send network traffic'); }
        close() {}
    }
    try {
        Date.now = () => now;
        const load = createLoader({
            'node:dgram': { createSocket: () => new NoNetworkSocket() },
        });
        const { Client } = load('protocol/client');
        client = new Client({
            uid: 'TEST-1-TEST',
            mac: '02-00-00-00-00-01',
            password: 'synthetic-only',
            ip: '192.0.2.1',
            stream: 0,
        }, () => {});
        // Do not call open(): inject ordered-packet events directly.
        const channel = client.channels[0];
        channel.push(1, Buffer.from([1]));
        now = 2000;
        channel.push(3, Buffer.from([3]));
        channel.push(0, Buffer.from([0]));
        assert.equal(channel.seq, 2);
        assert.deepEqual(channel.buffer, Buffer.from([0, 1]));
        now = 4000;
        channel.push(3, Buffer.from([3])); // Duplicate must not extend the current deadline.
        now = 4100;
        assert.doesNotThrow(() => client.tick(),
            'The current missing sequence has existed for at most 2100 ms');
        now = 5101;
        assert.throws(() => client.tick(), /Unrecovered packet gap/,
            'An unchanged gap must still time out after 3000 ms');
    }
    finally {
        try { client?.close(); }
        finally { Date.now = originalNow; }
    }
});
