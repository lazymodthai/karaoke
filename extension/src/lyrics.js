// YouTube Karaoke — lyrics overlay (content script, isolated world).
//
// Finds time-synced lyrics for the current video and draws them over the player
// karaoke-style: two alternating rows, the sung part wiped in color.
// Sources, in order: the video's own caption track in the sung language,
// LRCLIB synced lyrics, then YouTube auto-captions.

(() => {
  const L = globalThis.KaraokeLyrics;
  const DEFAULTS = { lyrics: false, lyricsOffset: 0, lyricsLang: 'th' };
  const INJECT_TAG = '__karaokeInject';
  const MIN_LINES = 3;
  const SHOW_BEFORE_SEC = 4; // show upcoming lines this early
  const GAP_HIDE_SEC = 6; // clear the screen in instrumental gaps longer than this

  let settings = { ...DEFAULTS };
  let state = { videoId: null, phase: 'off', lines: [], source: null, label: null };
  let loadToken = 0;

  // ======================= talking to inject.js =======================

  const captionCache = new Map(); // `${videoId}|${lang}|${kind}` -> body
  const captionWaiters = new Set();
  let infoWaiter = null;

  const baseLang = (l) => (l || '').split('-')[0].toLowerCase();

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.[INJECT_TAG]) return;
    const msg = e.data;
    if (msg.type === 'timedtext') {
      captionCache.set(`${msg.videoId}|${baseLang(msg.lang)}|${msg.kind}`, msg.body);
      for (const w of captionWaiters) w();
    } else if (msg.type === 'video-info') {
      infoWaiter?.(msg.info);
    }
  });

  const command = (cmd, extra) => window.postMessage({ __karaokeCmd: true, cmd, ...extra }, location.origin);

  function currentVideoId() {
    return new URLSearchParams(location.search).get('v');
  }

  // The player response lags behind SPA navigation, so poll until it matches.
  async function getVideoInfo(videoId) {
    for (let i = 0; i < 15; i++) {
      const info = await new Promise((resolve) => {
        infoWaiter = resolve;
        command('video-info');
        setTimeout(() => resolve(null), 500);
      });
      infoWaiter = null;
      if (info?.videoId === videoId) return info;
      await new Promise((r) => setTimeout(r, 300));
    }
    return null;
  }

  function getCaptions(videoId, lang, kind, timeoutMs = 8000) {
    const key = `${videoId}|${baseLang(lang)}|${kind}`;
    if (captionCache.has(key)) return Promise.resolve(captionCache.get(key));
    return new Promise((resolve) => {
      const check = () => {
        if (!captionCache.has(key)) return;
        captionWaiters.delete(check);
        resolve(captionCache.get(key));
      };
      captionWaiters.add(check);
      setTimeout(() => {
        captionWaiters.delete(check);
        resolve(null);
      }, timeoutMs);
      command('load-captions', { lang, kind });
    });
  }

  // srv3/legacy XML -> json3-shaped events, so one parser handles both.
  function xmlToJson3(xml) {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const events = [];
    for (const p of doc.querySelectorAll('p')) {
      const t = Number(p.getAttribute('t'));
      const segs = [...p.querySelectorAll('s')].map((s) => ({ utf8: s.textContent, tOffsetMs: Number(s.getAttribute('t') || 0) }));
      events.push({ tStartMs: t, dDurationMs: Number(p.getAttribute('d') || 0), segs: segs.length ? segs : [{ utf8: p.textContent }] });
    }
    for (const n of doc.querySelectorAll('text')) {
      events.push({
        tStartMs: Number(n.getAttribute('start')) * 1000,
        dDurationMs: Number(n.getAttribute('dur') || 0) * 1000,
        segs: [{ utf8: n.textContent }],
      });
    }
    return { events };
  }

  function parseCaptions(body) {
    if (!body) return [];
    try {
      return L.parseJson3(body.trim().startsWith('{') ? body : xmlToJson3(body));
    } catch (err) {
      console.warn('[YouTube Karaoke] caption parse failed', err);
      return [];
    }
  }

  async function searchLrclib(info) {
    const { artist, track } = L.parseTitle(info.title, info.author);
    const enc = encodeURIComponent;
    const queries = [
      `track_name=${enc(track)}&artist_name=${enc(artist)}`,
      `track_name=${enc(artist)}&artist_name=${enc(track)}`, // "Song - Artist" titles
      `q=${enc(`${artist} ${track}`)}`,
    ];
    for (const q of queries) {
      try {
        const res = await fetch(`https://lrclib.net/api/search?${q}`);
        if (!res.ok) continue;
        const results = await res.json();
        const hit =
          L.pickLrclib(results, { artist, track, duration: info.duration }) ||
          L.pickLrclib(results, { artist: track, track: artist, duration: info.duration });
        if (hit) return { lines: L.parseLrc(hit.syncedLyrics), label: `${hit.artistName} - ${hit.trackName}` };
      } catch (err) {
        console.warn('[YouTube Karaoke] LRCLIB request failed', err);
      }
    }
    return null;
  }

  // ======================= loading =======================

  async function load() {
    const token = ++loadToken;
    const videoId = currentVideoId();
    state = { videoId, phase: 'loading', lines: [], source: null, label: null };
    resetRows();
    updateButton();
    const stale = () => token !== loadToken;

    const info = videoId && (await getVideoInfo(videoId));
    if (stale()) return;
    let found = null;
    if (info) {
      const track = L.pickCaptionTrack(info.tracks, info.title, settings.lyricsLang);
      if (track) {
        const lines = parseCaptions(await getCaptions(videoId, track.lang, ''));
        if (lines.length >= MIN_LINES) found = { lines, source: 'cc' };
      }
      const asrTracks = info.tracks.filter((t) => t.kind === 'asr');
      const asr = asrTracks.find((t) => baseLang(t.lang) === settings.lyricsLang) || asrTracks[0];
      let asrLines = null;
      const getAsr = async () => (asrLines ??= parseCaptions(await getCaptions(videoId, asr.lang, 'asr')));
      if (!found && !stale()) {
        const hit = await searchLrclib(info);
        if (hit?.lines.length >= MIN_LINES) {
          found = { ...hit, source: 'lrclib' };
          // LRCLIB is timed for the album version; retime it to this video's
          // auto-captions (correct clock, per-word timing) when they match.
          if (asr && !stale()) {
            const aligned = L.alignToCaptions(hit.lines, await getAsr());
            if (aligned) found = { ...found, lines: aligned, synced: true };
            const shifts = aligned ? aligned.map((l, i) => l.start - hit.lines[i].start) : [];
            console.debug(
              '[YouTube Karaoke] lyrics alignment:',
              aligned
                ? `${aligned.filter((l) => l.joined).length}/${aligned.length} lines matched captions, shift ${Math.min(...shifts).toFixed(1)}..${Math.max(...shifts).toFixed(1)} s`
                : 'captions did not match, using album timing',
            );
          }
        }
      }
      if (!found && asr && !stale()) {
        const lines = await getAsr();
        if (lines.length >= MIN_LINES) found = { lines, source: 'asr' };
      }
    }
    if (stale()) return;

    state = found
      ? {
          videoId,
          phase: 'ready',
          lines: found.lines,
          source: found.source,
          label: found.label || null,
          synced: found.synced ? 'captions' : null,
          // Album-timed lyrics with nothing to align them to yet: follow the
          // separated vocals as the AI analyses the song (see syncToVocals).
          album: found.source === 'lrclib' && !found.synced ? found.lines : null,
        }
      : { videoId, phase: 'not-found', lines: [], source: null, label: null };
    vocalsVersion = -1;
    updateButton();
    toast(
      found
        ? `🎤 เนื้อเพลงจาก${{ cc: 'คำบรรยายของคลิป', lrclib: ' LRCLIB', asr: 'คำบรรยายอัตโนมัติ (อาจไม่ตรงทุกคำ)' }[found.source]}${
            found.synced ? ' · จัดจังหวะตามคลิปแล้ว' : found.source === 'lrclib' ? ' · เปิดตัดเสียงร้องเพื่อจัดจังหวะอัตโนมัติ' : ''
          }`
        : '🎤 ไม่พบเนื้อเพลงสำหรับคลิปนี้',
    );
  }

  // ======================= overlay =======================

  let overlay = null;
  const rows = [];
  let raf = 0;

  function player() {
    return document.getElementById('movie_player');
  }

  function video() {
    return player()?.querySelector('video') || null;
  }

  function injectStyle() {
    if (document.getElementById('karaoke-lyrics-style')) return;
    const style = document.createElement('style');
    style.id = 'karaoke-lyrics-style';
    style.textContent = `
      .karaoke-hide-cc .ytp-caption-window-container { display: none !important; }
      .karaoke-lyrics {
        position: absolute; left: 5%; right: 5%; bottom: 14%; z-index: 40; pointer-events: none;
        font: 700 24px/1.4 "Sukhumvit Set", "Noto Sans Thai", "YouTube Sans", Roboto, sans-serif;
      }
      .karaoke-lyrics .kl-row { display: flex; margin: .1em 0; }
      .karaoke-lyrics .kl-row[data-r="0"] { justify-content: flex-start; }
      .karaoke-lyrics .kl-row[data-r="1"] { justify-content: flex-end; }
      .karaoke-lyrics .kl-line { position: relative; white-space: nowrap; }
      .karaoke-lyrics .kl-base, .karaoke-lyrics .kl-fill {
        text-shadow: 0 0 4px #000, 2px 2px 0 #000, -2px 2px 0 #000, 2px -2px 0 #000, -2px -2px 0 #000;
      }
      .karaoke-lyrics .kl-base { color: #fff; }
      .karaoke-lyrics .kl-fill { position: absolute; left: 0; top: 0; color: #3ec7ff; clip-path: inset(0 100% 0 0); }
      .karaoke-lyrics-btn[data-state="busy"] svg { animation: karaoke-lyrics-pulse 1s ease-in-out infinite; }
      @keyframes karaoke-lyrics-pulse { 50% { opacity: .35; } }
      .karaoke-lyrics-btn[data-state="on"] .kl-icon-off, .karaoke-lyrics-btn:not([data-state="on"]) .kl-icon-on { display: none; }
      .karaoke-toast {
        position: absolute; top: 12px; left: 50%; transform: translateX(-50%); z-index: 61;
        padding: 6px 12px; border-radius: 16px; background: rgba(0,0,0,.75); color: #fff;
        font: 500 13px/1.3 "YouTube Sans", Roboto, sans-serif; pointer-events: none;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function ensureOverlay() {
    const p = player();
    if (!p) return null;
    if (overlay && p.contains(overlay)) return overlay;
    injectStyle();
    overlay = document.createElement('div');
    overlay.className = 'karaoke-lyrics';
    rows.length = 0;
    for (let r = 0; r < 2; r++) {
      const row = document.createElement('div');
      row.className = 'kl-row';
      row.dataset.r = String(r);
      const line = document.createElement('div');
      line.className = 'kl-line';
      const base = document.createElement('span');
      base.className = 'kl-base';
      const fill = document.createElement('span');
      fill.className = 'kl-fill';
      fill.setAttribute('aria-hidden', 'true');
      line.append(base, fill);
      row.append(line);
      overlay.append(row);
      rows.push({ el: row, line, base, fill, idx: -1, metrics: null, fontPx: 0 });
    }
    p.appendChild(overlay);
    return overlay;
  }

  function resetRows() {
    for (const row of rows) setRow(row, -1);
    if (overlay) overlay.hidden = true;
  }

  function fillWords(target, words, joined) {
    target.replaceChildren();
    words.forEach((w, i) => {
      if (i > 0 && !joined) target.append(' ');
      const span = document.createElement('span');
      span.textContent = w.text;
      target.append(span);
    });
  }

  function setRow(row, idx) {
    if (row.idx === idx) return;
    row.idx = idx;
    row.metrics = null;
    const line = state.lines[idx];
    row.el.style.visibility = line ? 'visible' : 'hidden';
    if (!line) return;
    fillWords(row.base, line.words, line.joined);
    fillWords(row.fill, line.words, line.joined);
  }

  // Shrinks a too-long line to fit, then caches word positions for the wipe.
  function measure(row, fontPx) {
    if (row.metrics && row.fontPx === fontPx) return row.metrics;
    row.fontPx = fontPx;
    row.line.style.fontSize = '';
    const avail = overlay.clientWidth;
    if (row.base.offsetWidth > avail && avail > 0) {
      row.line.style.fontSize = `${Math.floor((fontPx * avail) / row.base.offsetWidth)}px`;
    }
    const width = row.base.offsetWidth;
    const words = [...row.base.children].map((s) => [s.offsetLeft, s.offsetWidth]);
    row.metrics = { width, words };
    return row.metrics;
  }

  function frame() {
    raf = requestAnimationFrame(frame);
    const v = video();
    const p = player();
    if (!settings.lyrics || state.phase !== 'ready' || !v || !p || !ensureOverlay()) {
      if (overlay) overlay.hidden = true;
      return;
    }
    const lines = state.lines;
    const t = v.currentTime + settings.lyricsOffset;
    const first = p.classList.contains('ad-showing') ? null : L.visiblePair(lines, t, SHOW_BEFORE_SEC, GAP_HIDE_SEC);
    overlay.hidden = first == null;
    if (first == null) return;

    const fontPx = Math.max(16, Math.round(p.clientHeight * 0.055));
    overlay.style.fontSize = `${fontPx}px`;
    for (const idx of [first, first + 1]) {
      const row = rows[idx % 2];
      setRow(row, idx < lines.length ? idx : -1);
    }
    for (const row of rows) {
      const line = lines[row.idx];
      if (!line) continue;
      const m = measure(row, fontPx);
      const prog = L.progressAt(line, t);
      let px = 0;
      if (t >= line.end) px = m.width;
      else if (prog.word >= 0) {
        const [left, width] = m.words[prog.word];
        px = left + prog.frac * width;
      }
      row.fill.style.clipPath = `inset(-0.5em ${Math.max(0, m.width - px)}px -0.5em -0.5em)`;
    }
  }

  function startRender() {
    if (!raf) raf = requestAnimationFrame(frame);
  }

  function stopRender() {
    cancelAnimationFrame(raf);
    raf = 0;
    if (overlay) overlay.hidden = true;
  }

  let toastEl = null;
  let toastTimer = 0;
  function toast(text) {
    const p = player();
    if (!p || !settings.lyrics) return;
    injectStyle();
    toastEl?.remove();
    toastEl = document.createElement('div');
    toastEl.className = 'karaoke-toast';
    toastEl.textContent = text;
    p.appendChild(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl?.remove(), 3000);
  }

  // ======================= button =======================

  let btn = null;

  function svg(tag, attrs, children = []) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    el.append(...children);
    return el;
  }

  // Off: outlined "lyrics sheet"; on: filled, like YouTube's CC button.
  function lyricsIcon(modern) {
    const size = modern
      ? { width: '24', height: '24', viewBox: '0 0 24 24' }
      : { width: '100%', height: '100%', viewBox: '-6 -6 36 36' };
    const glyph = (color) => [
      svg('path', { d: 'M6 9h7M6 13h5', stroke: color, 'stroke-width': '2', 'stroke-linecap': 'round' }),
      svg('path', { d: 'M17.5 15.5V8.5h1.75', stroke: color, 'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
      svg('circle', { cx: '16', cy: '15.5', r: '1.75', fill: color }),
    ];
    return svg('svg', { fill: 'none', 'aria-hidden': 'true', ...size }, [
      svg('g', { class: 'kl-icon-off' }, [
        svg('rect', { x: '2', y: '4', width: '20', height: '16', rx: '3', stroke: 'white', 'stroke-width': '2' }),
        ...glyph('white'),
      ]),
      svg('g', { class: 'kl-icon-on' }, [svg('rect', { x: '1', y: '3', width: '22', height: '18', rx: '4', fill: 'white' }), ...glyph('black')]),
    ]);
  }

  function ensureButton() {
    const controls = player()?.querySelector('.ytp-right-controls');
    if (!controls) return;
    if (btn && controls.contains(btn)) return;
    injectStyle();
    btn = document.createElement('button');
    btn.className = 'ytp-button karaoke-lyrics-btn';
    const modern = controls.querySelector('.ytp-subtitles-button svg')?.getAttribute('viewBox') === '0 0 24 24';
    btn.append(lyricsIcon(modern));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.storage.local.set({ lyrics: !settings.lyrics });
    });
    const anchor = controls.querySelector('.ytp-subtitles-button');
    if (anchor) anchor.parentNode.insertBefore(btn, anchor);
    else controls.prepend(btn);
    updateButton();
  }

  const LABELS = {
    off: 'เนื้อเพลง: ปิด',
    loading: 'เนื้อเพลง: กำลังค้นหา',
    ready: 'เนื้อเพลง: เปิด',
    'not-found': 'เนื้อเพลง: ไม่พบสำหรับคลิปนี้',
  };

  function updateButton() {
    if (!btn) return;
    const phase = settings.lyrics ? state.phase : 'off';
    btn.dataset.state = phase === 'off' ? 'off' : phase === 'loading' ? 'busy' : 'on';
    const label = LABELS[phase] || LABELS.off;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('aria-pressed', String(settings.lyrics));
  }

  // ======================= timing from the vocal track =======================

  let vocalsVersion = -1;
  let lastVocalSync = 0;

  // Re-aligns album-timed lyrics as more of the song's vocals get analysed.
  function syncToVocals() {
    const v = globalThis.KaraokeVocals;
    if (!state.album || !v || v.videoId !== state.videoId || v.version === vocalsVersion) return;
    if (performance.now() - lastVocalSync < 3000) return;
    lastVocalSync = performance.now();
    vocalsVersion = v.version;
    const aligned = L.alignToVocals(state.album, v.env, v.frameSec);
    if (!aligned) return;
    const first = state.synced !== 'vocals';
    state.lines = aligned;
    state.synced = 'vocals';
    for (const row of rows) row.idx = -1; // re-render with the new timing
    const offsets = aligned.map((l) => l.offset);
    console.debug(
      '[YouTube Karaoke] lyrics aligned to vocals:',
      `offset ${Math.min(...offsets).toFixed(1)}..${Math.max(...offsets).toFixed(1)} s`,
    );
    if (first) toast('🎤 จัดจังหวะเนื้อเพลงตามเสียงร้องแล้ว');
  }

  // ======================= wiring =======================

  function sync() {
    ensureButton();
    if (!settings.lyrics) {
      stopRender();
      updateButton();
      return;
    }
    const id = currentVideoId();
    if (id !== state.videoId) {
      if (id) load();
      else {
        state = { videoId: null, phase: 'not-found', lines: [], source: null, label: null };
        updateButton();
      }
    }
    syncToVocals();
    startRender();
  }

  chrome.storage.local.get(DEFAULTS, (stored) => {
    settings = { ...DEFAULTS, ...stored };
    sync();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const [key, { newValue }] of Object.entries(changes)) {
      if (key in DEFAULTS) settings[key] = newValue;
    }
    if ('lyricsLang' in changes && settings.lyrics) state.videoId = null; // look up again
    if ('lyrics' in changes || 'lyricsLang' in changes) {
      if (settings.lyrics && state.phase === 'ready' && state.videoId === currentVideoId()) {
        toast('🎤 แสดงเนื้อเพลง');
      } else if (settings.lyrics) {
        state.videoId = null; // force a fresh lookup
      } else {
        loadToken++;
        state = { videoId: null, phase: 'off', lines: [], source: null, label: null };
      }
      sync();
    }
  });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'karaoke:lyrics-status') {
      sendResponse({ phase: settings.lyrics ? state.phase : 'off', source: state.source, label: state.label, synced: state.synced, lines: state.lines.length });
    }
  });

  document.addEventListener('yt-navigate-finish', () => sync());
  setInterval(sync, 500);
})();
