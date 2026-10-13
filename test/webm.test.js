import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { WebmStream, concatBytes } from '../extension/src/engine/webm.js';

const file = new Uint8Array(fs.readFileSync(new URL('./fixtures/opus.webm', import.meta.url)));

function parseInPieces(sizes) {
  const s = new WebmStream();
  const events = [];
  let pos = 0, i = 0;
  while (pos < file.length) {
    const n = sizes[i++ % sizes.length];
    events.push(...s.push(file.subarray(pos, pos + n)));
    pos += n;
  }
  return events;
}

test('splits init and clusters regardless of append boundaries', () => {
  const whole = parseInPieces([file.length]);
  const inits = whole.filter((e) => e.type === 'init');
  const clusters = whole.filter((e) => e.type === 'cluster');
  assert.equal(inits.length, 1);
  assert.ok(clusters.length >= 3, `clusters: ${clusters.length}`);
  for (let i = 1; i < clusters.length; i++) assert.ok(clusters[i].time > clusters[i - 1].time);
  assert.equal(clusters[0].time, 0);

  const pieces = parseInPieces([1, 7, 333, 4096, 13]);
  assert.deepEqual(pieces.map((e) => [e.type, e.time, e.bytes.length]), whole.map((e) => [e.type, e.time, e.bytes.length]));
});

test('init + a later cluster run decodes on its own', () => {
  const events = parseInPieces([file.length]);
  const init = events.find((e) => e.type === 'init').bytes;
  const clusters = events.filter((e) => e.type === 'cluster');
  const tail = clusters.slice(1);
  const out = path.join(os.tmpdir(), `karaoke-webm-${process.pid}.webm`);
  fs.writeFileSync(out, concatBytes([init, ...tail.map((c) => c.bytes)]));
  const pcm = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', out, '-f', 'f32le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 64 << 20 });
  fs.unlinkSync(out);
  const seconds = pcm.length / 8 / 48000;
  const expected = 8 - tail[0].time;
  assert.ok(Math.abs(seconds - expected) < 0.1, `decoded ${seconds}s, expected ~${expected}s`);
});
