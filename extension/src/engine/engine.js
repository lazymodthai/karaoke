// Separation engine. Runs in a hidden extension iframe inside the YouTube page
// (extension origin: can bundle onnxruntime-web/WASM and use WebGPU), and talks
// to the content script over a private MessagePort.
//
// in:  config {enabled, hold, remove: {vocals, guitar, drums, bass}, configId}
//      reset {streamId} | data {streamId, bytes, tso} | playhead {t, duration} | evicted {ks}
// out: status {phase, model, models, progress, backend, error}
//      block {streamId, configId, k, start, gen, inst, voc, vocRemoved}
//
// Removing only vocals uses MDX-Net (cleanest vocals, light). As soon as any
// instrument (guitar/drums/bass) is selected, HT-Demucs 6-stem does all the
// separation, vocals included. The backing track is the mix minus the removed
// stems, so everything else stays exactly as recorded.
//
// Blocks are `gen` samples on the active model's grid. The model reads its
// own window around a block — `lead` samples before it, `chunk` in total — and
// returns at least `gen` samples starting at the block.

import * as ort from '../../vendor/ort/ort.webgpu.bundle.min.mjs';
import { WebmStream, concatBytes } from './webm.js';
import { PcmStore } from './pcm-store.js';
import * as mdx from './mdx.js';
import * as demucs from './demucs.js';
import { doubleConstantsToFloat } from './onnx-fix.js';

const SR = 44100;
const MODEL_CACHE = 'karaoke-models-v1';
const MIN_COVERAGE = 0.995; // tolerate a few missing samples at decode seams
// Separate at most this far ahead of playback, and rest between blocks once
// comfortably ahead: running the GPU flat out starves video decoding and
// compositing, which makes playback stutter (worst with the 6-stem model).
const LOOKAHEAD_SEC = 30;
const RELAXED_AHEAD_SEC = 12;
const REST_MS = 400;
const KEEP_BEHIND_SEC = 600;
const INSTRUMENTS = ['guitar', 'drums', 'bass'];

const MODELS = {
  mdx: {
    url: 'https://huggingface.co/memoavatar/memo/resolve/main/misc/vocal_separator/Kim_Vocal_2.onnx',
    size: 66759214,
    window: { lead: mdx.TRIM, chunk: mdx.CHUNK, gen: mdx.GEN },
    build(session) {
      const separate = mdx.createSeparator(async (input) => {
        const out = await session.run({ input: new ort.Tensor('float32', input, [1, 4, mdx.DIM_F, mdx.DIM_T]) });
        return out.output.data;
      });
      return async (L, R) => ({ vocals: (await separate(L, R)).vocals });
    },
  },
  demucs: {
    url: 'https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx',
    size: 136428532,
    // Its inverse STFT uses float64 constants, which onnxruntime-web can't run.
    prepare: (bytes) => doubleConstantsToFloat(bytes).bytes,
    window: { lead: demucs.TRIM, chunk: demucs.CHUNK, gen: demucs.GEN },
    build(session) {
      return demucs.createDemucsSeparator(async (input) => {
        const out = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, demucs.CHUNK]) });
        return out.stems.data;
      });
    },
  },
};

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // no cross-origin isolation in an embedded frame

let port = null;
let config = { enabled: false, hold: false, remove: { vocals: true }, configId: 0 };
let playhead = 0;
let durationSamples = Infinity;
let stream = null;
const models = new Map(); // name -> { name, window, separate, session } once loaded
const loading = new Map(); // name -> promise
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

// One model at a time: any instrument selected -> Demucs for everything
// (vocals included); vocals alone -> MDX.
function wantedModels() {
  if (!config.enabled) return []; // off (or a background tab): free GPU memory
  const r = config.remove || {};
  if (INSTRUMENTS.some((i) => r[i])) return ['demucs'];
  return r.vocals ? ['mdx'] : [];
}

const allReady = () => wantedModels().every((n) => models.has(n));

// ---------- model ----------

async function fetchModel(name) {
  const { url, size } = MODELS[name];
  const cache = await caches.open(MODEL_CACHE);
  const cached = await cache.match(url);
  if (cached) return new Uint8Array(await cached.arrayBuffer());

  const res = await fetch(url);
  if (!res.ok) throw new Error(`model download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || size;
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
      setStatus({ phase: 'downloading', model: name, progress: Math.min(received / total, 1) });
    }
  }
  const bytes = concatBytes(chunks);
  await cache.put(url, new Response(bytes));
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
      if (ep === 'webgpu') watchDevice();
      return { session, backend: ep };
    } catch (err) {
      lastErr = err;
      console.warn(`[karaoke engine] ${ep} backend failed`, err);
    }
  }
  throw lastErr;
}

// Surfaces GPU failures (device loss, out-of-memory) instead of only seeing
// the opaque run errors they cause.
let watchedDevice = null;
async function watchDevice() {
  try {
    const device = await ort.env.webgpu.device;
    if (!device || device === watchedDevice) return;
    watchedDevice = device;
    device.lost.then((info) => {
      console.error('[karaoke engine] GPU device lost', info.reason, info.message);
      setStatus({ phase: 'error', error: `GPU device lost: ${info.message || info.reason}`, deviceLost: true });
    });
    device.addEventListener('uncapturederror', (e) => {
      console.error('[karaoke engine] GPU error', e.error?.message);
      setStatus({ phase: 'error', error: `GPU error: ${e.error?.message}` });
    });
  } catch {}
}

// Loads the models the current config needs. Sessions are never released:
// onnxruntime-web shares one GPU device between them and releasing a session
// can destroy that device under the other ("Device was destroyed", then
// "Buffer was unmapped before mapping was resolved"). To free memory, the
// content script removes this whole frame instead.
function ensureModels() {
  const wanted = wantedModels();
  for (const name of wanted) {
    if (models.has(name) || loading.has(name)) continue;
    const promise = (async () => {
      try {
        setStatus({ phase: 'downloading', model: name, progress: 0 });
        const def = MODELS[name];
        const raw = await fetchModel(name);
        setStatus({ phase: 'initializing', model: name });
        const bytes = def.prepare ? def.prepare(raw) : raw;
        const { session, backend } = await createSession(bytes);
        models.set(name, { name, window: def.window, separate: def.build(session), session });
        estSec = null;
        setStatus({ phase: allReady() ? 'ready' : 'initializing', model: name, models: [...models.keys()], backend, progress: 1 });
        pump();
      } catch (err) {
        setStatus({ phase: 'error', model: name, error: String(err?.message || err) });
      } finally {
        if (loading.get(name) === promise) loading.delete(name); // allow a retry
      }
    })();
    loading.set(name, promise);
  }
  if (wanted.length && allReady()) setStatus({ phase: 'ready', models: wanted });
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

// The PCM span every selected model needs for block k.
function blockSpan(k, active, GEN) {
  let from = Infinity;
  let to = -Infinity;
  for (const m of active) {
    from = Math.min(from, k * GEN - m.window.lead);
    to = Math.max(to, k * GEN - m.window.lead + m.window.chunk);
  }
  return [from, to];
}

function pickBlock(active, GEN) {
  const s = stream;
  const kp = Math.max(0, Math.floor((playhead * SR) / GEN));
  const last = Math.floor(((playhead + LOOKAHEAD_SEC) * SR) / GEN);
  for (let k = kp; k <= last; k++) {
    if (k * GEN >= durationSamples) break;
    if (s.done.has(k)) continue;
    const [from, to] = blockSpan(k, active, GEN);
    if (s.pcm.coverage(from, to - from, durationSamples) < MIN_COVERAGE) continue;
    // Without hold mode, skip a block we can't finish before playback leaves it.
    if (!config.hold && k === kp && estSec && ((k + 1) * GEN) / SR - playhead < estSec * 1.2) continue;
    return k;
  }
  return null;
}

async function pump() {
  if (busy || !config.enabled || !stream || !wantedModels().length || !allReady()) return;
  const active = wantedModels().map((n) => models.get(n));
  const GEN = Math.min(...active.map((m) => m.window.gen));
  const k = pickBlock(active, GEN);
  if (k == null) return;
  const s = stream;
  const { configId, remove } = config;
  busy = true;
  let ahead = 0;
  try {
    const start = k * GEN;
    ahead = start / SR - playhead;
    const t0 = performance.now();
    const results = {};
    for (const m of active) {
      const mix = s.pcm.read(start - m.window.lead, m.window.chunk, durationSamples);
      results[m.name] = await m.separate(mix.L, mix.R); // each stem starts at `start`
      if (configId !== config.configId) return; // selection changed meanwhile
    }
    const sec = (performance.now() - t0) / 1000;
    estSec = estSec == null ? sec : 0.7 * estSec + 0.3 * sec;
    if (s === stream && configId === config.configId) {
      s.done.add(k);
      const len = Math.max(0, Math.min(GEN, durationSamples - start));
      const mix = s.pcm.read(start, len, durationSamples);
      // Whichever model ran provides the vocals (also used for the guide
      // track and lyrics timing, even when vocals aren't removed).
      const vocals = (results.mdx || results.demucs).vocals;
      const removed = [];
      if (remove.vocals) removed.push(vocals);
      for (const name of INSTRUMENTS) if (remove[name]) removed.push(results.demucs[name]);
      // Backing = mix minus every removed stem.
      const inst = [mix.L, mix.R].map((ch, c) => {
        const out = ch.slice(0, len);
        for (const stem of removed) {
          const x = stem[c];
          for (let j = 0; j < len; j++) out[j] -= x[j];
        }
        return out;
      });
      const voc = vocals.map((a) => a.slice(0, len));
      post(
        {
          type: 'block',
          streamId: s.id,
          configId,
          k,
          start: start / SR,
          gen: GEN,
          sampleRate: SR,
          inst,
          voc,
          vocRemoved: !!remove.vocals,
          realtime: GEN / SR / sec,
        },
        [...inst, ...voc].map((a) => a.buffer),
      );
      s.pcm.dropBefore(Math.floor((playhead - KEEP_BEHIND_SEC) * SR));
      if (status.phase === 'error') setStatus({ phase: 'ready', error: null }); // recovered
    }
  } catch (err) {
    // A run for a model or selection that's been switched away is moot.
    const moot = configId !== config.configId;
    console[moot ? 'warn' : 'error']('[karaoke engine] separation failed', err);
    if (!moot) setStatus({ phase: 'error', error: String(err?.message || err) });
  } finally {
    busy = false;
    setTimeout(pump, ahead > RELAXED_AHEAD_SEC ? REST_MS : 0);
  }
}

// ---------- messaging ----------

function onMessage({ data: msg }) {
  switch (msg.type) {
    case 'config': {
      const changed = msg.configId !== config.configId;
      config = { enabled: msg.enabled, hold: msg.hold, remove: msg.remove || { vocals: true }, configId: msg.configId };
      if (changed) stream?.done.clear(); // results for the old stem selection are stale
      ensureModels();
      pump();
      break;
    }
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
