// Streaming phase-vocoder pitch shifter: changes the key, keeps the tempo.
// Laroche & Dolson's peak-region shifting: each spectral peak and the bins
// around it move together to the new frequency, with one phase rotation per
// region so the bins stay coherent (shifting bins one by one smears the phase
// and loses level). Output lags input by exactly LATENCY samples. Pure DSP:
// shared by the AudioWorklet (pitch-worklet.js) and the tests.

import { FFT } from '../engine/fft.js';

export const FFT_SIZE = 2048;
export const OVERSAMPLE = 8;
const HOP = FFT_SIZE / OVERSAMPLE;
const FIFO_START = FFT_SIZE - HOP;
export const LATENCY = FFT_SIZE;

const N = FFT_SIZE;
const HALF = N / 2;
const TWO_PI = 2 * Math.PI;
const EXPECT = (TWO_PI * HOP) / N; // phase advance per hop of bin 1
// Periodic Hann for analysis and synthesis; Σ w² over the overlapping hops = 3/8 · OVERSAMPLE.
const WINDOW = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos((TWO_PI * i) / N));
const SCALE = 1 / (N * (3 / 8) * OVERSAMPLE);

export class PitchShifter {
  constructor(channels) {
    this.fft = new FFT(N);
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.oRe = new Float64Array(N);
    this.oIm = new Float64Array(N);
    this.mag = new Float64Array(HALF + 1);
    this.peaks = new Int32Array(HALF);
    this.chans = Array.from({ length: channels }, () => ({
      inFifo: new Float32Array(N),
      outFifo: new Float32Array(HOP),
      accum: new Float64Array(N),
      lastPhase: new Float64Array(HALF + 1),
      rot: new Float64Array(HALF + 1), // phase rotation of the region each bin was in, last frame
      nextRot: new Float64Array(HALF + 1),
    }));
    this.reset();
  }

  reset() {
    this.rover = FIFO_START;
    for (const c of this.chans) {
      c.inFifo.fill(0);
      c.outFifo.fill(0);
      c.accum.fill(0);
      c.lastPhase.fill(0);
      c.rot.fill(0);
    }
  }

  // inputs/outputs: one Float32Array per channel, n samples each.
  // ratio: frequency multiplier (2 ** (semitones / 12)).
  process(inputs, outputs, n, ratio) {
    const { chans } = this;
    for (let i = 0; i < n; i++) {
      const r = this.rover;
      for (let c = 0; c < chans.length; c++) {
        chans[c].inFifo[r] = inputs[c][i];
        outputs[c][i] = chans[c].outFifo[r - FIFO_START];
      }
      if (++this.rover === N) {
        this.rover = FIFO_START;
        for (const c of chans) this.frame(c, ratio);
      }
    }
  }

  frame(ch, ratio) {
    const { fft, re, im, oRe, oIm, mag, peaks } = this;
    for (let k = 0; k < N; k++) {
      re[k] = ch.inFifo[k] * WINDOW[k];
      im[k] = 0;
    }
    fft.transform(re, im, oRe, oIm);

    for (let k = 0; k <= HALF; k++) mag[k] = Math.hypot(oRe[k], oIm[k]);
    let count = 0;
    for (let k = 1; k < HALF; k++) if (mag[k] > mag[k - 1] && mag[k] >= mag[k + 1]) peaks[count++] = k;

    re.fill(0);
    im.fill(0);
    const { lastPhase, rot, nextRot } = ch;
    nextRot.fill(0);
    for (let i = 0; i < count; i++) {
      const p = peaks[i];
      // True frequency of the peak (in bins) from its phase advance since the last frame.
      let d = Math.atan2(oIm[p], oRe[p]) - lastPhase[p] - p * EXPECT;
      d -= TWO_PI * Math.round(d / TWO_PI);
      const freq = p + (OVERSAMPLE * d) / TWO_PI;
      // Advancing the rotation by the frequency change each hop makes the output
      // run at freq·ratio exactly; the bins land on the nearest whole bin.
      let r = rot[p] + freq * (ratio - 1) * EXPECT;
      r -= TWO_PI * Math.round(r / TWO_PI);
      const c = Math.cos(r);
      const s = Math.sin(r);
      const shift = Math.round(p * ratio) - p;
      const lo = i === 0 ? 0 : ((peaks[i - 1] + p) >> 1) + 1;
      const hi = i === count - 1 ? HALF : (p + peaks[i + 1]) >> 1;
      for (let k = lo; k <= hi; k++) {
        nextRot[k] = r;
        const t = k + shift;
        if (t < 0 || t > HALF) continue;
        re[t] += oRe[k] * c - oIm[k] * s;
        im[t] += oRe[k] * s + oIm[k] * c;
      }
    }
    for (let k = 0; k <= HALF; k++) lastPhase[k] = Math.atan2(oIm[k], oRe[k]);
    ch.rot = nextRot;
    ch.nextRot = rot;
    for (let k = 1; k < HALF; k++) {
      re[N - k] = re[k];
      im[N - k] = -im[k];
    }
    fft.transform(re, im, oRe, oIm, true);

    const { accum, outFifo, inFifo } = ch;
    for (let k = 0; k < N; k++) accum[k] += oRe[k] * WINDOW[k] * SCALE;
    for (let k = 0; k < HOP; k++) outFifo[k] = accum[k];
    accum.copyWithin(0, HOP);
    accum.fill(0, N - HOP);
    inFifo.copyWithin(0, HOP);
  }
}
