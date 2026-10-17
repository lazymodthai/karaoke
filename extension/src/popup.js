const DEFAULTS = {
  removeVocals: false,
  removeGuitar: false,
  removeDrums: false,
  removeBass: false,
  strength: 1,
  hold: true,
  lyrics: false,
  lyricsOffset: 0,
  lyricsLang: 'th',
  pitch: 0,
};
const PITCH_RANGE = 6;

const $ = (id) => document.getElementById(id);
const els = {
  stems: [...document.querySelectorAll('.stem')],
  reset: $('reset'),
  guide: $('guide'),
  guideOut: $('guideOut'),
  hold: $('hold'),
  status: $('status'),
  detail: $('detail'),
  lyrics: $('lyrics'),
  lyricsOffset: $('lyricsOffset'),
  lyricsLang: $('lyricsLang'),
  offsetOut: $('offsetOut'),
  lyricsStatus: $('lyricsStatus'),
  keyDown: $('keyDown'),
  keyUp: $('keyUp'),
  keyOut: $('keyOut'),
  keyHint: $('keyHint'),
};

const LYRICS_SOURCE = { cc: 'คำบรรยายของคลิป', lrclib: 'LRCLIB', asr: 'คำบรรยายอัตโนมัติ' };
const LYRICS_PHASE = { off: '', loading: 'กำลังค้นหาเนื้อเพลง…', 'not-found': 'ไม่พบเนื้อเพลงสำหรับคลิปนี้' };

const STATUS_TEXT = {
  off: ['ปิดอยู่', ''],
  downloading: ['กำลังดาวน์โหลดโมเดล AI', 'warn'],
  initializing: ['กำลังเตรียมโมเดล AI', 'warn'],
  'needs-gesture': ['คลิกที่หน้า YouTube หนึ่งครั้งเพื่อเริ่มทำงาน', 'warn'],
  'no-video': ['ไม่พบวิดีโอในหน้านี้', 'warn'],
  'no-stream': ['ยังไม่ได้รับเสียงจากวิดีโอ ถ้าค้างอยู่ให้รีโหลดหน้า', 'warn'],
  unsupported: ['รูปแบบเสียงของวิดีโอนี้ยังไม่รองรับ', 'warn'],
  holding: ['หยุดรอ AI ตัดเสียงสักครู่', 'warn'],
  processing: ['AI กำลังตัดเสียง (ระหว่างนี้ได้ยินเสียงต้นฉบับ)', 'warn'],
  active: ['กำลังตัดเสียงร้อง', 'ok'],
  error: ['เกิดข้อผิดพลาด', 'warn'],
};

let tabId = null;
let pitch = 0;

function render(s) {
  const guide = Math.round((1 - s.strength) * 100);
  for (const b of els.stems) b.setAttribute('aria-pressed', String(!!s[b.dataset.key]));
  els.reset.disabled = !els.stems.some((b) => s[b.dataset.key]);
  els.guide.value = guide;
  els.guideOut.textContent = guide === 0 ? 'ปิด' : `${guide}%`;
  els.hold.checked = s.hold;
  els.guide.disabled = !s.removeVocals;
  els.lyrics.checked = s.lyrics;
  els.lyricsOffset.value = s.lyricsOffset;
  const off = Number(s.lyricsOffset);
  els.offsetOut.textContent = off === 0 ? '0 วินาที' : `${off > 0 ? 'เร็วขึ้น' : 'ช้าลง'} ${Math.abs(off).toFixed(1)} วินาที`;
  els.lyricsOffset.disabled = !s.lyrics;
  els.lyricsLang.value = s.lyricsLang;
  pitch = s.pitch;
  els.keyOut.textContent = pitch === 0 ? 'คีย์เดิม' : `${pitch > 0 ? '+' : '−'}${Math.abs(pitch)}`;
  els.keyDown.disabled = pitch <= -PITCH_RANGE;
  els.keyUp.disabled = pitch >= PITCH_RANGE;
}

function setStatus(text, cls = '', detail = '') {
  els.status.textContent = text;
  els.status.className = `status ${cls}`;
  els.detail.textContent = detail;
}

async function refreshStatus() {
  if (tabId == null) return;
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'karaoke:status' });
    let [text, cls] = STATUS_TEXT[res.state] || [res.state, ''];
    if (res.state === 'downloading') text += ` ${Math.round(res.progress * 100)}%`;
    if (res.error) text += `: ${res.error}`;
    const detail = [];
    const MODEL_NAMES = { mdx: 'โมเดลตัดเสียงร้อง', demucs: 'โมเดลแยกเครื่องดนตรี' };
    if (res.models?.length) detail.push(res.models.map((m) => MODEL_NAMES[m]).join(' + '));
    if (res.backend) detail.push(res.backend === 'webgpu' ? 'ประมวลผลด้วย GPU (WebGPU)' : 'ประมวลผลด้วย CPU (ช้ากว่า)');
    if (res.realtime) detail.push(`เร็วกว่าเวลาจริง ${res.realtime.toFixed(1)} เท่า`);
    setStatus(text, cls, detail.join(' · '));
    els.keyHint.textContent = res.pitchError
      ? `ปรับคีย์ไม่ได้: ${res.pitchError}`
      : res.pitchNeedsGesture
        ? 'คลิกที่หน้า YouTube หนึ่งครั้งเพื่อเริ่มปรับคีย์'
        : '';
    const ly = await chrome.tabs.sendMessage(tabId, { type: 'karaoke:lyrics-status' });
    els.lyricsStatus.textContent =
      ly.phase === 'ready'
        ? `เนื้อเพลงจาก ${LYRICS_SOURCE[ly.source]}${ly.label ? ` (${ly.label})` : ''}${{ captions: ' · จัดจังหวะตามคลิปแล้ว', vocals: ' · จัดจังหวะตามเสียงร้องแล้ว' }[ly.synced] || ''}`
        : LYRICS_PHASE[ly.phase] || '';
  } catch {
    // No content script: not a YouTube tab, or the tab was open before install.
    setStatus('เปิดหน้า YouTube (ถ้าเปิดอยู่แล้วให้รีโหลดหน้า)', 'warn');
  }
}

function save(patch) {
  chrome.storage.local.set(patch);
  chrome.storage.local.get(DEFAULTS, render);
  setTimeout(refreshStatus, 300);
}

els.reset.addEventListener('click', () => save(Object.fromEntries(els.stems.map((b) => [b.dataset.key, false]))));
for (const b of els.stems) {
  b.addEventListener('click', () => save({ [b.dataset.key]: b.getAttribute('aria-pressed') !== 'true' }));
}
els.guide.addEventListener('input', () => save({ strength: 1 - els.guide.value / 100 }));
els.hold.addEventListener('change', () => save({ hold: els.hold.checked }));
els.lyrics.addEventListener('change', () => save({ lyrics: els.lyrics.checked }));
els.lyricsLang.addEventListener('change', () => save({ lyricsLang: els.lyricsLang.value }));
els.keyDown.addEventListener('click', () => save({ pitch: Math.max(-PITCH_RANGE, pitch - 1) }));
els.keyUp.addEventListener('click', () => save({ pitch: Math.min(PITCH_RANGE, pitch + 1) }));
els.keyOut.addEventListener('click', () => save({ pitch: 0 }));
els.lyricsOffset.addEventListener('input', () => save({ lyricsOffset: Number(els.lyricsOffset.value) }));

(async () => {
  chrome.storage.local.get(DEFAULTS, render);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
