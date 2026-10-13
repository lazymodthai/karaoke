// Runs in the page's MAIN world at document_start, before YouTube's player.
// Copies the audio bytes YouTube appends to Media Source Extensions so the
// separation engine can process audio *before* it is played.

(() => {
  const TAG = '__karaokeInject';
  const post = (msg, transfer) => window.postMessage({ [TAG]: true, ...msg }, location.origin, transfer);

  // Prefer WebM/Opus audio, which the engine can parse; refuse MP4/AAC audio
  // while an Opus alternative exists.
  const isTypeSupported = MediaSource.isTypeSupported.bind(MediaSource);
  MediaSource.isTypeSupported = function (type) {
    if (/^audio\/mp4/i.test(type) && isTypeSupported('audio/webm; codecs="opus"')) return false;
    return isTypeSupported(type);
  };

  let nextId = 1;
  const msIds = new WeakMap();
  const sbInfo = new WeakMap();

  const msId = (ms) => {
    if (!msIds.has(ms)) msIds.set(ms, nextId++);
    return msIds.get(ms);
  };

  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function (obj) {
    const url = createObjectURL.call(URL, obj);
    if (obj instanceof MediaSource) post({ type: 'ms-url', msId: msId(obj), url });
    return url;
  };

  const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
  MediaSource.prototype.addSourceBuffer = function (mime) {
    const sb = addSourceBuffer.call(this, mime);
    if (/^audio\//i.test(mime)) {
      const info = { sbId: nextId++, msId: msId(this) };
      sbInfo.set(sb, info);
      post({ type: 'sb-new', ...info, mime });
    }
    return sb;
  };

  const appendBuffer = SourceBuffer.prototype.appendBuffer;
  SourceBuffer.prototype.appendBuffer = function (data) {
    const info = sbInfo.get(this);
    if (info) {
      try {
        const view = ArrayBuffer.isView(data) ? data : new Uint8Array(data);
        const copy = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
        post({ type: 'sb-data', sbId: info.sbId, tso: this.timestampOffset, bytes: copy.buffer }, [copy.buffer]);
      } catch (err) {
        console.warn('[YouTube Karaoke] capture failed', err);
      }
    }
    return appendBuffer.call(this, data);
  };

  // ---------- lyrics: YouTube caption tracks ----------
  // Caption URLs need a proof-of-origin token only the player can mint, so we
  // ask the player to load a track and read the response it receives.

  const isTimedtext = (url) => /\/api\/timedtext/.test(url);
  const postTimedtext = (url, body) => {
    try {
      const q = new URL(url, location.href).searchParams;
      post({ type: 'timedtext', videoId: q.get('v'), lang: q.get('lang'), kind: q.get('kind') || '', fmt: q.get('fmt'), body });
    } catch {}
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (_method, url) {
    if (isTimedtext(String(url))) {
      this.addEventListener('load', () => {
        if (typeof this.responseText === 'string' && this.responseText) postTimedtext(String(url), this.responseText);
      });
    }
    return xhrOpen.apply(this, arguments);
  };

  const fetchOrig = window.fetch;
  window.fetch = function (input) {
    const promise = fetchOrig.apply(this, arguments);
    const url = typeof input === 'string' ? input : input?.url;
    if (url && isTimedtext(url)) {
      promise.then((res) => res.clone().text().then((body) => body && postTimedtext(url, body))).catch(() => {});
    }
    return promise;
  };

  const STICKY_KEYS = ['yt-player-caption-sticky-language', 'yt-player-caption-persistence'];
  const player = () => document.getElementById('movie_player');

  function videoInfo() {
    const pr = player()?.getPlayerResponse?.();
    if (!pr?.videoDetails) return null;
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    return {
      videoId: pr.videoDetails.videoId,
      title: pr.videoDetails.title,
      author: pr.videoDetails.author,
      duration: Number(pr.videoDetails.lengthSeconds),
      tracks: tracks.map((t) => ({ lang: t.languageCode, kind: t.kind || '' })),
    };
  }

  // Turns a caption track on just long enough for the player to fetch it,
  // hiding YouTube's own caption overlay and restoring the user's CC state.
  function loadCaptions(lang, kind) {
    const p = player();
    if (!p?.setOption) return;
    const saved = STICKY_KEYS.map((k) => [k, localStorage.getItem(k)]);
    const prevTrack = p.getOption?.('captions', 'track') || {};
    document.documentElement.classList.add('karaoke-hide-cc');
    p.loadModule?.('captions');
    p.setOption('captions', 'track', kind ? { languageCode: lang, kind } : { languageCode: lang });
    setTimeout(() => {
      p.setOption('captions', 'track', prevTrack.languageCode ? prevTrack : {});
      for (const [k, v] of saved) {
        if (v == null) localStorage.removeItem(k);
        else localStorage.setItem(k, v);
      }
      document.documentElement.classList.remove('karaoke-hide-cc');
    }, 2500);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__karaokeCmd) return;
    const { cmd } = e.data;
    if (cmd === 'video-info') post({ type: 'video-info', info: videoInfo() });
    else if (cmd === 'load-captions') loadCaptions(e.data.lang, e.data.kind);
  });
})();
