// Manual quality check with the real model (not part of `npm test`).
// usage: node test/model-eval.js <model.onnx> <voice.raw> <inst.raw>  (f32le stereo 44.1k)
import fs from 'node:fs';
import ort from 'onnxruntime-node';
import { createSeparator, CHUNK, GEN, TRIM, DIM_F, DIM_T } from '../extension/src/engine/mdx.js';

const [modelPath, voicePath, instPath] = process.argv.slice(2);
const load = (p) => new Float32Array(fs.readFileSync(p).buffer.slice(0));
const deint = (x) => {
  const n = x.length / 2, l = new Float32Array(CHUNK), r = new Float32Array(CHUNK);
  for (let i = 0; i < Math.min(n, CHUNK); i++) { l[i] = x[2 * i]; r[i] = x[2 * i + 1]; }
  return [l, r];
};
const [vL, vR] = deint(load(voicePath));
const [iL, iR] = deint(load(instPath));
const mixL = vL.map((v, i) => 0.6 * v + 0.6 * iL[i]);
const mixR = vR.map((v, i) => 0.6 * v + 0.6 * iR[i]);

const session = await ort.InferenceSession.create(modelPath);
const separate = createSeparator(async (x) => {
  const out = await session.run({ input: new ort.Tensor('float32', x, [1, 4, DIM_F, DIM_T]) });
  return out.output.data;
});
const t0 = performance.now();
const { vocals, instrumental } = await separate(mixL, mixR);
const ms = performance.now() - t0;

// SDR = 10·log10(|ref|² / |ref − est|²) over the trimmed region
function sdr(refs, ests) {
  let s = 0, e = 0;
  for (let c = 0; c < 2; c++) for (let j = 0; j < GEN; j++) {
    const r = refs[c][TRIM + j]; s += r * r; const d = r - ests[c][j]; e += d * d;
  }
  return 10 * Math.log10(s / e);
}
const vocRef = [vL.map((v) => 0.6 * v), vR.map((v) => 0.6 * v)];
const instRef = [iL.map((v) => 0.6 * v), iR.map((v) => 0.6 * v)];
const zero = [new Float32Array(GEN), new Float32Array(GEN)];
const mixAsInst = [mixL.subarray(TRIM, TRIM + GEN), mixR.subarray(TRIM, TRIM + GEN)];
console.log(`chunk ${(GEN / 44100).toFixed(2)} s processed in ${ms.toFixed(0)} ms (CPU)`);
console.log(`vocals SDR:       ${sdr(vocRef, vocals).toFixed(1)} dB (silence baseline ${sdr(vocRef, zero).toFixed(1)})`);
console.log(`instrumental SDR: ${sdr(instRef, instrumental).toFixed(1)} dB (untouched-mix baseline ${sdr(instRef, mixAsInst).toFixed(1)})`);
