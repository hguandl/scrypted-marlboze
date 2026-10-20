// Run with: node --experimental-strip-types --test test/r2-close-during-listen.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { createLoader } from './helpers.cjs';

test('R2 close during TCP startup rejects open()', async () => {
    let session;
    let server;
    let deadline;
    let closeWasInjected = false;
    class FakeClient extends EventEmitter {
        async open() {
            // Isolate TCP startup from login, frame parsing, and media probing.
            session.ready = true;
            session.onReady();
        }
        close() {}
    }
    class PendingServer extends EventEmitter {
        listen(_port, _host, callback) {
            this.once('listening', callback);
            this.pending = setImmediate(() => {
                this.pending = undefined;
                this.emit('listening');
            });
            // Model cancellation between listen() and the listening event.
            closeWasInjected = true;
            session.close();
            return this;
        }
        close(callback) {
            clearImmediate(this.pending);
            this.pending = undefined;
            queueMicrotask(() => {
                this.emit('close');
                callback?.();
            });
            return this;
        }
    }
    const load = createLoader({
        '../protocol/client': { Client: FakeClient },
        'node:net': { createServer: () => (server = new PendingServer()) },
    });
    const { MediaSession } = load('media/session');
    session = new MediaSession({}, () => {}, () => {}, () => {});
    try {
        const result = await Promise.race([
            session.open().then(() => 'resolved', () => 'rejected'),
            new Promise(resolve => {
                deadline = setTimeout(() => resolve('pending'), 100);
            }),
        ]);
        assert.ok(closeWasInjected, 'The check must reach TCP startup');
        assert.equal(result, 'rejected',
            'Closing during TCP startup must reject open(), not hang or resolve');
        for (const event of ['listening', 'error', 'close'])
            assert.equal(server.listenerCount(event), 0, `Startup must clean up its ${event} listener`);
    }
    finally {
        clearTimeout(deadline);
        session.close();
        if (server) clearImmediate(server.pending);
    }
});
