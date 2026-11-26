// Value encodings for LITO channel fields. Anything marked GUESS is an assumption that
// still needs a BLE capture to confirm, so it lives in `assumptions` and the UI lets you change it.

export const CTCSS_TONES = [
  67.0, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2,
  110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 162.2, 167.9,
  173.8, 179.9, 186.2, 192.8, 203.5, 210.7, 218.1, 225.7, 233.6, 241.8, 250.3,
];

// The radio's 83-code DCS order (from the app's ChannelHelper.getCssList), not the full 104-code list.
export const DCS_CODES = [
  23, 25, 26, 31, 32, 43, 47, 51, 54, 65, 71, 72, 73, 74, 114, 115, 116, 125, 131, 132,
  134, 143, 152, 155, 156, 162, 165, 172, 174, 205, 223, 226, 243, 244, 245, 251, 261, 263, 265, 271,
  306, 311, 315, 331, 343, 346, 351, 364, 365, 371, 411, 412, 413, 423, 431, 432, 445, 464, 465, 466,
  503, 506, 516, 532, 546, 565, 606, 612, 624, 627, 631, 632, 654, 662, 664, 703, 712, 723, 731, 732,
  734, 743, 754,
]; // octal codes written as decimal digits, e.g. 23 means D023

export const DEFAULT_ASSUMPTIONS = {
  // GUESS: CSS value = type * 256 + index. Type 0 = off (from the app UI code, "likely").
  cssTypeCtcss: 1,      // CONFIRMED on a real radio (269 = 103.5 Hz)
  cssTypeDcsN: 2,       // CONFIRMED from app code
  cssTypeDcsI: 3,       // CONFIRMED from app code
  cssIndexBase: 1,      // CONFIRMED: index 0 = no tone, 1 = 67.0 Hz
  // Transport
  chunkSize: 180,       // bytes per GATT write. Use 20 if writes fail.
  timeoutMs: 4000,
  // Channel reading: confirmed from the app (radio-driven, ack with result=OK)
  queryMaxChannels: 300,
  maxUserChannels: 60, // official app limit; measure a radio with the channel limit test
  nameMaxBytes: 18,     // CONFIRMED from the app: 18 units, ASCII = 1, any other character = 3
};

export function hzToMHz(hz) { return hz == null ? '' : (hz / 1e6).toFixed(5); }
export function mhzToHz(s) {
  const v = parseFloat(String(s).trim());
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(v * 1e6);
}

export function cssDecode(value, a = DEFAULT_ASSUMPTIONS) {
  if (value == null) return { kind: 'none', label: '' };
  const type = Math.floor(value / 256), idx = value % 256;
  const i = idx - a.cssIndexBase;
  if (type === 0) return { kind: 'off', label: 'Off' };
  if (i < 0) return { kind: 'off', label: 'Off' }; // e.g. 256 / 512: a tone type with no tone picked
  if (type === a.cssTypeCtcss && CTCSS_TONES[i] != null) return { kind: 'ctcss', label: CTCSS_TONES[i].toFixed(1) };
  if (type === a.cssTypeDcsN && DCS_CODES[i] != null) return { kind: 'dcs', label: 'D' + String(DCS_CODES[i]).padStart(3, '0') + 'N' };
  if (type === a.cssTypeDcsI && DCS_CODES[i] != null) return { kind: 'dcs', label: 'D' + String(DCS_CODES[i]).padStart(3, '0') + 'I' };
  return { kind: 'raw', label: `raw ${value} (t${type}/i${idx})` };
}

/** All selectable tone values under the current assumptions: [{value, label}] */
export function cssOptions(a = DEFAULT_ASSUMPTIONS) {
  const opts = [{ value: 0, label: 'Off' }];
  CTCSS_TONES.forEach((t, i) => opts.push({ value: a.cssTypeCtcss * 256 + i + a.cssIndexBase, label: t.toFixed(1) }));
  DCS_CODES.forEach((c, i) => opts.push({ value: a.cssTypeDcsN * 256 + i + a.cssIndexBase, label: 'D' + String(c).padStart(3, '0') + 'N' }));
  DCS_CODES.forEach((c, i) => opts.push({ value: a.cssTypeDcsI * 256 + i + a.cssIndexBase, label: 'D' + String(c).padStart(3, '0') + 'I' }));
  return opts;
}

/** Parse a tone the way a person types it: "", "off", "67", "67.0", "D023N", "023I", "raw:300". */
export function cssParse(text, a = DEFAULT_ASSUMPTIONS) {
  const s = String(text ?? '').trim().toUpperCase();
  if (s === '' || s === 'OFF' || s === '0') return 0;
  let m = s.match(/^RAW[: ]?(\d+)$/); if (m) return parseInt(m[1], 10);
  m = s.match(/^D?(\d{3})([NI])$/);
  if (m) {
    const i = DCS_CODES.indexOf(parseInt(m[1], 10));
    if (i < 0) return null;
    return (m[2] === 'N' ? a.cssTypeDcsN : a.cssTypeDcsI) * 256 + i + a.cssIndexBase;
  }
  const f = parseFloat(s);
  if (Number.isFinite(f)) {
    const i = CTCSS_TONES.findIndex((t) => Math.abs(t - f) < 0.05);
    if (i >= 0) return a.cssTypeCtcss * 256 + i + a.cssIndexBase;
  }
  return null;
}

export function bytesToName(b) {
  if (!b) return '';
  const end = b.indexOf(0);
  const v = end >= 0 ? b.subarray(0, end) : b;
  // The radio stores names in GBK (e.g. its public channels are "公众频道 L01"). ASCII is the same in both.
  try { return new TextDecoder('utf-8', { fatal: true }).decode(v); } catch { /* not UTF-8 */ }
  try { return new TextDecoder('gbk').decode(v); } catch { return new TextDecoder().decode(v); }
}
// Browsers can't encode GBK, so only ASCII names are safe to write (validate() enforces this).
export function nameToBytes(s) { return new TextEncoder().encode(s ?? ''); }
export const isAsciiName = (s) => /^[\x20-\x7e]*$/.test(s ?? '');
