// Incremental top-level WebM parser for the byte stream YouTube appends to an
// audio SourceBuffer. Splits it into an init segment (EBML header + Segment
// header + Info + Tracks) and Clusters with their start time, so each run of
// clusters can be decoded on its own with decodeAudioData(init + clusters).

const ID = {
  EBML: 0x1a45dfa3,
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMECODE_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMECODE: 0xe7,
};

// Segment header rewritten with "unknown" size, since we only ship part of it.
const SEGMENT_HEADER = new Uint8Array([0x18, 0x53, 0x80, 0x67, 0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8) throw new Error('invalid EBML vint');
  if (pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (0xff >> len);
  let allOnes = value === (0xff >> len);
  for (let i = 1; i < len; i++) {
    value = value * 256 + buf[pos + i];
    if (buf[pos + i] !== 0xff) allOnes = false;
  }
  return { value, len, unknown: !keepMarker && allOnes };
}

function readUint(buf, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return v;
}

// Finds a direct child element's unsigned-int value inside [start, end).
function findUintChild(buf, start, end, id) {
  let pos = start;
  while (pos < end) {
    const eid = readVint(buf, pos, true);
    const size = readVint(buf, pos + eid.len, false);
    const body = pos + eid.len + size.len;
    if (eid.value === id) return readUint(buf, body, size.value);
    pos = body + size.value;
  }
  return null;
}

export function concatBytes(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export class WebmStream {
  constructor() {
    this.buf = new Uint8Array(0);
    this.initParts = null;
    this.init = null; // Uint8Array once Tracks has been seen
    this.timecodeScale = 1e6; // ns per tick (WebM default)
  }

  // Feeds appended bytes; returns new events:
  //   { type: 'init', bytes }  — a (new) init segment
  //   { type: 'cluster', time, bytes } — time in seconds (plus timestampOffset)
  push(bytes, timestampOffset = 0) {
    const merged = new Uint8Array(this.buf.length + bytes.length);
    merged.set(this.buf);
    merged.set(bytes, this.buf.length);
    const buf = merged;
    const events = [];
    let pos = 0;

    for (;;) {
      const id = readVint(buf, pos, true);
      if (!id) break;
      const size = readVint(buf, pos + id.len, false);
      if (!size) break;
      const headerLen = id.len + size.len;

      if (id.value === ID.SEGMENT) {
        // Descend into the segment: its children are parsed as top-level.
        this.initParts = this.initParts || [];
        this.initParts.push(SEGMENT_HEADER);
        pos += headerLen;
        continue;
      }
      if (size.unknown) throw new Error(`unknown-size element 0x${id.value.toString(16)} not supported`);
      const end = pos + headerLen + size.value;
      if (end > buf.length) break; // wait for more data
      const element = buf.subarray(pos, end);

      switch (id.value) {
        case ID.EBML:
          this.initParts = [element.slice()];
          this.init = null;
          break;
        case ID.INFO: {
          const scale = findUintChild(buf, pos + headerLen, end, ID.TIMECODE_SCALE);
          if (scale) this.timecodeScale = scale;
          this.initParts?.push(element.slice());
          break;
        }
        case ID.TRACKS:
          this.initParts?.push(element.slice());
          if (this.initParts) {
            this.init = concatBytes(this.initParts);
            this.initParts = null;
            events.push({ type: 'init', bytes: this.init });
          }
          break;
        case ID.CLUSTER: {
          const tc = findUintChild(buf, pos + headerLen, end, ID.CLUSTER_TIMECODE) ?? 0;
          events.push({
            type: 'cluster',
            time: (tc * this.timecodeScale) / 1e9 + timestampOffset,
            bytes: element.slice(),
          });
          break;
        }
        default:
          break; // SeekHead, Cues, Void, Tags, ... are not needed for decoding
      }
      pos = end;
    }

    this.buf = buf.slice(pos);
    return events;
  }
}
