// YouTube Karaoke — content script (isolated world, document_start)
//
// 1. Receives the audio bytes captured by inject.js and forwards the stream that
//    belongs to the current <video> to the separation engine (hidden iframe).
// 2. Plays the separated instrumental (+ optional guide vocals) in sync with the
//    video and mutes the original audio wherever a separated block is ready.
// 3. Optionally pauses the video until the AI has caught up ("hold" mode).
// 4. Adds a karaoke toggle button to the YouTube player controls.

(() => {
  const DEFAULTS = { enabled: false, strength: 1, hold: true };
  const INJECT_TAG = '__karaokeInject';
  const SR = 44100;
  const GEN = 253440; // samples per separated block (must match engine/mdx.js)
  const BLOCK_SEC = GEN / SR;
  const TICK_MS = 200;
  const DRIFT_SEC = 0.08;
  const KEEP_BEHIND_SEC = 60;
  const MAX_RAW_BYTES = 64 << 20;
  const HOLD_GIVE_UP_SEC = 30;

  let settings = { ...DEFAULTS };

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
  let instGain = null;
  let vocGain = null;
  let chain = []; // scheduled blocks: { k, srcs, ctxStart, mediaStart, ctxEnd }
  const blocks = new Map(); // k -> { k, start, duration, inst, voc, bufs }
  let stemsOn = false;
  let lastMissingBlock = -1; // only log a missing block once

  // ---------- hold ----------
  let heldByUs = false;
  let holdSince = 0;
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

  function switchStream(id) {
    activeId = id;
    blocks.clear();
    stopStems();
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
    if (!port || !settings.enabled) return;
    const sb = sbs.get(activeId);
    if (!sb || !isWebm(sb)) return;
    const copy = bytes.slice(0);
    port.postMessage({ type: 'data', streamId: activeId, bytes: copy, tso }, [copy]);
  }

  // ======================= engine =======================

  function ensureEngine() {
    if (engineFrame) return;
    engineFrame = document.createElement('iframe');
    engineFrame.src = chrome.runtime.getURL('src/engine/engine.html');
    engineFrame.style.display = 'none';
    engineFrame.setAttribute('aria-hidden', 'true');
    engineFrame.addEventListener('load', () => {
      const channel = new MessageChannel();
      engineFrame.contentWindow.postMessage({ type: 'karaoke-port' }, new URL(engineFrame.src).origin, [channel.port2]);
      port = channel.port1;
      port.onmessage = onEngineMessage;
      sendConfig();
      replayActive();
    });
    document.documentElement.appendChild(engineFrame);
  }

  function sendConfig() {
    port?.postMessage({ type: 'config', enabled: settings.enabled, hold: settings.hold });
  }

  function onEngineMessage({ data: msg }) {
    if (msg.type === 'status') {
      engine = msg;
      if (msg.phase === 'error') lastError = msg.error;
    } else if (msg.type === 'block') {
      if (msg.streamId !== activeId) return;
      realtime = msg.realtime;
      blocks.set(msg.k, {
        k: msg.k,
        start: msg.start,
        duration: msg.inst[0].length / msg.sampleRate,
        sampleRate: msg.sampleRate,
        inst: msg.inst,
        voc: msg.voc,
        bufs: null,
      });
      tick();
    }
    updateUi();
  }

  // ======================= audio =======================

  function findVideo() {
    return document.querySelector('#movie_player video') || document.querySelector('video.html5-main-video');
  }

  // Must be called from a user gesture when possible (our button click).
  function ensureContext() {
    if (!ctx) ctx = new AudioContext({ latencyHint: 'playback' });
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
    ensureContext();
    if (ctx.state !== 'running') {
      waitForGesture();
      return null;
    }
    if (!stemBus) {
      stemBus = new GainNode(ctx, { gain: 0 });
      instGain = new GainNode(ctx, { gain: 1 });
      vocGain = new GainNode(ctx, { gain: 0 });
      instGain.connect(stemBus);
      vocGain.connect(stemBus);
      stemBus.connect(ctx.destination);
    }
    let g = graphs.get(v);
    if (!g) {
      try {
        const source = ctx.createMediaElementSource(v);
        const orig = new GainNode(ctx, { gain: 1 });
        source.connect(orig);
        orig.connect(ctx.destination);
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
    vocGain.gain.setTargetAtTime(1 - settings.strength, now, 0.02);
  }

  function blockAt(t) {
    const b = blocks.get(Math.floor(t / BLOCK_SEC));
    return b && t >= b.start && t < b.start + b.duration ? b : null;
  }

  function log(...args) {
    console.debug('[YouTube Karaoke]', ...args);
  }

  // Keeps the scheduled stems aligned with video.currentTime. Returns whether
  // separated audio is (or is about to be) playing at t.
  function syncStems(t) {
    const now = ctx.currentTime;
    chain = chain.filter((c) => c.ctxEnd > now);
    const head = chain[0];
    const drift = head ? head.mediaStart + (now - head.ctxStart) - t : NaN;

    if (!head || Math.abs(drift) > DRIFT_SEC) {
      stopStems();
      const lead = 0.03;
      const b = blockAt(t + lead);
      if (!b) {
        const k = Math.floor((t + lead) / BLOCK_SEC);
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
      settings.enabled &&
      settings.hold &&
      !holdOverride &&
      engine.phase === 'ready' &&
      activeId != null &&
      isWebm(sbs.get(activeId) || {}) &&
      video.playbackRate === 1 &&
      !document.querySelector('#movie_player.ad-showing')
    );
  }

  function readyToResume(t) {
    const b = blockAt(t);
    if (!b) return false;
    const nextStart = b.start + b.duration;
    const nextKnown = blocks.has(b.k + 1) || !(nextStart < video.duration - 0.1);
    return nextKnown || (realtime != null && realtime > 1.3);
  }

  function updateHold(t) {
    if (heldByUs) {
      const giveUp = performance.now() - holdSince > HOLD_GIVE_UP_SEC * 1000;
      if (!holdAllowed() || giveUp || readyToResume(t)) {
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
    ensureButton();
    const v = findVideo();
    if (v) attachVideo(v);
    if (!video) return updateUi();

    const sbId = findActiveSb();
    if (sbId !== activeId) switchStream(sbId);

    const t = video.currentTime;
    if (port && settings.enabled && Math.abs(t - lastPlayheadSent) > 0.25) {
      lastPlayheadSent = t;
      port.postMessage({ type: 'playhead', t, duration: video.duration });
    }

    if (!settings.enabled) {
      if (ctx && graphs.has(video)) {
        stopStems();
        setMix(false, graphs.get(video));
      }
      return updateUi();
    }

    const g = ensureGraph(video);
    if (!g) return updateUi();

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
    if (!settings.enabled) return { state: 'off' };
    if (lastError && engine.phase !== 'ready') return { state: 'error', error: lastError };
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

  let btn = null;
  let badge = null;
  // YouTube enforces Trusted Types, so build icons with DOM APIs, not innerHTML.
  function svg(tag, attrs, children = []) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  // Modern ("delhi") player icons are 24px outlines that YouTube pads itself;
  // the classic player uses 36px viewBoxes scaled to the button.
  function micIcon(modern) {
    if (modern) {
      const stroke = { stroke: 'white', 'stroke-width': '2', 'stroke-linecap': 'round' };
      return svg('svg', { fill: 'none', width: '24', height: '24', viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svg('rect', { x: '9', y: '2', width: '6', height: '12', rx: '3', ...stroke }),
        svg('path', { d: 'M5 11a7 7 0 0 0 14 0M12 18v4', ...stroke }),
        svg('path', { class: 'karaoke-slash', d: 'M3 3l18 18', ...stroke }),
      ]);
    }
    return svg('svg', { viewBox: '0 0 36 36', width: '100%', height: '100%', 'aria-hidden': 'true' }, [
      svg('path', {
        fill: '#fff',
        d: 'M18 9a3.5 3.5 0 0 0-3.5 3.5v5.5a3.5 3.5 0 0 0 7 0v-5.5A3.5 3.5 0 0 0 18 9zm-6.5 9h2a4.5 4.5 0 0 0 9 0h2a6.5 6.5 0 0 1-5.5 6.42V27h-2v-2.58A6.5 6.5 0 0 1 11.5 18z',
      }),
      svg('path', { class: 'karaoke-slash', d: 'M10 10l16 16', stroke: '#fff', 'stroke-width': '2', 'stroke-linecap': 'round' }),
    ]);
  }

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

  function ensureButton() {
    const player = document.getElementById('movie_player');
    const controls = player?.querySelector('.ytp-right-controls');
    if (!controls) return;
    if (btn && controls.contains(btn)) return;
    injectStyle();
    btn = document.createElement('button');
    btn.className = 'ytp-button karaoke-btn';
    const modern = controls.querySelector('.ytp-subtitles-button svg')?.getAttribute('viewBox') === '0 0 24 24';
    btn.append(micIcon(modern));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!settings.enabled) ensureContext(); // a click is a user gesture: unlock audio now
      chrome.storage.local.set({ enabled: !settings.enabled });
    });
    const anchor = controls.querySelector('.ytp-subtitles-button');
    if (anchor) anchor.parentNode.insertBefore(btn, anchor);
    else controls.prepend(btn);
    updateUi();
  }

  const LABELS = {
    off: 'คาราโอเกะ: ปิด',
    downloading: 'คาราโอเกะ: กำลังดาวน์โหลดโมเดล AI',
    initializing: 'คาราโอเกะ: กำลังเตรียมโมเดล AI',
    'needs-gesture': 'คาราโอเกะ: คลิกที่วิดีโอเพื่อเริ่ม',
    holding: 'คาราโอเกะ: รอ AI ตัดเสียง',
    processing: 'คาราโอเกะ: AI กำลังตัดเสียง',
    active: 'คาราโอเกะ: เปิด',
    'no-video': 'คาราโอเกะ: ไม่พบวิดีโอ',
    'no-stream': 'คาราโอเกะ: รอรับเสียงจากวิดีโอ',
    unsupported: 'คาราโอเกะ: รูปแบบเสียงนี้ยังไม่รองรับ',
    error: 'คาราโอเกะ: เกิดข้อผิดพลาด',
  };

  function updateUi() {
    const s = currentStatus();
    if (btn) {
      const busy = !['off', 'active', 'error', 'unsupported', 'no-stream'].includes(s.state);
      btn.dataset.state = s.state === 'off' ? 'off' : busy ? 'busy' : 'on';
      const label = LABELS[s.state] + (s.error ? ` (${s.error})` : '');
      btn.setAttribute('aria-label', label);
      btn.title = label;
      btn.setAttribute('aria-pressed', String(settings.enabled));
    }
    const player = document.getElementById('movie_player');
    const showBadge = s.state === 'holding' || s.state === 'downloading';
    if (showBadge && player) {
      if (!badge || !player.contains(badge)) {
        badge = document.createElement('div');
        badge.className = 'karaoke-badge';
        player.appendChild(badge);
      }
      badge.textContent =
        s.state === 'downloading'
          ? `🎤 กำลังดาวน์โหลดโมเดล AI ${Math.round(s.progress * 100)}%`
          : '🎤 รอ AI ตัดเสียงร้องสักครู่…';
    } else if (badge) {
      badge.remove();
      badge = null;
    }
  }

  // ======================= settings & messaging =======================

  function applySettings() {
    if (settings.enabled) {
      ensureEngine();
      if (port) replayActive();
    } else if (heldByUs) {
      heldByUs = false;
      video?.play().catch(() => {});
    }
    sendConfig();
    tick();
  }

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    applySettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const prevEnabled = settings.enabled;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue;
    }
    if (settings.enabled !== prevEnabled || 'hold' in changes) applySettings();
    else tick();
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'karaoke:status') {
      sendResponse({ ...currentStatus(), backend: engine.backend, realtime });
    }
  });

  document.addEventListener('yt-navigate-finish', () => tick());
  setInterval(tick, TICK_MS);
})();
