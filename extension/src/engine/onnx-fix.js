// Rewrites float64 constants in an ONNX model to float32.
//
// onnxruntime-web ships without double kernels, but the HT-Demucs export
// builds its inverse STFT from double Constant/ConstantOfShape values, so the
// session fails to load ("Could not find an implementation for
// ConstantOfShape(9)"). Turning those constants into float32 makes every op
// downstream run in float32 too, the precision the model itself uses.
//
// Minimal protobuf walk: only the messages on the path to node attributes are
// decoded and re-encoded; everything else (notably the weights) is copied as-is.

const WIRE_VARINT = 0;
const WIRE_I64 = 1;
const WIRE_LEN = 2;
const WIRE_I32 = 5;

const DOUBLE = 11;
const FLOAT = 1;

// Field numbers from onnx.proto
const MODEL_GRAPH = 7;
const GRAPH_NODE = 1;
const NODE_ATTRIBUTE = 5;
const ATTR_T = 5;
const ATTR_G = 6;
const ATTR_TENSORS = 10;
const ATTR_GRAPHS = 11;
const TENSOR_DATA_TYPE = 2;
const TENSOR_FLOAT_DATA = 4;
const TENSOR_RAW_DATA = 9;
const TENSOR_DOUBLE_DATA = 10;

function readVarint(buf, pos) {
  let value = 0;
  let mul = 1;
  for (;;) {
    const b = buf[pos++];
    value += (b & 0x7f) * mul;
    if (b < 0x80) return [value, pos];
    mul *= 128;
  }
}

function varint(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return Uint8Array.from(out);
}

// Splits a message into fields: { num, wire, start, end, valueStart }.
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    const [tag, p] = readVarint(buf, pos);
    pos = p;
    const num = Math.floor(tag / 8);
    const wire = tag & 7;
    let valueStart = pos;
    if (wire === WIRE_VARINT) pos = readVarint(buf, pos)[1];
    else if (wire === WIRE_I64) pos += 8;
    else if (wire === WIRE_I32) pos += 4;
    else if (wire === WIRE_LEN) {
      const [len, q] = readVarint(buf, pos);
      valueStart = q;
      pos = q + len;
    } else throw new Error(`unsupported protobuf wire type ${wire}`);
    out.push({ num, wire, start, end: pos, valueStart });
  }
  return out;
}

// A message being rebuilt: a list of byte chunks.
class Writer {
  constructor() {
    this.chunks = [];
    this.length = 0;
  }
  raw(bytes) {
    this.chunks.push(bytes);
    this.length += bytes.length;
  }
  len(num, child) {
    this.raw(varint(num * 8 + WIRE_LEN));
    this.raw(varint(child.length));
    for (const c of child.chunks) this.raw(c);
  }
  bytesField(num, bytes) {
    this.raw(varint(num * 8 + WIRE_LEN));
    this.raw(varint(bytes.length));
    this.raw(bytes);
  }
}

function toFloat32Bytes(f64) {
  return new Uint8Array(Float32Array.from(f64).buffer);
}

function rewriteTensor(buf, stats) {
  const fs = fields(buf);
  const typeField = fs.find((f) => f.num === TENSOR_DATA_TYPE && f.wire === WIRE_VARINT);
  const isDouble = typeField && readVarint(buf, typeField.valueStart)[0] === DOUBLE;
  const w = new Writer();
  if (!isDouble) {
    w.raw(buf);
    return w;
  }
  stats.tensors++;
  const doubles = [];
  for (const f of fs) {
    if (f.num === TENSOR_DATA_TYPE) {
      w.raw(varint(TENSOR_DATA_TYPE * 8 + WIRE_VARINT));
      w.raw(varint(FLOAT));
    } else if (f.num === TENSOR_RAW_DATA) {
      const bytes = buf.slice(f.valueStart, f.end);
      w.bytesField(TENSOR_RAW_DATA, toFloat32Bytes(new Float64Array(bytes.buffer, 0, bytes.length / 8)));
    } else if (f.num === TENSOR_DOUBLE_DATA) {
      // packed (LEN) or one value per field (I64)
      const bytes = buf.slice(f.wire === WIRE_LEN ? f.valueStart : f.end - 8, f.end);
      doubles.push(...new Float64Array(bytes.buffer, 0, bytes.length / 8));
    } else w.raw(buf.subarray(f.start, f.end));
  }
  if (doubles.length) w.bytesField(TENSOR_FLOAT_DATA, toFloat32Bytes(doubles));
  return w;
}

function rewriteMessage(buf, rules, stats) {
  const w = new Writer();
  for (const f of fields(buf)) {
    const rule = f.wire === WIRE_LEN ? rules[f.num] : null;
    if (rule) w.len(f.num, rule(buf.subarray(f.valueStart, f.end), stats));
    else w.raw(buf.subarray(f.start, f.end));
  }
  return w;
}

const rewriteGraph = (buf, stats) => rewriteMessage(buf, { [GRAPH_NODE]: rewriteNode }, stats);
const rewriteNode = (buf, stats) => rewriteMessage(buf, { [NODE_ATTRIBUTE]: rewriteAttribute }, stats);
const rewriteAttribute = (buf, stats) =>
  rewriteMessage(
    buf,
    { [ATTR_T]: rewriteTensor, [ATTR_TENSORS]: rewriteTensor, [ATTR_G]: rewriteGraph, [ATTR_GRAPHS]: rewriteGraph },
    stats,
  );

// Returns { bytes, tensors }: the rewritten model and how many constants changed.
export function doubleConstantsToFloat(model) {
  const stats = { tensors: 0 };
  const w = rewriteMessage(model, { [MODEL_GRAPH]: rewriteGraph }, stats);
  const out = new Uint8Array(w.length);
  let off = 0;
  for (const c of w.chunks) {
    out.set(c, off);
    off += c.length;
  }
  return { bytes: out, tensors: stats.tensors };
}
