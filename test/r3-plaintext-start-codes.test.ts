// Run with: node --experimental-strip-types --test test/r3-plaintext-start-codes.test.ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLoader } from './helpers.cjs';

test('R3 three-byte plaintext keyframe passes unchanged', () => {
    const { crypt, decryptVideo } = createLoader()('protocol/crypto');
    const key = Buffer.alloc(16, 7);
    // Synthetic IDR NAL header and bytes, not captured camera media.
    const nal = Buffer.concat([Buffer.from([19 << 1, 1]), Buffer.alloc(100, 0x55)]);
    const four = Buffer.concat([Buffer.from([0, 0, 0, 1]), nal]);
    assert.deepEqual(decryptVideo(four, key, 1), four,
        'Four-byte plaintext start codes must remain supported');
    const encrypted = Buffer.concat([
        crypt(four.subarray(0, 96), key), four.subarray(96),
    ]);
    assert.deepEqual(decryptVideo(encrypted, key, 1), four,
        'Encrypted keyframes must still decrypt');
    const three = Buffer.concat([Buffer.from([0, 0, 1]), nal]);
    assert.deepEqual(decryptVideo(three, key, 1), three,
        'Three-byte plaintext start codes must not trigger decryption');
    const short = three.subarray(0, 10);
    assert.deepEqual(decryptVideo(short, key, 1), short,
        'Short plaintext keyframes must not require 96 encrypted bytes');
});
