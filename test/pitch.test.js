import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PitchShifter, LATENCY } from '../extension/src/audio/pitch-shift.js';
import { FFT } from '../extension/src/engine/fft.js';

const SR = 48000;
const QUANTUM = 128;

function run(input, ratio) {
  const shifter = new PitchShifter(2);
  const out = new Float32Array(input.length);
  const scratch = new Float32Array(QUANTUM);
  for (let i = 0; i + QUANTUM <= input.length; i += QUANTUM) {
    const block = input.subarray(i, i + QUANTUM);
    shifter.process([block, block], [out.subarray(i, i + QUANTUM), scratch], QUANTUM, ratio);
  }
  return out;
}

function sine(freq, sec) {
  return Float32Array.from({ length: SR * sec }, (_, i) => 0.5 * Math.sin((2 * Math.PI * freq * i) / SR));
}

// Strongest frequency in x[from, from + n), with parabolic interpolation.
function peakHz(x, from, n = 8192) {
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[from + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
  const oRe = new Float64Array(n);
  const oIm = new Float64Array(n);
  new FFT(n).transform(re, im, oRe, oIm);
  const mag = (k) => Math.hypot(oRe[k], oIm[k]);
  let best = 1;
  for (let k = 2; k < n / 2; k++) if (mag(k) > mag(best)) best = k;
  const [a, b, c] = [mag(best - 1), mag(best), mag(best + 1)];
  return ((best + (0.5 * (a - c)) / (a - 2 * b + c)) * SR) / n;
}

test('ratio 1 reproduces the input delayed by LATENCY', () => {
  const input = Float32Array.from({ length: SR }, () => Math.random() - 0.5);
  const out = run(input, 1);
  let err = 0;
  for (let i = LATENCY + 4096; i < input.length - 4096; i++) err = Math.max(err, Math.abs(out[i] - input[i - LATENCY]));
  assert.ok(err < 1e-4, `max error ${err}`);
});

test('shifts a tone by the requested semitones and keeps its level', () => {
  for (const semis of [-5, -2, 1, 3, 6]) {
    const out = run(sine(440, 2), 2 ** (semis / 12));
    const want = 440 * 2 ** (semis / 12);
    const got = peakHz(out, SR);
    assert.ok(Math.abs(got - want) < 2, `${semis} semitones: want ${want.toFixed(1)} Hz, got ${got.toFixed(1)} Hz`);
    let sum = 0;
    for (let i = SR; i < 2 * SR - QUANTUM; i++) sum += out[i] * out[i];
    const rms = Math.sqrt(sum / (SR - QUANTUM));
    assert.ok(Math.abs(rms - 0.5 / Math.SQRT2) < 0.06, `${semis} semitones: rms ${rms.toFixed(3)}`);
  }
});
