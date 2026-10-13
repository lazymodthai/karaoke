// Mixed-radix complex FFT (radices 2/3/4/5), recursive decimation-in-time.
// Needed because MDX-Net uses n_fft = 7680 = 2^9 · 3 · 5, which radix-2 can't do.

function factorize(n) {
  const factors = [];
  for (const p of [4, 2, 3, 5]) {
    while (n % p === 0) {
      factors.push(p);
      n /= p;
    }
  }
  if (n !== 1) throw new Error(`FFT size has unsupported prime factor ${n}`);
  return factors;
}

export class FFT {
  constructor(n) {
    this.n = n;
    this.factors = factorize(n);
    this.cos = new Float64Array(n);
    this.sin = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const a = (-2 * Math.PI * i) / n;
      this.cos[i] = Math.cos(a);
      this.sin[i] = Math.sin(a);
    }
    this.tRe = new Float64Array(5);
    this.tIm = new Float64Array(5);
  }

  // out = DFT(in). inverse=true computes the unscaled inverse DFT.
  transform(inRe, inIm, outRe, outIm, inverse = false) {
    this.inRe = inRe;
    this.inIm = inIm;
    this.outRe = outRe;
    this.outIm = outIm;
    this.sign = inverse ? -1 : 1;
    this.rec(0, 0, 1, this.n, 0);
  }

  rec(outOff, inOff, stride, n, f) {
    const { outRe, outIm } = this;
    if (n === 1) {
      outRe[outOff] = this.inRe[inOff];
      outIm[outOff] = this.inIm[inOff];
      return;
    }
    const p = this.factors[f];
    const m = n / p;
    for (let q = 0; q < p; q++) this.rec(outOff + q * m, inOff + q * stride, stride * p, m, f + 1);

    const N = this.n;
    const tw = N / n; // maps W_n^e to the global W_N table
    const rootStep = N / p; // W_p^1 = W_N^(N/p)
    const { cos, sin, tRe, tIm, sign } = this;
    for (let k = 0; k < m; k++) {
      // t_q = Y_q[k] · W_n^(q·k)
      for (let q = 0; q < p; q++) {
        const idx = outOff + q * m + k;
        const e = (q * k * tw) % N;
        const c = cos[e];
        const s = sign * sin[e];
        const r = outRe[idx];
        const i = outIm[idx];
        tRe[q] = r * c - i * s;
        tIm[q] = r * s + i * c;
      }
      // X[k + j·m] = Σ_q t_q · W_p^(q·j)
      for (let j = 0; j < p; j++) {
        let sr = 0;
        let si = 0;
        for (let q = 0; q < p; q++) {
          const e = ((q * j) % p) * rootStep;
          const c = cos[e];
          const s = sign * sin[e];
          sr += tRe[q] * c - tIm[q] * s;
          si += tRe[q] * s + tIm[q] * c;
        }
        outRe[outOff + k + j * m] = sr;
        outIm[outOff + k + j * m] = si;
      }
    }
  }
}
