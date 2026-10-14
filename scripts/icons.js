// Renders the extension icon (white microphone on a rounded red square) to
// extension/icons/icon-<size>.png. Pure Node so it needs no image tooling;
// run once after changing the design and commit the PNGs.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const SIZES = [16, 32, 48, 128];
const SS = 4; // supersampling per axis

// Signed distances in unit coordinates (0..1, y down); negative = inside.
const box = (x, y, cx, cy, hw, hh, r) => {
  const dx = Math.abs(x - cx) - hw + r, dy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};
const vseg = (x, y, cx, y0, y1, r) => Math.hypot(x - cx, y - Math.min(Math.max(y, y0), y1)) - r;

function mic(x, y) {
  const capsule = vseg(x, y, 0.5, 0.25, 0.47, 0.12);
  // U-shaped holder: lower half of a ring around the capsule's bottom.
  const ring = Math.abs(Math.hypot(x - 0.5, y - 0.47) - 0.2) - 0.035;
  const holder = y >= 0.47 ? ring : Math.min(Math.hypot(x - 0.3, y - 0.47), Math.hypot(x - 0.7, y - 0.47)) - 0.035;
  const stem = box(x, y, 0.5, 0.735, 0.035, 0.065, 0);
  const base = box(x, y, 0.5, 0.8, 0.14, 0.035, 0.035);
  return Math.min(capsule, holder, stem, base);
}

function render(size) {
  const pad = size >= 128 ? 16 / 128 : 0; // Web Store wants 96px art inside 128px
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let bg = 0, fg = 0, r = 0, g = 0, b = 0;
      for (let sj = 0; sj < SS; sj++) {
        for (let si = 0; si < SS; si++) {
          const u = (i + (si + 0.5) / SS) / size, v = (j + (sj + 0.5) / SS) / size;
          const x = (u - pad) / (1 - 2 * pad), y = (v - pad) / (1 - 2 * pad);
          if (box(x, y, 0.5, 0.5, 0.5, 0.5, 0.22) > 0) continue;
          bg++;
          if (mic(x, y) <= 0) { fg++; continue; }
          // Vertical gradient #ff4d4d → #c62828.
          r += 255 - 57 * y; g += 77 - 37 * y; b += 77 - 37 * y;
        }
      }
      const o = (j * size + i) * 4, n = SS * SS;
      if (!bg) continue;
      px[o] = Math.round((r + 255 * fg) / bg);
      px[o + 1] = Math.round((g + 255 * fg) / bg);
      px[o + 2] = Math.round((b + 255 * fg) / bg);
      px[o + 3] = Math.round((255 * bg) / n);
    }
  }
  return png(size, px);
}

const CRC = new Int32Array(256).map((_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4), crc = Buffer.alloc(4), td = Buffer.concat([Buffer.from(type), data]);
  len.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const dest = path.resolve('extension/icons');
fs.mkdirSync(dest, { recursive: true });
for (const s of SIZES) fs.writeFileSync(path.join(dest, `icon-${s}.png`), render(s));
console.log(`wrote ${SIZES.length} icons to ${path.relative(process.cwd(), dest)}`);
