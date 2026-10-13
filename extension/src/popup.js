const DEFAULTS = { enabled: false, strength: 1, hold: true };

const $ = (id) => document.getElementById(id);
const els = {
  enabled: $('enabled'),
  guide: $('guide'),
  guideOut: $('guideOut'),
  hold: $('hold'),
  status: $('status'),
  detail: $('detail'),
};

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

function render(s) {
  const guide = Math.round((1 - s.strength) * 100);
  els.enabled.checked = s.enabled;
  els.guide.value = guide;
  els.guideOut.textContent = guide === 0 ? 'ปิด' : `${guide}%`;
  els.hold.checked = s.hold;
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
    if (res.backend) detail.push(res.backend === 'webgpu' ? 'ประมวลผลด้วย GPU (WebGPU)' : 'ประมวลผลด้วย CPU (ช้ากว่า)');
    if (res.realtime) detail.push(`เร็วกว่าเวลาจริง ${res.realtime.toFixed(1)} เท่า`);
    setStatus(text, cls, detail.join(' · '));
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

els.enabled.addEventListener('change', () => save({ enabled: els.enabled.checked }));
els.guide.addEventListener('input', () => save({ strength: 1 - els.guide.value / 100 }));
els.hold.addEventListener('change', () => save({ hold: els.hold.checked }));

(async () => {
  chrome.storage.local.get(DEFAULTS, render);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  tabId = tab.id;
  refreshStatus();
  setInterval(refreshStatus, 1000);
})();
