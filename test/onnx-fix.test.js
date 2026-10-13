import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
import { doubleConstantsToFloat } from '../extension/src/engine/onnx-fix.js';

// y = float(ConstantOfShape<double 0.5> + Constant<double [1.25, 2.5]>) * x
// (The browser's WebGPU build of onnxruntime-web has no double kernels; the
// Node build used here does, so this checks the rewrite, not the failure.)
const model = new Uint8Array(fs.readFileSync(new URL('./fixtures/double-constants.onnx', import.meta.url)));

test('double constants are rewritten to float and the model computes the same result', async () => {
  const { bytes, tensors } = doubleConstantsToFloat(model);
  assert.equal(tensors, 2);
  assert.equal(doubleConstantsToFloat(bytes).tensors, 0, 'no double constants left');
  const run = async (m) => {
    const session = await ort.InferenceSession.create(m, { executionProviders: ['wasm'] });
    return [...(await session.run({ x: new ort.Tensor('float32', Float32Array.from([2, 4]), [2]) })).y.data];
  };
  assert.deepEqual(await run(bytes), [3.5, 12]);
  assert.deepEqual(await run(bytes), await run(model));
});
