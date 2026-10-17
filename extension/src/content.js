// YouTube Karaoke — content script (isolated world, document_start)
//
// 1. Receives the audio bytes captured by inject.js and forwards the stream that
//    belongs to the current <video> to the separation engine (hidden iframe).
// 2. Plays the separated instrumental (+ optional guide vocals) in sync with the
//    video and mutes the original audio wherever a separated block is ready.
// 3. Optionally pauses the video until the AI has caught up ("hold" mode).
// 4. Adds a karaoke toggle button to the YouTube player controls.

(() => {
  // remove*: which stems to take out (any on = karaoke on). strength: how much
  // of the separated vocals to take out (1 = all; less leaves a guide vocal).
  // pitch: key change in semitones (works with or without karaoke).
  const DEFAULTS = { removeVocals: false, removeGuitar: false, removeDrums: false, removeBass: false, strength: 1, hold: true, pitch: 0 };
  const STEM_KEYS = ['removeVocals', 'removeGuitar', 'removeDrums', 'removeBass'];
  const INJECT_TAG = '__karaokeInject';
  const SR = 44100;
  let blockSec = 253440 / SR; // separated block length; updated from the engine (depends on the model)
  const TICK_MS = 200;
  const DRIFT_SEC = 0.08;
  const KEEP_BEHIND_SEC = 60;
  const MAX_RAW_BYTES = 64 << 20;
  const HOLD_GIVE_UP_SEC = 30;

  let settings = { ...DEFAULTS };
  let configId = 1; // bumped whenever the stem selection changes
  const isOn = () => STEM_KEYS.some((k) => settings[k]);

  // ---------- captured MSE streams ----------
  const msByUrl = new Map(); // blob url -> msId
  const sbs = new Map(); // sbId -> { msId, mime, chunks: [{bytes, tso}], size }
  let activeId = null;

  // ---------- engine ----------
  let engineFrame = null;
  let port = null;
  let engine = { phase: 'idle' };
  let lastPlayheadSent = -1;
  let realtime = null;

  // ---------- audio ----------
  let ctx = null;
  let needsGesture = false;
  const graphs = new Map(); // video -> { orig: GainNode }
  let stemBus = null;
  let master = null; // everything we play -> (pitch shifter) -> speakers
  let instGain = null;
  let vocGain = null;
  let chain = []; // scheduled blocks: { k, srcs, ctxStart, mediaStart, ctxEnd }
  const blocks = new Map(); // k -> { k, start, duration, inst, voc, bufs }
  let stemsOn = false;
  let lastMissingBlock = -1; // only log a missing block once

  // ---------- key change ----------
  let pitchNode = null;
  let pitchLoading = false;
  let pitchError = null;
  let pitchLatency = 0; // seconds the shifter delays its input
  let pitchRouted = false;
  let pitchRatio = 1;

  // ---------- hold ----------
  let heldByUs = false;
  let holdSince = 0;
  let lastBlockAt = 0;
  let holdOverride = false;
  let resumingByUs = false;

  let video = null;
  let lastError = null;

  // ======================= capture =======================

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || !e.data[INJECT_TAG]) return;
    const msg = e.data;
    if (msg.type === 'ms-url') {
      msByUrl.set(msg.url, msg.msId);
    } else if (msg.type === 'sb-new') {
      sbs.set(msg.sbId, { msId: msg.msId, mime: msg.mime, chunks: [], size: 0 });
      trimRawStore();
    } else if (msg.type === 'sb-data') {
      const sb = sbs.get(msg.sbId);
      if (!sb) return;
      sb.chunks.push({ bytes: msg.bytes, tso: msg.tso });
      sb.size += msg.bytes.byteLength;
      if (msg.sbId === activeId) sendData(msg.bytes, msg.tso);
    }
  });

  function trimRawStore() {
    let total = 0;
    for (const sb of sbs.values()) total += sb.size;
    for (const [id, sb] of sbs) {
      if (total <= MAX_RAW_BYTES || sbs.size <= 1) break;
      if (id === activeId) continue;
      total -= sb.size;
      sbs.delete(id);
    }
  }

  function isWebm(sb) {
    return /^audio\/webm/i.test(sb.mime);
  }

  function findActiveSb() {
    if (!video) return null;
    const msId = msByUrl.get(video.src);
    if (msId == null) return null;
    let best = null;
    for (const [id, sb] of sbs) if (sb.msId === msId && (best == null || id > best)) best = id;
    return best;
  }

  // Loudness of the separated vocals (dB per 50 ms frame, NaN = not analysed),
  // shared with lyrics.js (same isolated world) to time lyrics to the singing.
  const VOCAL_FRAME_SEC = 0.05;
  const vocals = { frameSec: VOCAL_FRAME_SEC, env: new Float32Array(0), version: 0, videoId: null };
  globalThis.KaraokeVocals = vocals;

  function recordVocalEnvelope(start, [L, R], sampleRate) {
    const end = start + L.length / sampleRate;
    const f0 = Math.ceil(start / VOCAL_FRAME_SEC);
    const f1 = Math.floor(end / VOCAL_FRAME_SEC);
    if (f1 > vocals.env.length) {
      const grown = new Float32Array(Math.max(f1, vocals.env.length * 2)).fill(NaN);
      grown.set(vocals.env);
      vocals.env = grown;
    }
    for (let f = f0; f < f1; f++) {
      const a = Math.round((f * VOCAL_FRAME_SEC - start) * sampleRate);
      const b = Math.min(L.length, Math.round(((f + 1) * VOCAL_FRAME_SEC - start) * sampleRate));
      let sum = 0;
      for (let i = a; i < b; i++) {
        const m = (L[i] + R[i]) / 2;
        sum += m * m;
      }
      vocals.env[f] = 10 * Math.log10(sum / Math.max(1, b - a) + 1e-10);
    }
    vocals.videoId = new URLSearchParams(location.search).get('v');
    vocals.version++;
  }

  function switchStream(id) {
    activeId = id;
    blocks.clear();
    stopStems();
    vocals.env = new Float32Array(0);
    vocals.videoId = null;
    vocals.version++;
    lastPlayheadSent = -1;
    if (port) replayActive();
  }

  function replayActive() {
    port.postMessage({ type: 'reset', streamId: activeId });
    const sb = sbs.get(activeId);
    if (!sb || !isWebm(sb)) return;
    for (const c of sb.chunks) sendData(c.bytes, c.tso);
  }

  function sendData(bytes, tso) {
    if (!port || !isOn()) return;
    const sb = sbs.get(activeId);
    if (!sb || !isWebm(sb)) return;
    const copy = bytes.slice(0);
    port.postMessage({ type: 'data', streamId: activeId, bytes: copy, tso }, [copy]);
  }

  // ======================= engine =======================

  function ensureEngine() {
    if (engineFrame) return;
    const frame = (engineFrame = document.createElement('iframe'));
    frame.src = chrome.runtime.getURL('src/engine/engine.html');
    frame.style.display = 'none';
    frame.setAttribute('aria-hidden', 'true');
    frame.addEventListener('load', () => {
      if (frame !== engineFrame) return; // removed before it loaded
      const channel = new MessageChannel();
      frame.contentWindow.postMessage({ type: 'karaoke-port' }, new URL(frame.src).origin, [channel.port2]);
      port = channel.port1;
      port.onmessage = onEngineMessage;
      sendConfig();
      replayActive();
    });
    document.documentElement.appendChild(frame);
  }

  // A background tab with a paused video shouldn't hold ~1 GB of models on the
  // GPU (several YouTube tabs would starve each other): it goes dormant, which
  // stops the engine (see manageEngine) until the tab is used again.
  const DORMANT_AFTER_MS = 30000;
  let idleSince = 0;
  let dormant = false;

  function updateDormant() {
    const idle = document.hidden && (!video || video.paused);
    if (!idle) idleSince = 0;
    else if (!idleSince) idleSince = performance.now();
    const next = !!idleSince && performance.now() - idleSince > DORMANT_AFTER_MS;
    if (next !== dormant) {
      dormant = next;
      log(dormant ? 'tab idle in background' : 'tab active again');
      sendConfig();
    }
  }

  // The engine frame holds the models (up to ~1.2 GB). Removing the frame is
  // the reliable way to free them, so drop it when it's been unneeded for a
  // while; it's recreated (and the buffered audio replayed) on demand.
  const ENGINE_IDLE_MS = 30000;
  let engineUnneededSince = 0;
  let lastEngineRestart = 0;

  function destroyEngine(reason) {
    if (!engineFrame) return;
    log(`stopping AI engine (${reason})`);
    engineFrame.remove();
    engineFrame = null;
    port = null;
    engine = { phase: 'idle' };
  }

  function manageEngine() {
    const needed = isOn() && !dormant;
    if (needed) {
      engineUnneededSince = 0;
      ensureEngine();
      // Recover from a lost GPU device by starting over (at most once a minute).
      if (engine.deviceLost && performance.now() - lastEngineRestart > 60000) {
        lastEngineRestart = performance.now();
        destroyEngine('GPU device lost');
        ensureEngine();
      }
      return;
    }
    if (!engineUnneededSince) engineUnneededSince = performance.now();
    else if (performance.now() - engineUnneededSince > ENGINE_IDLE_MS) destroyEngine(dormant ? 'tab idle in background' : 'nothing to remove');
  }

  function sendConfig() {
    port?.postMessage({
      type: 'config',
      enabled: isOn() && !dormant,
      hold: settings.hold,
      configId,
      remove: {
        vocals: settings.removeVocals,
        guitar: settings.removeGuitar,
        drums: settings.removeDrums,
        bass: settings.removeBass,
      },
    });
  }

  function onEngineMessage({ data: msg }) {
    if (msg.type === 'status') {
      engine = msg;
    } else if (msg.type === 'block') {
      if (msg.streamId !== activeId || msg.configId !== configId) return;
      realtime = msg.realtime;
      blockSec = msg.gen / msg.sampleRate;
      lastBlockAt = performance.now();
      blocks.set(msg.k, {
        k: msg.k,
        start: msg.start,
        duration: msg.inst[0].length / msg.sampleRate,
        sampleRate: msg.sampleRate,
        inst: msg.inst,
        voc: msg.voc,
        bufs: null,
      });
      recordVocalEnvelope(msg.start, msg.voc, msg.sampleRate);
      tick();
    }
    updateUi();
  }

  // ======================= audio =======================

  function findVideo() {
    return document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video');
  }

  // Creates/resumes the AudioContext. Chrome only lets it start after the user
  // has interacted with the page, so before that we don't create it at all
  // (creating it early just logs an autoplay warning).
  function ensureContext() {
    if (!ctx) {
      if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
      ctx = new AudioContext({ latencyHint: 'playback' });
    }
    if (ctx.state !== 'running') ctx.resume().catch(() => {});
    return ctx;
  }

  function waitForGesture() {
    if (needsGesture) return;
    needsGesture = true;
    const onGesture = () => {
      document.removeEventListener('pointerdown', onGesture, true);
      document.removeEventListener('keydown', onGesture, true);
      needsGesture = false;
      ensureContext();
      setTimeout(tick, 50);
    };
    document.addEventListener('pointerdown', onGesture, true);
    document.addEventListener('keydown', onGesture, true);
  }

  // Routing a <video> into a suspended context would silence it, so only
  // build the graph once the context is actually running.
  function ensureGraph(v) {
    if (!ensureContext() || ctx.state !== 'running') {
      waitForGesture();
      return null;
    }
    if (!stemBus) {
      stemBus = new GainNode(ctx, { gain: 0 });
      instGain = new GainNode(ctx, { gain: 1 });
      vocGain = new GainNode(ctx, { gain: 0 });
      master = new GainNode(ctx);
      instGain.connect(stemBus);
      vocGain.connect(stemBus);
      stemBus.connect(master);
      master.connect(ctx.destination);
    }
    let g = graphs.get(v);
    if (!g) {
      try {
        const source = ctx.createMediaElementSource(v);
        const orig = new GainNode(ctx, { gain: 1 });
        source.connect(orig);
        orig.connect(master);
        g = { orig };
        graphs.set(v, g);
        lastError = null;
      } catch (err) {
        // e.g. another extension already captured this element
        lastError = String(err?.message || err);
        return null;
      }
    }
    return g;
  }

  // ======================= key change =======================

  function loadPitch() {
    if (pitchNode || pitchLoading || pitchError) return;
    pitchLoading = true;
    ctx.audioWorklet
      .addModule(chrome.runtime.getURL('src/audio/pitch-worklet.js'))
      .then(() => {
        const node = new AudioWorkletNode(ctx, 'karaoke-pitch', {
          outputChannelCount: [2],
          channelCount: 2,
          channelCountMode: 'explicit',
        });
        node.port.onmessage = ({ data }) => {
          if (data.latency != null) pitchLatency = data.latency;
        };
        node.connect(ctx.destination);
        pitchNode = node;
        pitchRatio = 1;
        tick();
      })
      .catch((err) => {
        pitchError = String(err?.message || err);
        log('key change unavailable:', pitchError);
      })
      .finally(() => (pitchLoading = false));
  }

  // Routes everything through the shifter only while the key is changed, so
  // the default path stays untouched (no added delay or processing).
  function updatePitch() {
    if (!master) return;
    if (settings.pitch) loadPitch();
    if (!pitchNode) return;
    const ratio = 2 ** (settings.pitch / 12);
    if (ratio !== pitchRatio) {
      pitchRatio = ratio;
      pitchNode.port.postMessage({ ratio });
    }
    const want = !!settings.pitch;
    if (want === pitchRouted) return;
    if (want) pitchNode.port.postMessage({ reset: true });
    master.disconnect();
    master.connect(want ? pitchNode : ctx.destination);
    pitchRouted = want;
    log(want ? `key ${settings.pitch > 0 ? '+' : ''}${settings.pitch}` : 'key back to original');
    stopStems(); // the audio delay changed: reschedule the stems for it
  }

  // How far ahead of the picture audio must enter the graph to be heard in sync.
  // The original audio can't be fed early (it comes from the <video> itself), so
  // it stays pitchLatency late (~40 ms); it's muted wherever the stems play.
  function audioLead() {
    return pitchRouted ? pitchLatency : 0;
  }

  function buffersFor(b) {
    if (!b.bufs) {
      const mk = ([L, R]) => {
        const buf = ctx.createBuffer(2, L.length, b.sampleRate);
        buf.copyToChannel(L, 0);
        buf.copyToChannel(R, 1);
        return buf;
      };
      b.bufs = { inst: mk(b.inst), voc: mk(b.voc) };
    }
    return b.bufs;
  }

  function schedule(b, when, offset) {
    const { inst, voc } = buffersFor(b);
    const srcs = [
      [inst, instGain],
      [voc, vocGain],
    ].map(([buf, dest]) => {
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.connect(dest);
      s.start(when, offset);
      return s;
    });
    chain.push({ k: b.k, srcs, ctxStart: when, mediaStart: b.start + offset, ctxEnd: when + b.duration - offset });
  }

  function stopStems() {
    for (const c of chain) {
      for (const s of c.srcs) {
        try {
          s.stop();
        } catch {}
      }
    }
    chain = [];
  }

  function setMix(on, g) {
    if (on !== stemsOn) log(on ? 'stems ON' : 'stems OFF', `t=${video.currentTime.toFixed(2)}s`);
    stemsOn = on;
    const now = ctx.currentTime;
    const vol = video.muted ? 0 : video.volume;
    g.orig.gain.setTargetAtTime(on ? 0 : 1, now, 0.015);
    stemBus.gain.setTargetAtTime(on ? vol : 0, now, 0.015);
    vocGain.gain.setTargetAtTime(settings.removeVocals ? 1 - settings.strength : 0, now, 0.02);
  }

  function blockAt(t) {
    const b = blocks.get(Math.floor(t / blockSec));
    return b && t >= b.start && t < b.start + b.duration ? b : null;
  }

  function log(...args) {
    console.debug('[YouTube Karaoke]', ...args);
  }

  // Keeps the scheduled stems aligned with video.currentTime. Returns whether
  // separated audio is (or is about to be) playing at t.
  function syncStems(t) {
    const now = ctx.currentTime;
    t += audioLead();
    chain = chain.filter((c) => c.ctxEnd > now);
    const head = chain[0];
    const drift = head ? head.mediaStart + (now - head.ctxStart) - t : NaN;

    if (!head || Math.abs(drift) > DRIFT_SEC) {
      stopStems();
      const lead = 0.03;
      const b = blockAt(t + lead);
      if (!b) {
        const k = Math.floor((t + lead) / blockSec);
        if (k !== lastMissingBlock) log(`no separated block at ${t.toFixed(2)}s -> original audio`);
        lastMissingBlock = k;
        return false;
      }
      lastMissingBlock = -1;
      log(head ? `resync at ${t.toFixed(2)}s (drift ${(drift * 1000).toFixed(0)} ms)` : `start stems at ${t.toFixed(2)}s (block ${b.k})`);
      schedule(b, now + lead, t + lead - b.start);
    }

    // Queue the next block back-to-back so block seams need no tick.
    const last = chain[chain.length - 1];
    if (last.ctxEnd - now < 2) {
      const next = blocks.get(last.k + 1);
      if (next) schedule(next, last.ctxEnd, 0);
    }
    return true;
  }

  // ======================= hold (pause until AI is ready) =======================

  function holdAllowed() {
    return (
      isOn() &&
      settings.hold &&
      !holdOverride &&
      engine.phase === 'ready' &&
      activeId != null &&
      isWebm(sbs.get(activeId) || {}) &&
      video.playbackRate === 1 &&
      !document.querySelector('#movie_player.ad-showing')
    );
  }

  // Seconds of separated audio ready back to back from t.
  function readyAhead(t) {
    let end = t;
    for (let k = Math.floor(t / blockSec); blocks.has(k); k++) {
      const b = blocks.get(k);
      end = b.start + b.duration;
    }
    return end - t;
  }

  // Resume only with enough audio buffered that we won't have to stop again
  // right away: a slower machine waits longer once instead of stuttering.
  function readyToResume(t) {
    if (!blockAt(t)) return false;
    const remaining = video.duration - t - 0.1;
    const need = realtime == null || realtime >= 1.5 ? blockSec : realtime >= 1 ? 15 : 40;
    return readyAhead(t) >= Math.min(need, remaining);
  }

  function updateHold(t) {
    if (heldByUs) {
      // Give up only if the AI stopped making progress (e.g. no audio arrives).
      const giveUp = performance.now() - Math.max(holdSince, lastBlockAt) > HOLD_GIVE_UP_SEC * 1000;
      if (!holdAllowed() || giveUp || readyToResume(t)) {
        log(`resume at ${t.toFixed(1)}s after ${((performance.now() - holdSince) / 1000).toFixed(1)}s, ${readyAhead(t).toFixed(1)}s ready${giveUp ? ' (gave up)' : ''}`);
        heldByUs = false;
        if (giveUp) holdOverride = true;
        resumingByUs = true;
        video.play().catch(() => {}).finally(() => (resumingByUs = false));
      }
      return;
    }
    if (!video.paused && !video.seeking && holdAllowed() && !blockAt(t)) {
      heldByUs = true;
      holdSince = performance.now();
      log(`hold at ${t.toFixed(1)}s: separated audio not ready (AI ${realtime ? realtime.toFixed(2) + 'x realtime' : 'starting'})`);
      video.pause();
    }
  }

  // ======================= main loop =======================

  function attachVideo(v) {
    if (video === v) return;
    video = v;
    heldByUs = false;
    holdOverride = false;
    const kick = () => tick();
    for (const ev of ['play', 'pause', 'seeking', 'seeked', 'ratechange', 'volumechange', 'waiting', 'playing']) {
      v.addEventListener(ev, kick);
    }
    v.addEventListener('play', () => {
      // The user pressed play while we were holding: respect it.
      if (heldByUs && !resumingByUs) {
        heldByUs = false;
        holdOverride = true;
      }
    });
    v.addEventListener('seeking', () => {
      holdOverride = false;
    });
  }

  function tick() {
    ensureButtons();
    const v = findVideo();
    if (v) attachVideo(v);
    if (!video) return updateUi();

    updateDormant();
    manageEngine();
    const sbId = findActiveSb();
    if (sbId !== activeId) switchStream(sbId);

    const t = video.currentTime;
    if (port && isOn() && Math.abs(t - lastPlayheadSent) > 0.25) {
      lastPlayheadSent = t;
      port.postMessage({ type: 'playhead', t, duration: video.duration });
    }

    if (!isOn()) {
      // A key change still needs the video routed through our graph.
      const g = settings.pitch ? ensureGraph(video) : ctx && graphs.get(video);
      if (g) {
        updatePitch();
        stopStems();
        setMix(false, g);
      }
      return updateUi();
    }

    const g = ensureGraph(video);
    if (!g) return updateUi();
    updatePitch();

    updateHold(t);
    const playing = !video.paused && !video.seeking && !video.ended && video.playbackRate === 1;
    const on = playing && syncStems(t);
    if (!on) stopStems();
    setMix(on, g);

    // Free separated audio we've left behind.
    const evicted = [];
    for (const [k, b] of blocks) {
      if (b.start + b.duration < t - KEEP_BEHIND_SEC) {
        blocks.delete(k);
        evicted.push(k);
      }
    }
    if (evicted.length) port?.postMessage({ type: 'evicted', ks: evicted });

    updateUi();
  }

  // ======================= status & UI =======================

  function currentStatus() {
    if (!isOn()) return { state: 'off' };
    if (engine.phase === 'error') return { state: 'error', error: engine.error };
    if (engine.phase === 'downloading') return { state: 'downloading', progress: engine.progress || 0 };
    if (engine.phase !== 'ready') return { state: 'initializing' };
    if (needsGesture) return { state: 'needs-gesture' };
    if (lastError) return { state: 'error', error: lastError };
    if (!video) return { state: 'no-video' };
    const sb = sbs.get(activeId);
    if (!sb) return { state: 'no-stream' };
    if (!isWebm(sb)) return { state: 'unsupported', error: sb.mime };
    if (heldByUs) return { state: 'holding' };
    if (stemsOn) return { state: 'active' };
    return { state: 'processing' };
  }

  const buttons = new Map(); // settings key -> button
  let badge = null;
  // YouTube enforces Trusted Types, so build icons with DOM APIs, not innerHTML.
  function svg(tag, attrs, children = []) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  // 24px outline icons with a slash shown while that stem is removed. Modern
  // ("delhi") player icons are 24px and padded by YouTube; the classic player
  // scales a 36px box, so the same drawing is centered in one.
  const STROKE = { stroke: 'white', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  const DOT = { fill: 'white' };
  const ICONS = {
    removeVocals: () => [
      svg('rect', { x: '9', y: '2', width: '6', height: '12', rx: '3', ...STROKE }),
      svg('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v4', ...STROKE }),
    ],
    removeGuitar: () => [
      svg('path', { d: 'M12 9c-2.1 0-3.6 1.3-3.6 3 0 .9.4 1.4.4 2 0 .7-1.8 1.3-1.8 3.4 0 2.5 2.3 4.6 5 4.6s5-2.1 5-4.6c0-2.1-1.8-2.7-1.8-3.4 0-.6.4-1.1.4-2 0-1.7-1.5-3-3.6-3z', ...STROKE }),
      svg('path', { d: 'M12 9V2M10.5 2h3M10 18h4', ...STROKE }),
    ],
    removeDrums: () => [
      svg('ellipse', { cx: '12', cy: '12', rx: '8', ry: '3', ...STROKE }),
      svg('path', { d: 'M4 12v5c0 1.7 3.6 3 8 3s8-1.3 8-3v-5M8.5 9.5L5 3.5M15.5 9.5L19 3.5', ...STROKE }),
    ],
    removeBass: () => [
      // bass clef
      svg('path', { d: 'M5 9a5 5 0 0 1 10 0c0 4.5-4 8.5-10 11', ...STROKE }),
      svg('circle', { cx: '6', cy: '9', r: '1.8', ...DOT }),
      svg('circle', { cx: '19', cy: '7', r: '1.3', ...DOT }),
      svg('circle', { cx: '19', cy: '12', r: '1.3', ...DOT }),
    ],
  };

  function stemIcon(key, modern) {
    const size = modern
      ? { width: '24', height: '24', viewBox: '0 0 24 24' }
      : { width: '100%', height: '100%', viewBox: '-6 -6 36 36' };
    return svg('svg', { fill: 'none', 'aria-hidden': 'true', ...size }, [
      ...ICONS[key](),
      svg('path', { class: 'karaoke-slash', d: 'M3 3l18 18', ...STROKE }),
    ]);
  }

  const STEM_LABELS = { removeVocals: 'ตัดเสียงร้อง', removeGuitar: 'ตัดกีตาร์', removeDrums: 'ตัดกลอง', removeBass: 'ตัดเบส' };

  function injectStyle() {
    if (document.getElementById('karaoke-style')) return;
    const style = document.createElement('style');
    style.id = 'karaoke-style';
    style.textContent = `
      .karaoke-btn { opacity: .9; }
      .karaoke-btn[data-state="off"] .karaoke-slash { display: none; }
      .karaoke-btn[data-state="busy"] svg { animation: karaoke-pulse 1s ease-in-out infinite; }
      @keyframes karaoke-pulse { 50% { opacity: .35; } }
      .karaoke-badge {
        position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 60;
        padding: 6px 12px; border-radius: 16px; background: rgba(0,0,0,.75); color: #fff;
        font: 500 13px/1.3 "YouTube Sans", Roboto, sans-serif; pointer-events: none;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureButtons() {
    const player = document.getElementById('movie_player');
    const controls = player?.querySelector('.ytp-right-controls');
    if (!controls) return;
    if (buttons.size && [...buttons.values()].every((b) => controls.contains(b))) return;
    injectStyle();
    for (const b of buttons.values()) b.remove();
    buttons.clear();
    const modern = controls.querySelector('.ytp-subtitles-button svg')?.getAttribute('viewBox') === '0 0 24 24';
    // Stem buttons go before the lyrics button (if any) and the CC button.
    const anchor = controls.querySelector('.karaoke-lyrics-btn') || controls.querySelector('.ytp-subtitles-button');
    for (const key of STEM_KEYS) {
      const btn = document.createElement('button');
      btn.className = 'ytp-button karaoke-btn';
      btn.dataset.stem = key;
      btn.append(stemIcon(key, modern));
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!settings[key]) ensureContext(); // a click is a user gesture: unlock audio now
        chrome.storage.local.set({ [key]: !settings[key] });
      });
      if (anchor) anchor.parentNode.insertBefore(btn, anchor);
      else controls.append(btn);
      buttons.set(key, btn);
    }
    updateUi();
  }

  const LABELS = {
    off: 'ไม่ได้ตัด',
    downloading: 'กำลังดาวน์โหลดโมเดล AI',
    initializing: 'กำลังเตรียมโมเดล AI',
    'needs-gesture': 'คลิกที่วิดีโอเพื่อเริ่ม',
    holding: 'รอ AI ตัดเสียง',
    processing: 'AI กำลังตัดเสียง',
    active: 'กำลังตัด',
    'no-video': 'ไม่พบวิดีโอ',
    'no-stream': 'รอรับเสียงจากวิดีโอ',
    unsupported: 'รูปแบบเสียงนี้ยังไม่รองรับ',
    error: 'เกิดข้อผิดพลาด',
  };

  function updateUi() {
    const s = currentStatus();
    const busy = !['off', 'active', 'error', 'unsupported', 'no-stream'].includes(s.state);
    for (const [key, btn] of buttons) {
      const removed = !!settings[key];
      btn.dataset.state = !removed ? 'off' : busy ? 'busy' : 'on';
      const label = `${STEM_LABELS[key]}: ${removed ? LABELS[s.state] + (s.error ? ` (${s.error})` : '') : LABELS.off}`;
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.setAttribute('aria-pressed', String(removed));
    }
    const player = document.getElementById('movie_player');
    const showBadge = s.state === 'holding' || s.state === 'downloading';
    if (showBadge && player) {
      if (!badge || !player.contains(badge)) {
        badge = document.createElement('div');
        badge.className = 'karaoke-badge';
        player.appendChild(badge);
      }
      const what = engine.model === 'demucs' ? 'โมเดลแยกเครื่องดนตรี' : 'โมเดลตัดเสียงร้อง';
      badge.textContent =
        s.state === 'downloading'
          ? `🎤 กำลังดาวน์โหลด${what} ${Math.round(s.progress * 100)}%`
          : '🎤 รอ AI ตัดเสียงสักครู่…';
    } else if (badge) {
      badge.remove();
      badge = null;
    }
  }

  // ======================= settings & messaging =======================

  // wasOn: audio is only forwarded to the engine while on, so turning on
  // replays what YouTube has buffered; switching stems while on doesn't need to.
  function applySettings(wasOn = false) {
    if (isOn()) {
      ensureEngine();
      if (port && !wasOn) replayActive();
    } else if (heldByUs) {
      heldByUs = false;
      video?.play().catch(() => {});
    }
    sendConfig();
    tick();
  }

  chrome.storage.local.get(null, (stored) => {
    // v0.3 had a single "enabled" switch, which meant removing vocals.
    if ('enabled' in stored && !('removeVocals' in stored)) {
      stored.removeVocals = !!stored.enabled;
      chrome.storage.local.set({ removeVocals: stored.removeVocals });
      chrome.storage.local.remove('enabled');
    }
    settings = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (key in stored) settings[key] = stored[key];
    applySettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const prevEnabled = isOn();
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue ?? DEFAULTS[key];
    }
    if (STEM_KEYS.some((k) => k in changes)) {
      // A different stem selection: earlier blocks no longer apply.
      configId++;
      blocks.clear();
      stopStems();
    }
    if (isOn() !== prevEnabled || 'hold' in changes || STEM_KEYS.some((k) => k in changes)) applySettings(prevEnabled);
    else tick();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'karaoke:status') {
      sendResponse({ ...currentStatus(), backend: engine.backend, models: engine.models || [], realtime, pitchError, pitchNeedsGesture: !!settings.pitch && !pitchRouted && needsGesture });
    }
  });

  document.addEventListener('yt-navigate-finish', () => tick());
  document.addEventListener('visibilitychange', () => tick());
  setInterval(tick, TICK_MS);
})();
