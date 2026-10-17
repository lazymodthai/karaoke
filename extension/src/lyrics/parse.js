// Lyrics parsing helpers shared by the lyrics content script (and unit tests).
// A "line" is { start, end, text, words: [{ text, start, end }] } in seconds.
// Lines with only line-level timing get a single word spanning the line.

(function (root) {
  const MAX_LINE_SEC = 10;

  function cleanText(s) {
    return s
      .replace(/\[[^\]]*\]/g, ' ') // [Music], [เพลง], [Applause]
      .replace(/[♪♫♬♩]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Sorts, clamps line/word ends to the next line, and drops empty lines.
  function finalize(lines) {
    const out = lines.filter((l) => l.text && Number.isFinite(l.start)).sort((a, b) => a.start - b.start);
    for (let i = 0; i < out.length; i++) {
      const line = out[i];
      const next = out[i + 1];
      let end = Number.isFinite(line.end) ? line.end : Infinity;
      if (next) end = Math.min(end, next.start);
      end = Math.min(end, line.start + MAX_LINE_SEC);
      line.end = Math.max(end, line.start + 0.2);
      if (!line.words || !line.words.length) line.words = [{ text: line.text, start: line.start, end: line.end }];
      const words = line.words;
      for (let j = 0; j < words.length; j++) {
        const w = words[j];
        w.start = Math.max(line.start, Math.min(w.start, line.end));
        const wEnd = j + 1 < words.length ? words[j + 1].start : line.end;
        w.end = Math.max(w.start + 0.05, Math.min(Number.isFinite(w.end) ? w.end : wEnd, wEnd));
      }
    }
    return out;
  }

  // YouTube timedtext "json3" (manual captions: one text per event, may hold
  // several rows separated by "\n"; auto captions: word segments with tOffsetMs).
  function parseJson3(text) {
    const data = typeof text === 'string' ? JSON.parse(text) : text;
    const lines = [];
    for (const ev of data.events || []) {
      if (!ev.segs) continue;
      const start = ev.tStartMs / 1000;
      const end = (ev.tStartMs + (ev.dDurationMs || 0)) / 1000;
      const timedWords = ev.segs.some((s) => 'tOffsetMs' in s) || ev.segs.length > 1;
      if (timedWords) {
        const words = ev.segs
          .map((s) => ({ text: cleanText(s.utf8 || ''), start: start + (s.tOffsetMs || 0) / 1000 }))
          .filter((w) => w.text);
        if (!words.length) continue;
        lines.push({ start: words[0].start, end, text: words.map((w) => w.text).join(' '), words });
        continue;
      }
      // Manual captions: split multi-row events, sharing time by text length.
      const rows = (ev.segs[0].utf8 || '').split('\n').map(cleanText).filter(Boolean);
      const total = rows.reduce((n, r) => n + r.length, 0);
      let t = start;
      for (const row of rows) {
        const dur = rows.length > 1 && end > start ? ((end - start) * row.length) / total : end - start;
        lines.push({ start: t, end: t + dur, text: row });
        t += dur;
      }
    }
    return finalize(lines);
  }

  const TAG = /\[(\d+):(\d+(?:\.\d+)?)\]/g;
  const WORD_TAG = /<(\d+):(\d+(?:\.\d+)?)>/g;
  const toSec = (m, s) => Number(m) * 60 + Number(s);

  // LRC with optional "enhanced" per-word <mm:ss.xx> tags.
  function parseLrc(text) {
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
      const stamps = [...raw.matchAll(TAG)].map((m) => toSec(m[1], m[2]));
      if (!stamps.length) continue;
      const body = raw.replace(TAG, '');
      const wordMatches = [...body.matchAll(WORD_TAG)];
      for (const start of stamps) {
        let words;
        if (wordMatches.length) {
          words = [];
          const parts = body.split(WORD_TAG); // [pre, m, s, text, m, s, text, ...]
          for (let i = 1; i + 2 < parts.length; i += 3) {
            const w = cleanText(parts[i + 2]);
            if (w) words.push({ text: w, start: start + (toSec(parts[i], parts[i + 1]) - stamps[0]) });
          }
        }
        const plain = cleanText(body.replace(WORD_TAG, ''));
        lines.push({ start, end: Infinity, text: plain, words });
      }
    }
    return finalize(lines);
  }

  // "Artist - Song (Official MV) [4K] | Album" -> { artist, track }
  function parseTitle(title, author = '') {
    let t = title
      .replace(/[([【「『][^)\]】」』]*[)\]】」』]/g, ' ')
      .split(/\s*[|｜]/)[0]
      .replace(/\s(feat\.?|ft\.?)\s.*$/i, '')
      .replace(/\b(official|music video|lyric video|lyrics?|mv|m\/v|audio|visualizer)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const channel = author.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').replace(/\bofficial\b/gi, '').trim();
    const dash = t.split(/\s[-–—]\s|\s?[:：]\s/);
    // Collaborations: search by the first artist ("A x B", "A & B", "A, B").
    const lead = (s) => s.split(/\s+(?:x|×|&)\s+|\s*,\s*/i)[0].trim();
    if (dash.length >= 2) return { artist: lead(dash[0]), track: dash.slice(1).join(' - ').trim() };
    return { artist: channel, track: t };
  }

  function similarity(a, b) {
    const norm = (s) => (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
    const x = norm(a);
    const y = norm(b);
    if (!x || !y) return 0;
    if (x === y) return 1;
    if (x.includes(y) || y.includes(x)) return 0.8;
    return 0;
  }

  // Picks the best synced LRCLIB result for a video, or null.
  function pickLrclib(results, { artist, track, duration }) {
    let best = null;
    for (const r of results || []) {
      if (!r.syncedLyrics || r.instrumental) continue;
      const dDiff = Number.isFinite(duration) && r.duration ? Math.abs(r.duration - duration) : 0;
      if (dDiff > 60) continue; // music videos run long, but not by minutes
      const score = 2 * similarity(r.trackName, track) + similarity(r.artistName, artist) - dDiff / 30;
      if (similarity(r.trackName, track) === 0) continue;
      if (!best || score > best.score) best = { score, result: r };
    }
    return best ? best.result : null;
  }

  // Where the highlight is within a line at time t: { word, frac } (word -1 = none).
  function progressAt(line, t) {
    if (t < line.start) return { word: -1, frac: 0 };
    if (line.act) {
      const { frameSec, cum } = line.act;
      const f = Math.min(cum.length - 1, Math.floor((t - line.start) / frameSec));
      return { word: 0, frac: cum[f] / cum[cum.length - 1] };
    }
    const words = line.words;
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i];
      if (t >= w.start) return { word: i, frac: Math.min(1, (t - w.start) / (w.end - w.start)) };
    }
    return { word: -1, frac: 0 };
  }

  function currentLineIndex(lines, t) {
    let lo = 0;
    let hi = lines.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (lines[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  // Index of the first of the two lines to show at t, or null to hide.
  function visiblePair(lines, t, showBefore = 4, gapHide = 6) {
    const c = currentLineIndex(lines, t);
    if (c < 0) return lines[0].start - t <= showBefore ? 0 : null;
    const cur = lines[c];
    const next = lines[c + 1];
    if (!next) return t <= cur.end + 3 ? c : null;
    // Long instrumental gap: clear the screen until shortly before the next line.
    if (next.start - cur.end > gapHide && t > cur.end + 1 && next.start - t > showBefore) return null;
    return c;
  }

  // ---------- aligning lyrics to auto-captions ----------
  // Lyrics databases are timed for the album version; music videos add intros
  // and scenes. Auto-captions are timed to the actual video (per word) but
  // misheard. Aligning the two character sequences gives correct text with
  // video timing.

  // Characters compared during alignment: no spaces/punctuation, and Thai tone
  // marks dropped since speech recognition often gets them wrong.
  function matchChars(text) {
    const out = [];
    const chars = [...text.normalize('NFC').toLowerCase()];
    chars.forEach((c, pos) => {
      if (/[\s\p{P}\p{S}็-์ๆ]/u.test(c)) return;
      out.push({ c, pos });
    });
    return out;
  }

  const MATCH = 2;
  const MISMATCH = -1;
  const GAP_LYRIC = -1; // lyric char with no caption counterpart
  const GAP_CAPTION = -0.4; // caption char not in the lyrics (dialogue, noise)

  // Returns lyrics retimed to the captions' clock, or null if they don't match.
  function alignToCaptions(lyrics, captions) {
    const A = [];
    lyrics.forEach((line, li) => {
      for (const { c, pos } of matchChars(line.text)) A.push({ c, line: li, pos });
    });
    const B = [];
    captions.forEach((line) =>
      line.words.forEach((w) => {
        const cs = matchChars(w.text);
        cs.forEach(({ c }, k) => B.push({ c, t: w.start + ((w.end - w.start) * k) / cs.length, wStart: w.start, wEnd: w.end, word: B.length - k }));
      }),
    );
    const n = A.length;
    const m = B.length;
    if (n < 10 || m < 10) return null;

    // Semi-global alignment: captions may have unmatched text at both ends.
    const W = m + 1;
    const H = new Float32Array((n + 1) * W);
    const dir = new Uint8Array((n + 1) * W); // 1 diag, 2 up (skip lyric), 3 left (skip caption)
    for (let i = 1; i <= n; i++) {
      H[i * W] = i * GAP_LYRIC;
      dir[i * W] = 2;
    }
    for (let i = 1; i <= n; i++) {
      const ai = A[i - 1].c;
      for (let j = 1; j <= m; j++) {
        const diag = H[(i - 1) * W + j - 1] + (ai === B[j - 1].c ? MATCH : MISMATCH);
        const up = H[(i - 1) * W + j] + GAP_LYRIC;
        const left = H[i * W + j - 1] + GAP_CAPTION;
        let best = diag;
        let d = 1;
        if (up > best) {
          best = up;
          d = 2;
        }
        if (left > best) {
          best = left;
          d = 3;
        }
        H[i * W + j] = best;
        dir[i * W + j] = d;
      }
    }
    let j = 0;
    for (let k = 1; k <= m; k++) if (H[n * W + k] > H[n * W + j]) j = k;
    let i = n;
    const pairs = new Array(n).fill(-1); // lyric char -> caption char (exact matches only)
    while (i > 0 && j > 0) {
      const d = dir[i * W + j];
      if (d === 1) {
        if (A[i - 1].c === B[j - 1].c) pairs[i - 1] = j - 1;
        i--;
        j--;
      } else if (d === 2) i--;
      else j--;
    }

    // Per line: matched characters, in order.
    const perLine = lyrics.map(() => []);
    pairs.forEach((bj, ai) => {
      if (bj >= 0) perLine[A[ai].line].push({ pos: A[ai].pos, b: B[bj] });
    });
    const totals = lyrics.map(() => 0);
    for (const a of A) totals[a.line]++;

    // Anchor lines that matched well and keep the anchors increasing.
    const anchors = [];
    lyrics.forEach((_, li) => {
      const hits = perLine[li];
      if (hits.length < 3 || hits.length / totals[li] < 0.4) return;
      const start = hits[0].b.wStart;
      if (anchors.length && start <= anchors[anchors.length - 1].start) return;
      anchors.push({ li, start, end: Math.max(...hits.map((h) => h.b.wEnd)) });
    });
    if (anchors.length < Math.max(3, lyrics.length * 0.3)) return null;

    // Unanchored lines: map their original time between the nearest anchors.
    const mapTime = (t) => {
      let k = 0;
      while (k < anchors.length && lyrics[anchors[k].li].start <= t) k++;
      const a = anchors[Math.max(0, k - 1)];
      const b = anchors[Math.min(anchors.length - 1, k)];
      const ta = lyrics[a.li].start;
      const tb = lyrics[b.li].start;
      if (a === b || tb === ta) return a.start + (t - ta);
      return a.start + ((t - ta) * (b.start - a.start)) / (tb - ta);
    };
    const anchorOf = new Map(anchors.map((a) => [a.li, a]));

    const out = lyrics.map((line, li) => {
      const anchor = anchorOf.get(li);
      if (!anchor) {
        const start = mapTime(line.start);
        return { start, end: start + (line.end - line.start), text: line.text };
      }
      // Split the line where the matched caption word changes: each piece is
      // highlighted from the time that word was sung.
      const chars = [...line.text];
      const hits = perLine[li];
      const words = [];
      let from = 0;
      let prevWord = -1;
      for (const h of hits) {
        if (h.b.word === prevWord) continue;
        if (words.length) {
          words[words.length - 1].text = chars.slice(from, h.pos).join('');
          from = h.pos;
        }
        if (words.length && h.b.wStart <= words[words.length - 1].start) {
          prevWord = h.b.word;
          continue; // keep times increasing; merge into the previous piece
        }
        words.push({ text: '', start: h.b.wStart, end: h.b.wEnd });
        prevWord = h.b.word;
      }
      words[words.length - 1].text = chars.slice(from).join('');
      // Fold whitespace-only pieces into the previous piece so text is kept.
      const merged = [];
      for (const w of words) {
        if (!w.text.trim() && merged.length) merged[merged.length - 1].text += w.text;
        else merged.push(w);
      }
      // joined: pieces already carry their spacing; render without separators.
      return { start: anchor.start, end: anchor.end + 0.3, text: line.text, words: merged, joined: true };
    });
    return finalize(out);
  }

  // ---------- aligning lyrics to the separated vocal track ----------
  // When there are no auto-captions, use when singing is actually heard.
  // env: vocal-stem loudness in dB per frame (NaN = not analysed yet).
  // Each line gets an offset (video time - album time). Offsets stay constant
  // between lines unless the audio strongly suggests a jump (an inserted scene,
  // a cut chorus), found with a Viterbi pass over a grid of offsets.

  const OFFSET_STEP = 0.1;
  const DRIFT_BINS = 3; // cheap drift between consecutive lines: ±0.3 s
  const DRIFT_COST = 0.02; // per bin, so lines with no audio yet keep their offset
  const JUMP_COST = 0.8; // offset grows: a scene inserted into the song
  const CUT_COST = 1.6; // offset shrinks: part of the song cut, rarer in videos
  const MIN_LINE_GAP = 0.3;

  function alignToVocals(lines, env, frameSec, { minOffset = -20, maxOffset = 180 } = {}) {
    const n = env.length;
    const knownVals = [];
    for (let f = 0; f < n; f++) if (Number.isFinite(env[f])) knownVals.push(env[f]);
    if (knownVals.length * frameSec < 10 || lines.length < 3) return null;
    knownVals.sort((a, b) => a - b);
    const loud = knownVals[Math.floor(knownVals.length * 0.9)];
    const threshold = Math.max(-50, loud - 18);

    // Prefix sums of "singing" frames and analysed frames.
    const cumA = new Float64Array(n + 1);
    const cumK = new Float64Array(n + 1);
    for (let f = 0; f < n; f++) {
      const known = Number.isFinite(env[f]);
      cumK[f + 1] = cumK[f] + (known ? 1 : 0);
      cumA[f + 1] = cumA[f] + (known && env[f] > threshold ? 1 : 0);
    }
    const activity = (t0, t1) => {
      const f0 = Math.max(0, Math.min(n, Math.floor(t0 / frameSec)));
      const f1 = Math.max(0, Math.min(n, Math.ceil(t1 / frameSec)));
      const k = cumK[f1] - cumK[f0];
      if (f1 <= f0 || k < (f1 - f0) * 0.5) return null;
      return (cumA[f1] - cumA[f0]) / k;
    };
    // Singing should start right at the line and (usually) not just before it.
    const onset = (s) => {
      const head = activity(s, s + 0.5);
      const before = activity(s - 0.6, s - 0.05);
      return head == null ? null : head - (before ?? 0.5);
    };
    const score = (line, o) => {
      const s = line.start + o;
      const inside = activity(s, s + Math.min(line.end - line.start, 4));
      if (inside == null) return 0;
      return 0.5 * inside + 0.5 * (onset(s) ?? 0);
    };
    // Path score: relative to a random placement, so that a line with no audio
    // yet (score 0) isn't pulled back into the analysed part of the song.
    const baseline = 0.5 * (cumA[n] / Math.max(1, cumK[n]));
    const gain = (line, o) => {
      const s = line.start + o;
      return activity(s, s + Math.min(line.end - line.start, 4)) == null ? 0 : score(line, o) - baseline;
    };

    const S = Math.round((maxOffset - minOffset) / OFFSET_STEP) + 1;
    const offsetAt = (k) => minOffset + k * OFFSET_STEP;
    let prev = new Float32Array(S);
    for (let k = 0; k < S; k++) prev[k] = gain(lines[0], offsetAt(k)) - 0.001 * Math.abs(offsetAt(k));
    const back = [];
    const bestUpTo = new Int32Array(S); // argmax of prev[0..k]
    for (let i = 1; i < lines.length; i++) {
      for (let k = 0; k < S; k++) bestUpTo[k] = k > 0 && prev[bestUpTo[k - 1]] >= prev[k] ? bestUpTo[k - 1] : k;
      // Lines stay in order: the previous offset may exceed this one only by
      // the album gap between the two lines (less a short minimum gap).
      const slack = Math.floor((lines[i].start - lines[i - 1].start - MIN_LINE_GAP) / OFFSET_STEP);
      const cur = new Float32Array(S).fill(-Infinity);
      const ptr = new Int32Array(S);
      for (let k = 0; k < S; k++) {
        const limit = Math.min(S - 1, k + slack);
        if (limit < 0) continue;
        let from = -1;
        let base = -Infinity;
        for (let j = Math.max(0, k - DRIFT_BINS); j <= Math.min(limit, k + DRIFT_BINS); j++) {
          const v = prev[j] - DRIFT_COST * Math.abs(j - k);
          if (v > base) {
            from = j;
            base = v;
          }
        }
        const far = bestUpTo[limit];
        const jump = prev[far] - (far > k ? CUT_COST : JUMP_COST);
        if (jump > base) {
          from = far;
          base = jump;
        }
        cur[k] = base + gain(lines[i], offsetAt(k));
        ptr[k] = from;
      }
      back.push(ptr);
      prev = cur;
    }
    let k = 0;
    for (let j = 1; j < S; j++) if (prev[j] > prev[k]) k = j;
    const offsets = new Array(lines.length);
    for (let i = lines.length - 1; i >= 0; i--) {
      offsets[i] = offsetAt(k);
      if (i > 0) k = back[i - 1][k];
    }

    // Confidence: analysed lines should land on singing that starts there.
    let scored = 0;
    let total = 0;
    let onsets = 0;
    lines.forEach((line, i) => {
      const s = line.start + offsets[i];
      if (activity(s, s + Math.min(line.end - line.start, 4)) == null) return;
      scored++;
      total += score(line, offsets[i]);
      onsets += onset(s) ?? 0;
    });
    if (scored < 3 || total / scored < 0.35 || onsets / scored < 0.25) return null;

    const out = lines.map((line, i) => {
      const o = offsets[i];
      return {
        ...line,
        start: line.start + o,
        end: line.end + o,
        words: line.words.map((w) => ({ ...w, start: w.start + o, end: w.end + o })),
        offset: o,
      };
    });
    // Single-word lines: let the wipe advance only while singing is heard.
    for (const line of out) {
      if (line.words.length !== 1) continue;
      const f0 = Math.floor(line.start / frameSec);
      const f1 = Math.ceil(line.end / frameSec);
      if (f0 < 0 || f1 > n || cumK[f1] - cumK[f0] < f1 - f0) continue;
      const cum = new Float32Array(f1 - f0 + 1);
      for (let f = f0; f < f1; f++) cum[f - f0 + 1] = cum[f - f0] + (env[f] > threshold ? 1 : 0);
      if (cum[cum.length - 1] >= 2) line.act = { frameSec, cum };
    }
    return finalize(out);
  }

  // Which manual caption track to use as lyrics. `preferred` is the user's
  // lyrics language ('th', 'en', ... or 'auto' = whatever is sung). Translated
  // tracks are a trap: a Thai song often carries English captions, so when the
  // sung language is unknown we only take the preferred language.
  function pickCaptionTrack(tracks, title, preferred = 'th') {
    const base = (l) => (l || '').split('-')[0].toLowerCase();
    const manual = tracks.filter((t) => t.kind !== 'asr');
    if (preferred && preferred !== 'auto') {
      const hit = manual.find((t) => base(t.lang) === preferred);
      if (hit) return hit;
    }
    const spoken = spokenLanguage(tracks, title);
    if (spoken) return manual.find((t) => base(t.lang) === spoken) || null;
    if (preferred === 'auto') return manual.length === 1 ? manual[0] : null;
    return null;
  }

  // The language a video is sung in: the auto-caption language when present,
  // else a guess from the title's script.
  function spokenLanguage(tracks, title) {
    const asr = tracks.find((t) => t.kind === 'asr');
    if (asr) return asr.lang.split('-')[0];
    if (/[฀-๿]/.test(title)) return 'th';
    if (/[가-힯]/.test(title)) return 'ko';
    if (/[぀-ヿ]/.test(title)) return 'ja';
    if (/[一-鿿]/.test(title)) return 'zh';
    return null;
  }

  root.KaraokeLyrics = {
    parseJson3,
    parseLrc,
    parseTitle,
    pickLrclib,
    progressAt,
    visiblePair,
    alignToCaptions,
    alignToVocals,
    pickCaptionTrack,
    spokenLanguage,
    cleanText,
  };
})(globalThis);
