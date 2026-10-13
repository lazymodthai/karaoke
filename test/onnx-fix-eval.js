// Manual check that the double->float rewrite makes HT-Demucs loadable in
// onnxruntime-web and keeps its output (not part of `npm test`: needs the model).
// Output parity is measured in onnxruntime-node (runs both versions); a full
// run in onnxruntime-web's WASM backend needs more memory than Node allows it.
// usage: node test/onnx-fix-eval.js <htdemucs_6s.onnx> <mix.raw f32le stereo 44.1k>
import fs from 'node:fs';
import * as ortWeb from 'onnxruntime-web';
import ortNode from 'onnxruntime-node';
import { doubleConstantsToFloat } from '../extension/src/engine/onnx-fix.js';
import { CHUNK } from '../extension/src/engine/demucs.js';

const [modelPath, mixPath] = process.argv.slice(2);
const original = new Uint8Array(fs.readFileSync(modelPath));

try {
  await ortWeb.InferenceSession.create(original, { executionProviders: ['wasm'] });
  console.log('original model: loads in onnxruntime-web (unexpected)');
} catch (err) {
  console.log('original model in onnxruntime-web:', String(err.message).split('\n')[0].slice(0, 160));
}

const t0 = performance.now();
const { bytes, tensors } = doubleConstantsToFloat(original);
console.log(`rewrote ${tensors} double constants in ${(performance.now() - t0).toFixed(0)} ms (${original.length} -> ${bytes.length} bytes)`);

await ortWeb.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
console.log('fixed model: loads in onnxruntime-web');

const raw = new Float32Array(fs.readFileSync(mixPath).buffer.slice(0));
const input = new Float32Array(2 * CHUNK);
for (let i = 0; i < Math.min(raw.length / 2, CHUNK); i++) {
  input[i] = raw[2 * i];
  input[CHUNK + i] = raw[2 * i + 1];
}
const feed = () => ({ mix: new ortNode.Tensor('float32', input, [1, 2, CHUNK]) });
const a = (await (await ortNode.InferenceSession.create(original)).run(feed())).stems.data;
const b = (await (await ortNode.InferenceSession.create(bytes)).run(feed())).stems.data;
let maxDiff = 0, err = 0, sig = 0;
for (let i = 0; i < a.length; i++) {
  const d = Math.abs(a[i] - b[i]);
  if (d > maxDiff) maxDiff = d;
  err += d * d;
  sig += a[i] * a[i];
}
console.log(`fixed vs original output: max diff ${maxDiff.toExponential(2)}, SNR ${(10 * Math.log10(sig / err)).toFixed(1)} dB`);
