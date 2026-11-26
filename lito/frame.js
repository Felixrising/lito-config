// LITO frame layer: FE | 01 | len16 | cmd16 | seq16 | payload | crc16  (all big-endian)
// len = total frame length (10 + payload). CRC-16/MCRF4XX over everything before the CRC.

export const MAGIC = 0xFE;
export const VERSION = 0x01;
export const OVERHEAD = 10;

export function crc16(bytes, start = 0, end = bytes.length) {
  let c = 0xFFFF;
  for (let i = start; i < end; i++) {
    c ^= bytes[i];
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0x8408 : c >>> 1;
  }
  return c & 0xFFFF;
}

export function encodeFrame(cmd, seq, payload = new Uint8Array(0)) {
  const len = OVERHEAD + payload.length;
  if (len > 0xFFFF) throw new Error('frame too long');
  const f = new Uint8Array(len);
  f[0] = MAGIC; f[1] = VERSION;
  f[2] = len >> 8; f[3] = len & 0xFF;
  f[4] = cmd >> 8; f[5] = cmd & 0xFF;
  f[6] = (seq >> 8) & 0xFF; f[7] = seq & 0xFF;
  f.set(payload, 8);
  const c = crc16(f, 0, len - 2);
  f[len - 2] = c >> 8; f[len - 1] = c & 0xFF;
  return f;
}

/** Parse one complete frame. Throws on bad magic/length/CRC. */
export function decodeFrame(f) {
  if (f.length < OVERHEAD) throw new Error('frame: too short');
  if (f[0] !== MAGIC) throw new Error('frame: bad magic');
  const len = (f[2] << 8) | f[3];
  if (len !== f.length) throw new Error(`frame: length field ${len} != ${f.length}`);
  const want = (f[len - 2] << 8) | f[len - 1];
  const got = crc16(f, 0, len - 2);
  if (want !== got) throw new Error(`frame: CRC ${hex16(want)} != computed ${hex16(got)}`);
  return {
    version: f[1],
    cmd: (f[4] << 8) | f[5],
    seq: (f[6] << 8) | f[7],
    payload: f.slice(8, len - 2),
  };
}

/**
 * Reassembles notification slices into frames. Call push() with each notification;
 * onFrame(frame, rawBytes) fires per complete valid frame, onError(err, rawBytes) for junk.
 */
export class FrameAssembler {
  constructor(onFrame, onError = () => {}) {
    this.buf = new Uint8Array(0);
    this.onFrame = onFrame;
    this.onError = onError;
  }
  reset() { this.buf = new Uint8Array(0); }
  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf); merged.set(chunk, this.buf.length);
    this.buf = merged;
    for (;;) {
      // resync to a header mark
      let start = this.buf.indexOf(MAGIC);
      if (start < 0) { if (this.buf.length) this.onError(new Error('frame: discarded bytes without header'), this.buf); this.buf = new Uint8Array(0); return; }
      if (start > 0) { this.onError(new Error('frame: discarded bytes before header'), this.buf.slice(0, start)); this.buf = this.buf.slice(start); }
      if (this.buf.length < 4) return;
      const len = (this.buf[2] << 8) | this.buf[3];
      if (len < OVERHEAD || this.buf[1] !== VERSION) {
        this.onError(new Error('frame: bad header'), this.buf.slice(0, 4));
        this.buf = this.buf.slice(1);
        continue;
      }
      if (this.buf.length < len) return;
      const raw = this.buf.slice(0, len);
      try {
        const fr = decodeFrame(raw);
        this.buf = this.buf.slice(len);
        this.onFrame(fr, raw);
      } catch (e) {
        this.onError(e, raw);
        this.buf = this.buf.slice(1); // skip this mark and look for the next one
      }
    }
  }
}

export function hex16(n) { return '0x' + n.toString(16).toUpperCase().padStart(4, '0'); }
export function toHex(bytes) { return Array.from(bytes, (b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '); }
export function fromHex(s) {
  const clean = s.replace(/[^0-9a-fA-F]/g, '');
  if (clean.length % 2) throw new Error('odd hex length');
  return Uint8Array.from(clean.match(/../g) || [], (h) => parseInt(h, 16));
}
