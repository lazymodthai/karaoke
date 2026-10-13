// Fixtures use invented lyrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../extension/src/lyrics/parse.js';

const L = globalThis.KaraokeLyrics;

test('json3 manual captions: rows split, annotations dropped, ends clamped', () => {
  const json = {
    events: [
      { tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: '[Music]' }] },
      { tStartMs: 5000, dDurationMs: 4000, segs: [{ utf8: '♪ Paper boats on a river ♪\nFloating where the lanterns go' }] },
      { tStartMs: 8000, dDurationMs: 3000, segs: [{ utf8: 'ฝนตกที่ปลายฟ้า' }] },
      { tStartMs: 12000 },
    ],
  };
  const lines = L.parseJson3(JSON.stringify(json));
  assert.deepEqual(lines.map((l) => l.text), ['Paper boats on a river', 'Floating where the lanterns go', 'ฝนตกที่ปลายฟ้า']);
  assert.equal(lines[0].start, 5);
  assert.ok(lines[1].start > 5 && lines[1].start < 9);
  assert.equal(lines[1].end, 8); // clamped to the next line's start
  assert.equal(lines[2].end, 11);
  assert.equal(lines[0].words.length, 1);
});

test('json3 auto captions keep word timing', () => {
  const json = {
    events: [
      { tStartMs: 1000, dDurationMs: 3000, segs: [{ utf8: 'hello' }, { utf8: ' little', tOffsetMs: 500 }, { utf8: ' star', tOffsetMs: 1200 }] },
      { tStartMs: 2000, aAppend: 1, segs: [{ utf8: '\n' }] },
    ],
  };
  const [line] = L.parseJson3(json);
  assert.equal(line.text, 'hello little star');
  assert.deepEqual(line.words.map((w) => [w.text, w.start]), [['hello', 1], ['little', 1.5], ['star', 2.2]]);
  assert.equal(line.words[2].end, 4);
});

test('LRC: repeated stamps, enhanced word tags, metadata ignored', () => {
  const lrc = [
    '[ar:Someone]',
    '[00:01.00]Morning comes too soon',
    '[00:04.50][01:00.00]Hold the light',
    '[00:08.00]<00:08.00>sing <00:08.60>with <00:09.10>me',
    '[00:12.00]',
  ].join('\n');
  const lines = L.parseLrc(lrc);
  assert.deepEqual(lines.map((l) => [l.start, l.text]), [
    [1, 'Morning comes too soon'],
    [4.5, 'Hold the light'],
    [8, 'sing with me'],
    [60, 'Hold the light'],
  ]);
  assert.equal(lines[0].end, 4.5);
  assert.deepEqual(lines[2].words.map((w) => w.start), [8, 8.6, 9.1]);
});

test('title parsing', () => {
  assert.deepEqual(L.parseTitle('Lunar Cats - Paper Boats (Official MV) [4K]'), { artist: 'Lunar Cats', track: 'Paper Boats' });
  assert.deepEqual(L.parseTitle('ฝนตกที่ปลายฟ้า - วงสมมติ | Official MV'), { artist: 'ฝนตกที่ปลายฟ้า', track: 'วงสมมติ' });
  assert.deepEqual(L.parseTitle('Paper Boats (Lyric Video)', 'Lunar Cats - Topic'), { artist: 'Lunar Cats', track: 'Paper Boats' });
  assert.deepEqual(L.parseTitle('เพลงสมมติ - Lunar Cats |Official MV|'), { artist: 'เพลงสมมติ', track: 'Lunar Cats' });
  assert.deepEqual(L.parseTitle('Paper Boats feat. Someone Else', 'LunarCatsVEVO'), { artist: 'LunarCats', track: 'Paper Boats' });
});

test('LRCLIB pick prefers matching name and close duration', () => {
  const results = [
    { trackName: 'Paper Boats', artistName: 'Lunar Cats', duration: 400, syncedLyrics: '[00:01.00]x' },
    { trackName: 'Paper Boats', artistName: 'Lunar Cats', duration: 212, syncedLyrics: '[00:01.00]x', id: 2 },
    { trackName: 'Paper Boats', artistName: 'Lunar Cats', duration: 210, syncedLyrics: null },
    { trackName: 'Other Song', artistName: 'Lunar Cats', duration: 213, syncedLyrics: '[00:01.00]x' },
  ];
  assert.equal(L.pickLrclib(results, { artist: 'Lunar Cats', track: 'Paper Boats', duration: 215 }).id, 2);
  assert.equal(L.pickLrclib(results.slice(2), { artist: 'Lunar Cats', track: 'Paper Boats', duration: 215 }), null);
});

test('progress and spoken language', () => {
  const line = { start: 1, end: 4, words: [{ start: 1, end: 2 }, { start: 2, end: 4 }] };
  assert.deepEqual(L.progressAt(line, 0.5), { word: -1, frac: 0 });
  assert.deepEqual(L.progressAt(line, 1.5), { word: 0, frac: 0.5 });
  assert.deepEqual(L.progressAt(line, 3), { word: 1, frac: 0.5 });
  assert.deepEqual(L.progressAt(line, 9), { word: 1, frac: 1 });
  assert.equal(L.spokenLanguage([{ lang: 'en' }, { lang: 'th', kind: 'asr' }], 'x'), 'th');
  assert.equal(L.spokenLanguage([], 'เพลงทดสอบ'), 'th');
  assert.equal(L.spokenLanguage([], 'Plain title'), null);
});

test('visible line pair: lead-in, singing, instrumental gap, outro', () => {
  const lines = [
    { start: 10, end: 13 },
    { start: 13, end: 16 },
    { start: 40, end: 43 }, // after a long instrumental break
  ];
  const vp = (t) => L.visiblePair(lines, t, 4, 6);
  assert.equal(vp(0), null); // intro
  assert.equal(vp(7), 0); // lead-in shows lines 0+1
  assert.equal(vp(14), 1); // singing line 1, preview line 2
  assert.equal(vp(16.5), 1); // just finished: still visible
  assert.equal(vp(25), null); // instrumental gap
  assert.equal(vp(37), 1); // lead-in to line 2
  assert.equal(vp(44), 2);
  assert.equal(vp(50), null); // outro
});

test('align album-timed lyrics to video auto-captions (intro, dialogue, misheard words)', () => {
  // Invented lyrics, timed for an "album version".
  const lyricTexts = [
    'แสงไฟริมทางพาฉันกลับมา',
    'ทุกคืนที่เดินผ่านตรงนี้',
    'เสียงลมยังคงกระซิบชื่อเธอ',
    'ทะเลยังรอคอยใครสักคน',
    'วันพรุ่งนี้จะยังมีเรา',
    'แม้ฟ้าจะเปลี่ยนไปเท่าไร',
  ];
  const lyrics = lyricTexts.map((text, i) => ({ start: 20 + i * 5, end: 24 + i * 5, text }));

  // Video timeline: 40 s intro (+40), and a 30 s dialogue scene before line 3 (+70).
  const shift = (i) => (i < 3 ? 40 : 70);
  const misheard = { 1: 'ทุกคืนที่เดินผ่านตรงนี่', 4: 'วันพุ่งนี้จะยังมีเลา' };
  const words = [];
  lyricTexts.forEach((text, i) => {
    const t0 = 20 + i * 5 + shift(i) + 0.3;
    const heard = misheard[i] || text;
    const parts = heard.match(/.{1,4}/gu); // ASR "words"
    parts.forEach((p, k) => words.push({ text: p, start: t0 + k * 0.6, end: t0 + k * 0.6 + 0.6 }));
    if (i === 2) {
      // dialogue inside the music video
      for (let k = 0; k < 12; k++) words.push({ text: 'คุยกันก่อนนะ', start: 80 + k * 2, end: 81 + k * 2 });
    }
  });
  words.sort((a, b) => a.start - b.start);
  const captions = [{ start: words[0].start, end: words.at(-1).end, text: '', words }];

  const aligned = L.alignToCaptions(lyrics, captions);
  assert.ok(aligned, 'alignment should succeed');
  assert.deepEqual(aligned.map((l) => l.text), lyricTexts);
  aligned.forEach((l, i) => {
    const expected = 20 + i * 5 + shift(i) + 0.3;
    assert.ok(Math.abs(l.start - expected) < 0.05, `line ${i}: ${l.start} vs ${expected}`);
    assert.equal(l.words.map((w) => w.text).join(''), lyricTexts[i]); // text preserved exactly
    assert.ok(l.words.length > 1, 'word-level timing from captions');
    for (let k = 1; k < l.words.length; k++) assert.ok(l.words[k].start > l.words[k - 1].start);
  });
});

test('alignment refuses unrelated captions', () => {
  const lyrics = ['ดอกไม้บานในฤดูฝน', 'นกบินกลับรังยามเย็น', 'ลมหนาวพัดผ่านทุ่งนา'].map((text, i) => ({ start: i * 4, end: i * 4 + 3, text }));
  const words = 'zzzz qqqq xxxx yyyy wwww vvvv'.split(' ').map((text, k) => ({ text, start: k, end: k + 1 }));
  assert.equal(L.alignToCaptions(lyrics, [{ start: 0, end: 6, text: '', words }]), null);
});
