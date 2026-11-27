// Pure helpers for the channel grid: TX mode (simplex / repeater / listen only) and spreadsheet copy & paste.
import { expandRanges } from '../lito/bands.js';
import { hzToMHz, mhzToHz, cssParse, cssDecode } from '../lito/values.js';

// ---------- TX mode ----------
export const MODES = [
  ['simplex', 'Simplex', 'Transmit and receive on the same frequency'],
  ['repeater', 'Repeater (+750 kHz)', 'Transmit 750 kHz higher, on the repeater input. Australian repeaters listen on CH31-38 and CH71-78 and repeat on CH1-8 and CH41-48.'],
  ['listen', 'Listen only', 'No transmit (TX set to 0). Experimental: run the listen-only test on the Log tab first.'],
  ['custom', 'Custom split', 'TX and RX are set separately'],
];

const txSets = new WeakMap();
/** Whether the plan (region) lets the official app transmit on hz. */
export function txAllowed(plan, hz) {
  if (!txSets.has(plan)) txSets.set(plan, new Set(expandRanges(plan.tx)));
  return txSets.get(plan).has(hz);
}

/** simplex | repeater | listen | custom, from a channel's RX/TX. */
export function txMode(ch, plan) {
  const rx = ch.chRxFreq, tx = ch.chTxFreq;
  if (tx === 0) return 'listen';
  if (tx == null || tx === rx) return 'simplex';
  if (plan.repeater && rx != null && tx === rx + plan.repeater) return 'repeater';
  return 'custom';
}

export function txForMode(mode, rx, plan) {
  if (mode === 'listen') return 0;
  if (mode === 'repeater') return rx + (plan.repeater || 0);
  return rx;
}

/** RX moved from oldRx: keep the channel's mode. Falls back between simplex and repeater when the region doesn't allow one. */
export function followRx(ch, oldRx, plan) {
  const mode = txMode({ chRxFreq: oldRx, chTxFreq: ch.chTxFreq }, plan);
  if (mode === 'custom') return;
  if (mode === 'listen') { ch.chTxFreq = 0; return; }
  const order = mode === 'repeater' ? ['repeater', 'simplex'] : ['simplex', 'repeater'];
  for (const m of order) {
    if (m === 'repeater' && !plan.repeater) continue;
    const tx = txForMode(m, ch.chRxFreq, plan);
    if (txAllowed(plan, tx)) { ch.chTxFreq = tx; return; }
  }
}

// ---------- copy & paste ----------
/** Grid columns in table order (Slot is copied for reference but never pasted). */
export const COLUMNS = [
  { key: 'slot', head: 'Slot' }, { key: 'name', head: 'Name' }, { key: 'rx', head: 'RX MHz' }, { key: 'mode', head: 'Mode' },
  { key: 'tx', head: 'TX MHz' }, { key: 'rxTone', head: 'RX tone' }, { key: 'txTone', head: 'TX tone' },
];
const ALIASES = {
  slot: ['slot', 'ch no', 'no', '#'], name: ['name', 'channel name', 'label'],
  rx: ['rx mhz', 'rx', 'rx freq', 'rx frequency', 'receive', 'frequency', 'freq'], tx: ['tx mhz', 'tx', 'tx freq', 'tx frequency', 'transmit'],
  mode: ['mode', 'offset', 'duplex', 'tx mode'], rxTone: ['rx tone', 'rx ctcss', 'rx css', 'rx ctcss/dcs', 'decode'], txTone: ['tx tone', 'tx ctcss', 'tx css', 'tx ctcss/dcs', 'encode', 'tone'],
};
const norm = (s) => String(s).replace(/\s+/g, ' ').trim().toLowerCase();

/** Column key for a header cell, or null. tr translates English so headers copied in another language also match. */
export function headerKey(cell, tr = (s) => s) {
  const c = norm(cell);
  for (const col of COLUMNS) if (c === norm(col.head) || c === norm(tr(col.head)) || ALIASES[col.key].includes(c)) return col.key;
  return null;
}

/** Split clipboard text (tab-separated, as Excel copies it) into rows of cells. */
export function splitClipboard(text) {
  const s = String(text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  return s === '' ? [] : s.split('\n').map((l) => l.split('\t'));
}

/**
 * Work out which column each pasted cell goes to.
 * A header row (two or more known headings) maps by name; otherwise cells fill from startKey rightwards.
 * Returns { keys: [key|null per cell], rows: [[cell…]…] }.
 */
export function mapPaste(lines, startKey = 'name', tr) {
  if (!lines.length) return { keys: [], rows: [] };
  const hk = lines[0].map((c) => headerKey(c, tr));
  if (hk.filter(Boolean).length >= 2) return { keys: hk.map((k) => (k === 'slot' ? null : k)), rows: lines.slice(1) };
  let rows = lines;
  // A leading Slot column (C01, L02 …) without a header: drop it.
  if (rows.every((r) => /^[CL]\d{1,2}$/i.test(String(r[0]).trim()))) rows = rows.map((r) => r.slice(1));
  const order = COLUMNS.map((c) => c.key).filter((k) => k !== 'slot');
  const i0 = Math.max(0, order.indexOf(startKey));
  const width = Math.max(...rows.map((r) => r.length));
  return { keys: Array.from({ length: width }, (_, i) => order[i0 + i] ?? null), rows };
}

/** Frequency from text: MHz (476.425), Hz (476425000) or a channel name/number in the region (CH5, 5). */
export function parseFreq(text, plan, dir = 'rx') {
  const s = String(text).trim();
  const m = s.match(/^(?:ch(?:annel)?|c)?\s*(\d{1,2})$/i);
  if (m) {
    const n = Number(m[1]);
    for (const hz of expandRanges(plan[dir])) if (Number((plan.name(hz).match(/\d+/) || [])[0]) === n) return hz;
    return null;
  }
  const num = Number(s);
  if (Number.isFinite(num) && num > 1e6) return Math.round(num);
  const hz = mhzToHz(s);
  return hz != null && hz >= 1e8 ? hz : null;
}

/** Text for one cell, as copied. */
export function cellText(ch, key, { plan, asm, tr = (s) => s }) {
  switch (key) {
    case 'slot': return `${ch.chType === 0 ? 'L' : 'C'}${String(ch.chNo + 1).padStart(2, '0')}`;
    case 'name': return ch.chName ?? '';
    case 'rx': return hzToMHz(ch.chRxFreq);
    case 'tx': return ch.chTxFreq === 0 ? '0' : hzToMHz(ch.chTxFreq);
    case 'mode': return tr(MODES.find(([k]) => k === txMode(ch, plan))[1]);
    case 'rxTone': return cssDecode(ch.chRxCss ?? 0, asm).label;
    case 'txTone': return cssDecode(ch.chTxCss ?? 0, asm).label;
    default: return '';
  }
}

/** Rows as tab-separated text with a header, ready for Excel. */
export function rowsToTsv(chans, opts) {
  const tr = opts.tr || ((s) => s);
  const lines = [COLUMNS.map((c) => tr(c.head)).join('\t')];
  for (const ch of chans) lines.push(COLUMNS.map((c) => cellText(ch, c.key, opts).replace(/[\t\n]/g, ' ')).join('\t'));
  return lines.join('\r\n') + '\r\n';
}

/**
 * Apply pasted cells to a channel. Blank cells leave a value unchanged. Mode is applied before TX, so a pasted
 * TX wins over a pasted mode. Returns the column keys whose text couldn't be understood.
 */
export function applyCells(ch, cells, { plan, asm, tr = (s) => s }) {
  const bad = [];
  const pri = { name: 0, rx: 1, mode: 2, tx: 3, rxTone: 4, txTone: 5 };
  for (const [key, raw] of Object.entries(cells).sort((a, b) => pri[a[0]] - pri[b[0]])) {
    const v = String(raw ?? '').trim();
    if (v === '' || !(key in pri)) continue;
    if (key === 'name') ch.chName = v;
    else if (key === 'rx') {
      const hz = parseFreq(v, plan, 'rx'); if (hz == null) { bad.push(key); continue; }
      const old = ch.chRxFreq; ch.chRxFreq = hz; followRx(ch, old, plan);
    } else if (key === 'tx') {
      if (/^(0|off|none|-|no|n\/a)$/i.test(v) || norm(v) === norm(tr('Listen only')) || norm(v) === 'listen only') { ch.chTxFreq = 0; continue; }
      const hz = parseFreq(v, plan, 'tx'); if (hz == null) { bad.push(key); continue; }
      ch.chTxFreq = hz;
    } else if (key === 'mode') {
      const n = norm(v);
      const m = MODES.find(([k, label]) => k !== 'custom' && (n === k || n === norm(label) || n === norm(tr(label)) || n.startsWith(k) || (k === 'repeater' && /^(dup|\+|rpt)/.test(n))));
      if (!m) { if (!MODES.some(([, l]) => n === norm(l) || n === norm(tr(l)))) bad.push(key); continue; }
      if (ch.chRxFreq != null) ch.chTxFreq = txForMode(m[0], ch.chRxFreq, plan);
    } else {
      const c = cssParse(/^(ctcss|tone)?\s*off$/i.test(v) || norm(v) === norm(tr('Off')) ? 'off' : v.replace(/\s*hz$/i, ''), asm);
      if (c == null) { bad.push(key); continue; }
      ch[key === 'rxTone' ? 'chRxCss' : 'chTxCss'] = c;
    }
  }
  return bad;
}
