// Manual check of the 6-stem model (not part of `npm test`).
// usage: node test/demucs-eval.js <htdemucs_6s.onnx> <voice.raw> <inst.raw>  (f32le stereo 44.1k, ≥ 7.8 s)
import fs from 'node:fs';
import ort from 'onnxruntime-node';
import { createDemucsSeparator, CHUNK, GEN, TRIM, STEMS } from '../extension/src/engine/demucs.js';

const [modelPath, voicePath, instPath] = process.argv.slice(2);
const load = (p) => new Float32Array(fs.readFileSync(p).buffer.slice(0));
const deint = (x) => {
  const l = new Float32Array(CHUNK), r = new Float32Array(CHUNK);
  for (let i = 0; i < Math.min(x.length / 2, CHUNK); i++) { l[i] = x[2 * i]; r[i] = x[2 * i + 1]; }
  return [l, r];
};
const [vL, vR] = deint(load(voicePath));
const [iL, iR] = deint(load(instPath));
const mixL = vL.map((v, i) => 0.6 * v + 0.6 * iL[i]);
const mixR = vR.map((v, i) => 0.6 * v + 0.6 * iR[i]);

const session = await ort.InferenceSession.create(modelPath);
const separate = createDemucsSeparator(async (x) => (await session.run({ mix: new ort.Tensor('float32', x, [1, 2, CHUNK]) })).stems.data);
const t0 = performance.now();
const stems = await separate(mixL, mixR);
const ms = performance.now() - t0;

const energy = ([L, R]) => { let e = 0; for (let j = 0; j < GEN; j++) e += L[j] * L[j] + R[j] * R[j]; return e; };
const sdr = (ref, est) => {
  let s = 0, e = 0;
  for (let c = 0; c < 2; c++) for (let j = 0; j < GEN; j++) { const r = ref[c][TRIM + j]; s += r * r; const d = r - est[c][j]; e += d * d; }
  return 10 * Math.log10(s / e);
};
// stems should add back up to the mix
let resid = 0, mixE = 0;
for (let c = 0; c < 2; c++) for (let j = 0; j < GEN; j++) {
  const m = (c ? mixR : mixL)[TRIM + j];
  let sum = 0;
  for (const s of STEMS) sum += stems[s][c][j];
  resid += (m - sum) ** 2; mixE += m * m;
}
console.log(`segment ${(GEN / 44100).toFixed(2)} s processed in ${ms.toFixed(0)} ms (CPU)`);
console.log(`stems sum vs mix: ${(10 * Math.log10(mixE / resid)).toFixed(1)} dB`);
const total = STEMS.reduce((n, s) => n + energy(stems[s]), 0);
for (const s of STEMS) console.log(`  ${s.padEnd(7)} ${((100 * energy(stems[s])) / total).toFixed(1)}% of stem energy`);
console.log(`vocals SDR vs voice: ${sdr([vL.map((v) => 0.6 * v), vR.map((v) => 0.6 * v)], stems.vocals).toFixed(1)} dB`);
