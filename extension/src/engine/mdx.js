// MDX-Net (UVR "Kim_Vocal_2") vocal separation around an injected model runner.
// Mirrors UVR's MDX pipeline: torch.stft(center=True, periodic Hann) -> keep the
// first dim_f bins as [L_re, L_im, R_re, R_im] -> model -> istft -> trim edges.

import { FFT } from './fft.js';

export const SAMPLE_RATE = 44100;
export const N_FFT = 7680;
export const HOP = 1024;
export const DIM_F = 3072;
export const DIM_T = 256;
export const COMPENSATE = 1.009;

export const CHUNK = HOP * (DIM_T - 1); // 261120 samples fed to the model
export const TRIM = N_FFT / 2; // edge samples discarded on each side
export const GEN = CHUNK - 2 * TRIM; // 253440 usable output samples (~5.75 s)

const HALF = N_FFT / 2;

function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  return w;
}

// torch "reflect" padding index for a centered STFT
function reflect(i, len) {
  if (i < 0) return -i;
  if (i >= len) return 2 * (len - 1) - i;
  return i;
}

// run: async (Float32Array[1·4·DIM_F·DIM_T]) => Float32Array of the same layout
export function createSeparator(run) {
  const fft = new FFT(N_FFT);
  const win = hann(N_FFT);
  const re = new Float64Array(N_FFT);
  const im = new Float64Array(N_FFT);
  const zr = new Float64Array(N_FFT);
  const zi = new Float64Array(N_FFT);
  const plane = DIM_F * DIM_T;

  function stft(mixL, mixR) {
    const spec = new Float32Array(4 * plane);
    for (let t = 0; t < DIM_T; t++) {
      // Pack L as real and R as imaginary: one complex FFT gives both spectra.
      const start = t * HOP - HALF;
      for (let i = 0; i < N_FFT; i++) {
        const j = reflect(start + i, CHUNK);
        re[i] = mixL[j] * win[i];
        im[i] = mixR[j] * win[i];
      }
      fft.transform(re, im, zr, zi);
      // UVR zeroes the first 3 bins before inference.
      for (let f = 3; f < DIM_F; f++) {
        const nf = N_FFT - f;
        const o = f * DIM_T + t;
        spec[o] = (zr[f] + zr[nf]) / 2; // L re
        spec[plane + o] = (zi[f] - zi[nf]) / 2; // L im
        spec[2 * plane + o] = (zi[f] + zi[nf]) / 2; // R re
        spec[3 * plane + o] = -(zr[f] - zr[nf]) / 2; // R im
      }
    }
    return spec;
  }

  // Returns only the trimmed region [TRIM, TRIM + GEN) of the inverse STFT.
  function istft(spec) {
    const padLen = CHUNK + N_FFT;
    const olaL = new Float64Array(padLen);
    const olaR = new Float64Array(padLen);
    const env = new Float64Array(padLen);
    for (let t = 0; t < DIM_T; t++) {
      zr.fill(0);
      zi.fill(0);
      for (let f = 0; f < DIM_F; f++) {
        const o = f * DIM_T + t;
        const lr = spec[o];
        const li = spec[plane + o];
        const rr = spec[2 * plane + o];
        const ri = spec[3 * plane + o];
        // Z = L + iR, and its Hermitian mirror conj(L) + i·conj(R)
        zr[f] = lr - ri;
        zi[f] = li + rr;
        if (f > 0) {
          zr[N_FFT - f] = lr + ri;
          zi[N_FFT - f] = rr - li;
        }
      }
      fft.transform(zr, zi, re, im, true);
      const base = t * HOP;
      for (let i = 0; i < N_FFT; i++) {
        const w = win[i];
        olaL[base + i] += (re[i] / N_FFT) * w;
        olaR[base + i] += (im[i] / N_FFT) * w;
        env[base + i] += w * w;
      }
    }
    const outL = new Float32Array(GEN);
    const outR = new Float32Array(GEN);
    const off = HALF + TRIM;
    for (let j = 0; j < GEN; j++) {
      const e = env[off + j];
      const s = e > 1e-11 ? COMPENSATE / e : 0;
      outL[j] = olaL[off + j] * s;
      outR[j] = olaR[off + j] * s;
    }
    return [outL, outR];
  }

  // mixL/mixR: CHUNK samples covering [start - TRIM, start + GEN + TRIM).
  // Returns vocals and instrumental for [start, start + GEN).
  return async function separate(mixL, mixR) {
    const spec = stft(mixL, mixR);
    const out = await run(spec);
    const [vocL, vocR] = istft(out);
    const instL = new Float32Array(GEN);
    const instR = new Float32Array(GEN);
    for (let j = 0; j < GEN; j++) {
      instL[j] = mixL[TRIM + j] - vocL[j];
      instR[j] = mixR[TRIM + j] - vocR[j];
    }
    return { vocals: [vocL, vocR], instrumental: [instL, instR] };
  };
}
