// HT-Demucs 6-stem separation around an injected model runner. The ONNX export
// takes the raw waveform (its STFT is built in), one 7.8 s segment at a time.
// Like the MDX pipeline, each segment's edges are discarded so blocks can be
// stitched back to back without seams.

export const SAMPLE_RATE = 44100;
export const CHUNK = 343980; // model segment (7.8 s)
export const TRIM = 22050; // 0.5 s discarded on each side
export const GEN = CHUNK - 2 * TRIM; // 299880 usable samples (~6.8 s)
export const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

// run: async (Float32Array[1·2·CHUNK]) => Float32Array[1·6·2·CHUNK]
export function createDemucsSeparator(run) {
  // mixL/mixR: CHUNK samples covering [start - TRIM, start + GEN + TRIM).
  // Returns { [stem]: [L, R] } for [start, start + GEN).
  return async function separate(mixL, mixR) {
    const input = new Float32Array(2 * CHUNK);
    input.set(mixL, 0);
    input.set(mixR, CHUNK);
    const out = await run(input);
    const stems = {};
    STEMS.forEach((name, s) => {
      const base = s * 2 * CHUNK;
      stems[name] = [
        out.slice(base + TRIM, base + TRIM + GEN),
        out.slice(base + CHUNK + TRIM, base + CHUNK + TRIM + GEN),
      ];
    });
    return stems;
  };
}
