// Sparse stereo PCM timeline indexed by absolute sample position, so audio
// decoded out of order (seeks, re-buffering) lands where it belongs.

const PAGE = 1 << 16;

export class PcmStore {
  constructor() {
    this.pages = new Map();
  }

  page(idx, create) {
    let p = this.pages.get(idx);
    if (!p && create) {
      p = { L: new Float32Array(PAGE), R: new Float32Array(PAGE), filled: new Uint8Array(PAGE) };
      this.pages.set(idx, p);
    }
    return p;
  }

  write(start, L, R) {
    for (let i = 0; i < L.length; ) {
      const abs = start + i;
      if (abs < 0) {
        i = -start;
        continue;
      }
      const idx = Math.floor(abs / PAGE);
      const off = abs - idx * PAGE;
      const n = Math.min(PAGE - off, L.length - i);
      const p = this.page(idx, true);
      p.L.set(L.subarray(i, i + n), off);
      p.R.set(R.subarray(i, i + n), off);
      p.filled.fill(1, off, off + n);
      i += n;
    }
  }

  // Copies [start, start + len) into new arrays; gaps and samples outside
  // [0, endSample) are zeros.
  read(start, len, endSample = Infinity) {
    const L = new Float32Array(len);
    const R = new Float32Array(len);
    for (let i = 0; i < len; ) {
      const abs = start + i;
      if (abs < 0 || abs >= endSample) {
        i++;
        continue;
      }
      const idx = Math.floor(abs / PAGE);
      const off = abs - idx * PAGE;
      const n = Math.min(PAGE - off, len - i, endSample - abs);
      const p = this.page(idx, false);
      if (p) {
        L.set(p.L.subarray(off, off + n), i);
        R.set(p.R.subarray(off, off + n), i);
      }
      i += n;
    }
    return { L, R };
  }

  // Fraction of [start, start + len) that has data (or lies outside [0, endSample)).
  coverage(start, len, endSample = Infinity) {
    let filled = 0;
    for (let i = 0; i < len; ) {
      const abs = start + i;
      if (abs < 0 || abs >= endSample) {
        filled++;
        i++;
        continue;
      }
      const idx = Math.floor(abs / PAGE);
      const off = abs - idx * PAGE;
      const n = Math.min(PAGE - off, len - i, endSample - abs);
      const p = this.page(idx, false);
      if (p) for (let j = off; j < off + n; j++) filled += p.filled[j];
      i += n;
    }
    return filled / len;
  }

  // Frees pages that end before `sample`.
  dropBefore(sample) {
    for (const idx of this.pages.keys()) {
      if ((idx + 1) * PAGE <= sample) this.pages.delete(idx);
    }
  }
}
