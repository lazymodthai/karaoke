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
})();
