// Separation engine. Runs in a hidden extension iframe inside the YouTube page
// (extension origin: can bundle onnxruntime-web/WASM and use WebGPU), and talks
// to the content script over a private MessagePort.
//
// in:  config {enabled, hold} | reset {streamId} | data {streamId, bytes, tso}
//      playhead {t, duration} | evicted {ks}
// out: status {phase, progress, backend, error} | block {streamId, k, start, inst, voc}

import * as ort from '../../vendor/ort/ort.webgpu.bundle.min.mjs';
import { WebmStream, concatBytes } from './webm.js';
import { PcmStore } from './pcm-store.js';
import { createSeparator, SAMPLE_RATE as SR, CHUNK, GEN, TRIM, DIM_F, DIM_T } from './mdx.js';

const MODEL_URL = 'https://huggingface.co/memoavatar/memo/resolve/main/misc/vocal_separator/Kim_Vocal_2.onnx';
const MODEL_CACHE = 'karaoke-models-v1';
const MIN_COVERAGE = 0.995; // tolerate a few missing samples at decode seams
const LOOKAHEAD_BLOCKS = 60;
const KEEP_BEHIND_SEC = 600;

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // no cross-origin isolation in an embedded frame

let port = null;
let enabled = false;
let hold = false;
let playhead = 0;
let durationSamples = Infinity;
let stream = null;
let separate = null;
let modelLoading = null;
let busy = false;
let estSec = null;
let status = { phase: 'idle' };

const decoder = new OfflineAudioContext(2, 1, SR);

function post(msg, transfer) {
  port?.postMessage(msg, transfer || []);
}

function setStatus(patch) {
  status = { ...status, ...patch };
  post({ type: 'status', ...status });
}

// ---------- model ----------

async function fetchModel() {
  const cache = await caches.open(MODEL_CACHE);
  const cached = await cache.match(MODEL_URL);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 66759214;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received - lastReport > total / 100) {
      lastReport = received;
      setStatus({ phase: 'downloading', progress: Math.min(received / total, 1) });
    }
  }
  const bytes = concatBytes(chunks);
  await cache.put(MODEL_URL, new Response(bytes));
  return bytes;
}

async function createSession(bytes) {
  const providers = navigator.gpu ? ['webgpu', 'wasm'] : ['wasm'];
  let lastErr;
  for (const ep of providers) {
    try {
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [ep],
        graphOptimizationLevel: 'all',
      });
      return { session, backend: ep };
    } catch (err) {
      lastErr = err;
      console.warn(`[karaoke engine] ${ep} backend failed`, err);
    }
  }
  throw lastErr;
}

function loadModel() {
  modelLoading ||= (async () => {
    try {
      setStatus({ phase: 'downloading', progress: 0 });
      const bytes = await fetchModel();
      setStatus({ phase: 'initializing' });
      const { session, backend } = await createSession(bytes);
      separate = createSeparator(async (input) => {
        const out = await session.run({ input: new ort.Tensor('float32', input, [1, 4, DIM_F, DIM_T]) });
        return out.output.data;
      });
      setStatus({ phase: 'ready', backend, progress: 1 });
      pump();
    } catch (err) {
      modelLoading = null; // allow a retry on the next enable
      setStatus({ phase: 'error', error: String(err?.message || err) });
    }
  })();
}

// ---------- audio stream ----------

function reset(streamId) {
  stream = {
    id: streamId,
    parser: new WebmStream(),
    init: null,
    prev: null,
    pcm: new PcmStore(),
    done: new Set(),
    chain: Promise.resolve(),
  };
}

function onData(streamId, bytes, tso) {
  const s = stream;
  if (!s || s.id !== streamId) return;
  let events;
  try {
    events = s.parser.push(new Uint8Array(bytes), tso);
  } catch (err) {
    console.warn('[karaoke engine] webm parse error', err);
    s.parser = new WebmStream();
    return;
  }
  for (const ev of events) {
    if (ev.type === 'init') {
      s.init = ev.bytes;
      s.prev = null; // a new init (format switch) restarts the decoder
    } else {
      s.chain = s.chain
        .then(() => decodeCluster(s, ev))
        .then(pump)
        .catch((err) => console.warn('[karaoke engine] cluster pipeline error', err));
    }
  }
}

async function decodeCluster(s, cluster) {
  if (!s.init || s !== stream) return;
  // Decode with the previous contiguous cluster as pre-roll so the Opus
  // decoder has converged by the time it reaches this cluster.
  const prev = s.prev && Math.abs(cluster.time - (s.prev.time + s.prev.samples / SR)) < 0.05 ? s.prev : null;
  const parts = prev ? [s.init, prev.bytes, cluster.bytes] : [s.init, cluster.bytes];
  let audio;
  try {
    audio = await decoder.decodeAudioData(concatBytes(parts).buffer);
  } catch (err) {
    console.warn('[karaoke engine] decode failed at', cluster.time, err);
    s.prev = null;
    return;
  }
  const skip = prev ? Math.min(prev.samples, audio.length) : 0;
  const L = audio.getChannelData(0).subarray(skip);
  const R = (audio.numberOfChannels > 1 ? audio.getChannelData(1) : audio.getChannelData(0)).subarray(skip);
  s.pcm.write(Math.round(cluster.time * SR), L, R);
  s.prev = { time: cluster.time, bytes: cluster.bytes, samples: L.length };
}

// ---------- scheduling ----------

function pickBlock() {
  const s = stream;
  const kp = Math.max(0, Math.floor((playhead * SR) / GEN));
  for (let k = kp; k < kp + LOOKAHEAD_BLOCKS; k++) {
    if (k * GEN >= durationSamples) break;
    if (s.done.has(k)) continue;
    if (s.pcm.coverage(k * GEN - TRIM, CHUNK, durationSamples) < MIN_COVERAGE) continue;
    // Without hold mode, skip a block we can't finish before playback leaves it.
    if (!hold && k === kp && estSec && ((k + 1) * GEN) / SR - playhead < estSec * 1.2) continue;
    return k;
  }
  return null;
}

async function pump() {
  if (busy || !enabled || !separate || !stream) return;
  const k = pickBlock();
  if (k == null) return;
  const s = stream;
  busy = true;
  try {
    const start = k * GEN;
    const mix = s.pcm.read(start - TRIM, CHUNK, durationSamples);
    const t0 = performance.now();
    const { vocals, instrumental } = await separate(mix.L, mix.R);
    const sec = (performance.now() - t0) / 1000;
    estSec = estSec == null ? sec : 0.7 * estSec + 0.3 * sec;
    if (s === stream) {
      s.done.add(k);
      const len = Math.max(0, Math.min(GEN, durationSamples - start));
      const cut = (a) => (len < GEN ? a.slice(0, len) : a);
      const inst = instrumental.map(cut);
      const voc = vocals.map(cut);
      post(
        { type: 'block', streamId: s.id, k, start: start / SR, sampleRate: SR, inst, voc, realtime: GEN / SR / sec },
        [...inst, ...voc].map((a) => a.buffer),
      );
      s.pcm.dropBefore(Math.floor((playhead - KEEP_BEHIND_SEC) * SR));
    }
  } catch (err) {
    console.error('[karaoke engine] separation failed', err);
    setStatus({ phase: 'error', error: String(err?.message || err) });
  } finally {
    busy = false;
    setTimeout(pump, 0);
  }
}

// ---------- messaging ----------

function onMessage({ data: msg }) {
  switch (msg.type) {
    case 'config':
      enabled = msg.enabled;
      hold = msg.hold;
      if (enabled) loadModel();
      pump();
      break;
    case 'reset':
      reset(msg.streamId);
      break;
    case 'data':
      onData(msg.streamId, msg.bytes, msg.tso || 0);
      break;
    case 'playhead':
      playhead = msg.t;
      durationSamples = Number.isFinite(msg.duration) && msg.duration > 0 ? Math.floor(msg.duration * SR) : Infinity;
      pump();
      break;
    case 'evicted':
      for (const k of msg.ks) stream?.done.delete(k);
      break;
  }
}

window.addEventListener('message', (e) => {
  if (e.data?.type !== 'karaoke-port' || !e.ports[0]) return;
  port = e.ports[0];
  port.onmessage = onMessage;
  post({ type: 'status', ...status });
});
