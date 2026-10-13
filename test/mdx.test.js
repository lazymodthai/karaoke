import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FFT } from '../extension/src/engine/fft.js';
import { createSeparator, CHUNK, GEN, TRIM, COMPENSATE } from '../extension/src/engine/mdx.js';

function naiveDft(re, im) {
  const n = re.length;
  const oRe = new Float64Array(n);
  const oIm = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const a = (-2 * Math.PI * k * t) / n;
      oRe[k] += re[t] * Math.cos(a) - im[t] * Math.sin(a);
      oIm[k] += re[t] * Math.sin(a) + im[t] * Math.cos(a);
    }
  }
  return [oRe, oIm];
}

test('mixed-radix FFT matches naive DFT', () => {
  for (const n of [2, 3, 5, 8, 30, 60, 120, 240]) {
    const re = Float64Array.from({ length: n }, () => Math.random() - 0.5);
    const im = Float64Array.from({ length: n }, () => Math.random() - 0.5);
    const outRe = new Float64Array(n);
    const outIm = new Float64Array(n);
    new FFT(n).transform(re, im, outRe, outIm);
    const [eRe, eIm] = naiveDft(re, im);
    for (let k = 0; k < n; k++) {
      assert.ok(Math.abs(outRe[k] - eRe[k]) < 1e-9, `n=${n} re[${k}]`);
      assert.ok(Math.abs(outIm[k] - eIm[k]) < 1e-9, `n=${n} im[${k}]`);
    }
  }
});

test('FFT 7680 round-trips', () => {
  const n = 7680;
  const fft = new FFT(n);
  const re = Float64Array.from({ length: n }, () => Math.random() - 0.5);
  const im = new Float64Array(n);
  const a = new Float64Array(n), b = new Float64Array(n);
  const c = new Float64Array(n), d = new Float64Array(n);
  fft.transform(re, im, a, b);
  fft.transform(a, b, c, d, true);
  for (let i = 0; i < n; i++) assert.ok(Math.abs(c[i] / n - re[i]) < 1e-9);
});

test('identity model: vocals = compensated mix, instrumental ≈ residual', async () => {
  const mixL = new Float32Array(CHUNK);
  const mixR = new Float32Array(CHUNK);
  for (let i = 0; i < CHUNK; i++) {
    // energy above the 3 zeroed bins (~17 Hz)
    mixL[i] = 0.4 * Math.sin(2 * Math.PI * 440 * i / 44100) + 0.1 * Math.sin(2 * Math.PI * 3000 * i / 44100);
    mixR[i] = 0.3 * Math.sin(2 * Math.PI * 660 * i / 44100);
  }
  const separate = createSeparator(async (x) => x);
  const t0 = performance.now();
  const { vocals, instrumental } = await separate(mixL, mixR);
  console.log(`  stft+istft: ${(performance.now() - t0).toFixed(0)} ms`);
  assert.equal(vocals[0].length, GEN);
  let maxErr = 0;
  for (let j = 0; j < GEN; j++) {
    maxErr = Math.max(maxErr, Math.abs(vocals[0][j] - mixL[TRIM + j] * COMPENSATE), Math.abs(vocals[1][j] - mixR[TRIM + j] * COMPENSATE));
  }
  assert.ok(maxErr < 1e-3, `max reconstruction error ${maxErr}`);
  assert.ok(Math.abs(instrumental[0][100] - (mixL[TRIM + 100] - vocals[0][100])) < 1e-7);
});
