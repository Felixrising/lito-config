// Printable one-page channel cheat sheet (A4). The radio's screen only shows C01, C02..., so this
// sheet tells people which CB channel each slot is and what it is for.

import { t, getLang } from './i18n.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mhz = (hz) => (hz / 1e6).toFixed(hz % 5000 ? 5 : 4);

// AU/NZ UHF CB channel number for a frequency, or 0.
function auCh(hz) {
  for (let n = 1; n <= 80; n++) {
    const f = n <= 40 ? 476425000 + (n - 1) * 25000 : 476437500 + (n - 41) * 25000;
    if (f === hz) return n;
  }
  return 0;
}
const AU_USE = { 5: 'Emergency', 35: 'Emergency', 11: 'Calling channel', 40: 'Highway', 18: 'Caravans', 10: '4WD clubs', 22: 'Data only', 23: 'Data only' };

/** One row per channel: slot, channel, name, frequency, tone, notes. */
export function cheatRows(channels, { plan, toneLabel = () => '' } = {}) {
  const au = !plan || plan.id === 'au' || plan.id === 'nz';
  return channels.map((c) => {
    const rx = c.chRxFreq, tx = c.chTxFreq;
    const n = au ? auCh(rx) : 0;
    const notes = [];
    if (au && n) {
      if (AU_USE[n]) notes.push(AU_USE[n]);
      if ((n <= 8 || (n >= 41 && n <= 48)) && tx && tx !== rx + 750000) notes.push('Rpt ch, simplex');
      if ((n >= 31 && n <= 38) || (n >= 71 && n <= 78)) notes.push('Rpt input');
      if (n >= 61 && n <= 63) notes.push('Reserved');
    }
    if (!tx) notes.push('Listen only');
    else if (au && n && (n <= 8 || (n >= 41 && n <= 48)) && tx === rx + 750000) notes.push('Repeater');
    else if (tx !== rx) notes.push(['TX {f}', mhz(tx)]);
    const tl = (v) => { const t = v ? String(toneLabel(v)) : ''; return /^\d+(\.\d+)?$/.test(t) ? `${t} Hz` : t; };
    const cls = notes.some((x) => /^Emergency/.test(x)) ? 'em' : notes.some((x) => /^(Data only|Reserved|Listen only)$/.test(x)) ? 'mute' : '';
    const rt = tl(c.chRxCss), tt = tl(c.chTxCss);
    const tone = rt === tt ? rt : [tt && `TX ${tt}`, rt && `RX ${rt}`].filter(Boolean).join(' / ');
    const chLabel = au ? (n ? `CH${n}` : '') : (plan?.name(rx) || '');
    return { slot: `C${String(c.chNo + 1).padStart(2, '0')}`, ch: chLabel, name: c.chName, freq: mhz(rx), tone, cls, notes: notes.map((x) => (Array.isArray(x) ? t(x[0], { f: x[1] }) : t(x))).join('; ') };
  });
}

/** A complete, self-contained HTML page sized for one A4 sheet. */
export function cheatSheetHtml({ title, subtitle = '', channels, plan, toneLabel }) {
  const rows = cheatRows(channels, { plan, toneLabel });
  const split = rows.length > 24 ? Math.ceil(rows.length / 2) : rows.length;
  const halves = split < rows.length ? [rows.slice(0, split), rows.slice(split)] : [rows];
  const dense = rows.length > 40 ? ' dense' : rows.length <= 24 ? ' roomy' : '';
  const hasTone = rows.some((r) => r.tone);
  const table = (list) => `<table><thead><tr><th>${t('Slot')}</th><th>${t('Ch')}</th><th>${t('Name')}</th><th>MHz</th>${hasTone ? `<th>${t('Tone')}</th>` : ''}<th>${t('Notes')}</th></tr></thead><tbody>${
    list.map((r) => `<tr${r.cls ? ` class="${r.cls}"` : ''}><td class="slot">${esc(r.slot)}</td><td>${esc(r.ch)}</td><td>${esc(r.name)}</td><td class="num">${esc(r.freq)}</td>${hasTone ? `<td>${esc(r.tone)}</td>` : ''}<td class="notes">${esc(r.notes)}</td></tr>`).join('')
  }</tbody></table>`;
  const date = new Date().toLocaleDateString(getLang(), { day: 'numeric', month: 'short', year: 'numeric' });
  return `<!DOCTYPE html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${esc(title)} - ${t('Cheat sheet')}</title><style>
@page { size: A4 portrait; margin: 10mm; }
* { box-sizing: border-box; }
html { background: #1b1d21; }
body { font: 9pt/1.25 system-ui, "Segoe UI", Arial, sans-serif; color: #111; margin: 0; }
.page { background: #fff; width: 210mm; min-height: 297mm; margin: 12px auto; padding: 10mm; }
.bar { display: flex; gap: 8px; justify-content: center; margin: 12px; }
.bar button { font: inherit; font-size: 11pt; padding: 6px 14px; border-radius: 6px; border: 1px solid #555; background: #2b6cb0; color: #fff; cursor: pointer; }
.bar button.alt { background: #333; }
header { display: flex; justify-content: space-between; align-items: flex-end; border-bottom: 2px solid #111; padding-bottom: 2mm; margin-bottom: 3mm; }
h1 { font-size: 15pt; margin: 0; } .sub { color: #444; font-size: 9pt; }
.meta { text-align: right; font-size: 8.5pt; color: #333; } .meta .line { display: inline-block; width: 45mm; border-bottom: 1px solid #888; }
.cols { display: flex; gap: 4mm; align-items: flex-start; } .cols > table { flex: 1; }
table { border-collapse: collapse; width: 100%; }
th { text-align: left; font-size: 7.5pt; text-transform: uppercase; letter-spacing: .03em; border-bottom: 1px solid #111; padding: 1mm 1.2mm; }
td { padding: 1mm 1.2mm; border-bottom: 1px solid #ddd; vertical-align: top; }
.roomy { font-size: 11pt; } .roomy td { padding: 1.8mm 2mm; }
.dense td { padding: .55mm 1mm; font-size: 8pt; } .dense th { padding: .6mm 1mm; }
tbody tr:nth-child(even) td { background: #f4f5f7; }
td.slot { font-weight: 700; font-family: ui-monospace, Consolas, monospace; } td.num { font-family: ui-monospace, Consolas, monospace; white-space: nowrap; }
td.notes { color: #333; font-size: .92em; white-space: normal; } td { white-space: nowrap; }
tr.em td { background: #fde8e8 !important; font-weight: 600; } tr.mute td { color: #888; }
footer { margin-top: 3mm; font-size: 7.5pt; color: #555; border-top: 1px solid #bbb; padding-top: 1.5mm; }
@media print { html { background: #fff; } .bar { display: none; } .page { margin: 0; width: auto; min-height: 0; padding: 0; }
  tr { break-inside: avoid; } * { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>
<div class="bar"><button onclick="print()">${t('Print or save as PDF')}</button><button class="alt" onclick="close()">${t('Close')}</button></div>
<div class="page${dense}">
<header><div><h1>${esc(title)}</h1><div class="sub">${esc(subtitle)}</div></div>
<div class="meta">${t('{n} channels', { n: rows.length })} · ${esc(date)}<br><br>${t('Radio')}: <span class="line"></span></div></header>
<div class="cols">${halves.map(table).join('')}</div>
<footer>${t('The radio screen shows the slot (C01, C02...), not the name. Tone: the radio only hears others using the same tone, so everyone in the group needs the same setting.')}
${plan && (plan.id === 'au' || plan.id === 'nz') ? ' ' + t('CH5 and CH35 are for emergencies only. CH22 and CH23 are data only, no voice.') : ''} ${t('Check channels are legal where you use them.')}</footer>
</div></body></html>`;
}
