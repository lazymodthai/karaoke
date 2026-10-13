import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PcmStore } from '../extension/src/engine/pcm-store.js';

test('writes across pages and reads back with coverage', () => {
  const s = new PcmStore();
  const n = 200000;
  const L = Float32Array.from({ length: n }, (_, i) => i);
  const R = Float32Array.from({ length: n }, (_, i) => -i);
  s.write(1000, L, R);
  const r = s.read(1000, n);
  assert.equal(r.L[123456], 123456);
  assert.equal(r.R[n - 1], -(n - 1));
  assert.equal(s.coverage(1000, n), 1);
  assert.equal(s.coverage(0, 2000), 0.5);
  // negative region and beyond end-of-media count as covered silence
  assert.equal(s.coverage(-500, 500), 1);
  assert.equal(s.coverage(500, 1000), 0.5);
  assert.equal(s.coverage(1000 + n - 10, 20, 1000 + n), 1);
  s.dropBefore(1 << 17);
  assert.ok(s.coverage(1000, n) < 1);
});
