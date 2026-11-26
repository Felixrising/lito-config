// Minimal schema-driven proto2 encoder/decoder. No dependencies.
// Supports the wire types used by the SEAL schema: varint (uint32, sint32, enum, bool)
// and length-delimited (bytes, string, nested message). Unknown fields are kept in
// `_unknown` so a decode -> encode round trip does not lose data the schema doesn't know.

const WT_VARINT = 0, WT_I64 = 1, WT_LEN = 2, WT_I32 = 5;

const VARINT_TYPES = new Set(['uint32', 'sint32', 'int32', 'enum', 'bool']);

function writeVarint(out, value) {
  // value is a non-negative Number up to 2^53. Avoid 32-bit bitwise ops.
  let v = value;
  while (v >= 0x80) {
    out.push((v % 0x80) | 0x80);
    v = Math.floor(v / 0x80);
  }
  out.push(v);
}

function zigzag(n) { return n >= 0 ? n * 2 : -n * 2 - 1; }
function unzigzag(n) { return n % 2 === 0 ? n / 2 : -(n + 1) / 2; }

class Reader {
  constructor(bytes) { this.b = bytes; this.p = 0; }
  eof() { return this.p >= this.b.length; }
  varint() {
    let result = 0, mul = 1, byte;
    do {
      if (this.p >= this.b.length) throw new Error('protobuf: truncated varint');
      byte = this.b[this.p++];
      result += (byte & 0x7f) * mul;
      mul *= 0x80;
    } while (byte & 0x80);
    return result;
  }
  bytes(n) {
    if (this.p + n > this.b.length) throw new Error('protobuf: truncated field');
    const s = this.b.subarray(this.p, this.p + n);
    this.p += n;
    return s;
  }
}

/**
 * @param {object} registry  map of message name -> { fields: [{no, name, type, msg?, enum?, repeated?}] }
 */
export function createCodec(registry) {
  const byName = {};
  const byNo = {};
  for (const [mname, def] of Object.entries(registry)) {
    byName[mname] = {};
    byNo[mname] = {};
    for (const f of def.fields) { byName[mname][f.name] = f; byNo[mname][f.no] = f; }
  }

  function encodeField(out, f, value) {
    if (f.type === 'message') {
      const inner = encode(f.msg, value);
      writeVarint(out, f.no * 8 + WT_LEN);
      writeVarint(out, inner.length);
      for (const b of inner) out.push(b);
    } else if (f.type === 'bytes' || f.type === 'string') {
      const data = typeof value === 'string' ? new TextEncoder().encode(value) : value;
      writeVarint(out, f.no * 8 + WT_LEN);
      writeVarint(out, data.length);
      for (const b of data) out.push(b);
    } else if (VARINT_TYPES.has(f.type)) {
      let v = value;
      if (f.type === 'bool') v = value ? 1 : 0;
      if (f.type === 'sint32') v = zigzag(value);
      if (f.type === 'int32' && v < 0) v = v + 2 ** 64; // proto int32 negatives are 10-byte varints
      if (!Number.isFinite(v) || v < 0) throw new Error(`protobuf: bad value for ${f.name}: ${value}`);
      writeVarint(out, f.no * 8 + WT_VARINT);
      writeVarint(out, v);
    } else {
      throw new Error(`protobuf: unsupported type ${f.type}`);
    }
  }

  function encode(msgName, obj) {
    const fields = registry[msgName];
    if (!fields) throw new Error(`protobuf: unknown message ${msgName}`);
    const out = [];
    const sorted = [...fields.fields].sort((a, b) => a.no - b.no);
    for (const f of sorted) {
      const value = obj[f.name];
      if (value === undefined || value === null) {
        if (f.required) throw new Error(`protobuf: ${msgName}.${f.name} is required`);
        continue;
      }
      if (f.repeated) for (const v of value) encodeField(out, f, v);
      else encodeField(out, f, value);
    }
    for (const u of obj._unknown || []) {
      writeVarint(out, u.no * 8 + u.wt);
      if (u.wt === WT_VARINT) writeVarint(out, u.value);
      else { if (u.wt === WT_LEN) writeVarint(out, u.value.length); for (const b of u.value) out.push(b); }
    }
    return Uint8Array.from(out);
  }

  function decode(msgName, bytes) {
    if (!registry[msgName]) throw new Error(`protobuf: unknown message ${msgName}`);
    const r = new Reader(bytes);
    const obj = {};
    while (!r.eof()) {
      const key = r.varint();
      const no = Math.floor(key / 8), wt = key % 8;
      const f = byNo[msgName][no];
      let raw;
      if (wt === WT_VARINT) raw = r.varint();
      else if (wt === WT_LEN) raw = r.bytes(r.varint());
      else if (wt === WT_I64) raw = r.bytes(8);
      else if (wt === WT_I32) raw = r.bytes(4);
      else throw new Error(`protobuf: unsupported wire type ${wt} in ${msgName}`);

      if (!f) { (obj._unknown ||= []).push({ no, wt, value: wt === WT_VARINT ? raw : Uint8Array.from(raw) }); continue; }
      let v;
      if (f.type === 'message') v = decode(f.msg, raw);
      else if (f.type === 'bytes') v = Uint8Array.from(raw);
      else if (f.type === 'string') v = new TextDecoder().decode(raw);
      else if (f.type === 'sint32') v = unzigzag(raw);
      else if (f.type === 'int32') v = raw >= 2 ** 63 ? raw - 2 ** 64 : raw;
      else if (f.type === 'bool') v = raw !== 0;
      else v = raw;
      if (f.repeated) (obj[f.name] ||= []).push(v); else obj[f.name] = v;
    }
    return obj;
  }

  return { encode, decode, fieldsOf: (m) => byName[m] };
}
