// Copies the onnxruntime-web files the engine needs into vendor/ort/
// (extensions can't load remote code, so the runtime must ship with them).
import fs from 'node:fs';
import path from 'node:path';

const src = path.resolve('node_modules/onnxruntime-web/dist');
const dest = path.resolve('extension/vendor/ort');
const files = [
  'ort.webgpu.bundle.min.mjs',
  'ort-wasm-simd-threaded.asyncify.mjs',
  'ort-wasm-simd-threaded.asyncify.wasm',
];
fs.mkdirSync(dest, { recursive: true });
for (const f of files) fs.copyFileSync(path.join(src, f), path.join(dest, f));
console.log(`copied ${files.length} files to ${path.relative(process.cwd(), dest)}`);
