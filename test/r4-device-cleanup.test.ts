// Run with: node --experimental-strip-types --test test/r4-device-cleanup.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoader } from './helpers.cjs';

test('R4 deleted device cleanup survives state errors', async () => {
    class Base {
        storage = { getItem: () => null };
        set motionDetected(_value) { throw new Error('Device state removed'); }
    }
    const sdk = { ScryptedDeviceBase: Base, ScryptedInterface: {},
        deviceManager: { getNativeIds: () => [] } };
    const load = createLoader({ '@scrypted/sdk': sdk });
    const { MotionMonitor } = load('device/motion');
    const { MarlbozeCamera } = load('device/camera');
    const provider = load('main').default;
    let closed = 0;
    const camera = Object.create(MarlbozeCamera.prototype);
    camera.sessions = new Set([{ close() { closed++; } }]);
    camera.motion = new MotionMonitor(() => { camera.motionDetected = false; }, () => {}, () => {});
    provider.cameras.set('removed', camera);
    try { await provider.releaseDevice('id', 'removed'); } catch { /* Check cleanup even if release reports failure. */ }
    assert.equal(closed, 1, 'Deleted device must close its media sessions despite state errors');
    assert.equal(camera.sessions.size, 0);
    assert.equal(provider.cameras.has('removed'), false, 'Provider must remove the cached device');
    provider.cameras.set('throws', { release() { throw new Error('Synthetic cleanup error'); } });
    await assert.rejects(provider.releaseDevice('id', 'throws'));
    assert.equal(provider.cameras.has('throws'), false, 'Cache removal must run in finally');
});
