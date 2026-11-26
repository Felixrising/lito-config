// Editor model, config file format (JSON), CSV export/import, and radio diffing.
// "Editor channels" are SEAL_ChannelInfo objects with chName as a JS string.

import { bytesToName, nameToBytes, isAsciiName, hzToMHz, mhzToHz, cssDecode, cssParse, DEFAULT_ASSUMPTIONS } from './values.js';
import { toHex, fromHex } from './frame.js';
import { SEAL_CHTYPE, SEAL_SWITCH, enumName } from './schema.js';

export const FILE_FORMAT = 'beebest-lito-config';
export const FILE_VERSION = 1;

// The official app counts name length as ASCII = 1 and any other character = 3, max 18.
export const nameUnits = (n) => [...(n || '')].reduce((t, ch) => t + (ch.charCodeAt(0) < 128 ? 1 : 3), 0);

export const CHANNEL_FIELDS = ['chNo', 'chType', 'chTxPower', 'chRxFreq', 'chTxFreq', 'chName', 'chSq', 'chVox',
  'chRxCss', 'chTxCss', 'chElim', 'chBand', 'chPolite', 'chPowerLevel'];

export function toEditor(ch) {
  const e = {};
  for (const k of CHANNEL_FIELDS) if (ch[k] !== undefined) e[k] = k === 'chName' ? bytesToName(ch[k]) : ch[k];
  if (ch._unknown) e._unknown = ch._unknown;
  return e;
}

export function fromEditor(e) {
  const ch = {};
  for (const k of CHANNEL_FIELDS) if (e[k] !== undefined && e[k] !== null && e[k] !== '') ch[k] = k === 'chName' ? nameToBytes(e[k]) : e[k];
  if (e._unknown) ch._unknown = e._unknown;
  return ch;
}

function canon(e) {
  const o = {};
  for (const k of CHANNEL_FIELDS) if (e[k] !== undefined && e[k] !== null && e[k] !== '') o[k] = e[k];
  return JSON.stringify(o);
}
export const sameChannel = (a, b) => canon(a) === canon(b);

/**
 * @param {Map<number, object>} snapshot  editor channels last read from the radio, by chNo
 * @param {Array<{ch: object, deleted?: boolean}>} rows  current editor rows
 */
export function diffChannels(snapshot, rows) {
  const deletes = [], modifies = [], inserts = [];
  const live = new Set();
  for (const r of rows) {
    const no = r.ch.chNo;
    if (r.deleted) { if (snapshot.has(no)) deletes.push(snapshot.get(no)); continue; }
    live.add(no);
    const orig = snapshot.get(no);
    if (!orig) inserts.push(r.ch);
    else if (!sameChannel(orig, r.ch)) modifies.push(r.ch);
  }
  return { deletes, modifies, inserts };
}

export function rowStatus(snapshot, row) {
  const orig = snapshot.get(row.ch.chNo);
  if (row.deleted) return orig ? 'delete' : 'drop';
  if (!orig) return 'insert';
  return sameChannel(orig, row.ch) ? 'same' : 'modify';
}

/** Problems that would make a write unsafe: [{chNo, msg}] */
export function validate(rows, a = DEFAULT_ASSUMPTIONS) {
  const errs = [], seen = new Set();
  const users = rows.filter((r) => !r.deleted && r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC).length;
  const max = a.maxUserChannels ?? 60;
  if (users > max) errs.push({ chNo: '-', msg: `${users} channels, but the radio holds at most ${max} (see Max custom channels)` });
  for (const r of rows) {
    if (r.deleted) continue;
    const c = r.ch;
    if (!Number.isInteger(c.chNo) || c.chNo < 0) errs.push({ chNo: c.chNo, msg: 'channel number missing' });
    else if (seen.has(c.chNo)) errs.push({ chNo: c.chNo, msg: 'duplicate channel number' });
    seen.add(c.chNo);
    if (!c.chRxFreq) errs.push({ chNo: c.chNo, msg: 'RX frequency missing' });
    if (c.chTxFreq == null) errs.push({ chNo: c.chNo, msg: 'TX frequency missing' }); // 0 = listen only (experimental)
    if (!isAsciiName(c.chName)) errs.push({ chNo: c.chNo, msg: 'name must be plain ASCII (the radio uses GBK, which the browser cannot encode)' });
    if (nameUnits(c.chName) > a.nameMaxBytes) errs.push({ chNo: c.chNo, msg: `name longer than ${a.nameMaxBytes} characters` });
  }
  return errs;
}

function unknownToJson(u) { return u?.map((x) => ({ ...x, value: x.value instanceof Uint8Array ? { hex: toHex(x.value) } : x.value })); }
function unknownFromJson(u) { return u?.map((x) => ({ ...x, value: x.value && x.value.hex !== undefined ? fromHex(x.value.hex) : x.value })); }

export function buildConfigFile({ device, country, channels, assumptions, radioName }) {
  const dev = device ? Object.fromEntries(Object.entries(device).filter(([k]) => !['ch', '_unknown', 'result', 'fullInquiry'].includes(k))
    .map(([k, v]) => [k, v instanceof Uint8Array ? bytesToName(v) : v])) : undefined;
  return {
    format: FILE_FORMAT, formatVersion: FILE_VERSION, savedAt: new Date().toISOString(), app: 'lito-web 0.1',
    radioName, country, device: dev, assumptions,
    channels: channels.map((c) => ({ ...c, _unknown: unknownToJson(c._unknown) })),
  };
}

export function parseConfigFile(text) {
  const j = JSON.parse(text);
  if (j.format !== FILE_FORMAT) throw new Error('This is not a LITO config file.');
  if (j.formatVersion > FILE_VERSION) throw new Error(`File was saved by a newer version (format ${j.formatVersion}).`);
  const channels = (j.channels || []).map((c) => {
    const e = {};
    for (const k of CHANNEL_FIELDS) if (c[k] !== undefined) e[k] = c[k];
    if (c._unknown) e._unknown = unknownFromJson(c._unknown);
    return e;
  });
  return { ...j, channels };
}

const CSV_COLS = ['Channel', 'Type', 'Name', 'RxMHz', 'TxMHz', 'RxTone', 'TxTone', 'RxCssRaw', 'TxCssRaw',
  'Squelch', 'VOX', 'TxPower', 'PowerLevel', 'Band', 'Elim', 'Polite'];
const TYPE_NAMES = { 0: 'Public', 1: 'Remote', 2: 'User' };

function csvCell(v) { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export function channelsToCsv(channels, a = DEFAULT_ASSUMPTIONS) {
  const lines = [CSV_COLS.join(',')];
  const sw = (v) => (v == null ? '' : v === SEAL_SWITCH.SEAL_ON ? 'On' : 'Off');
  for (const c of channels) {
    lines.push([c.chNo, TYPE_NAMES[c.chType] ?? c.chType, c.chName, hzToMHz(c.chRxFreq), hzToMHz(c.chTxFreq),
      c.chRxCss == null ? '' : cssDecode(c.chRxCss, a).label, c.chTxCss == null ? '' : cssDecode(c.chTxCss, a).label,
      c.chRxCss, c.chTxCss, c.chSq, c.chVox, c.chTxPower, c.chPowerLevel, c.chBand, sw(c.chElim), sw(c.chPolite)].map(csvCell).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export function csvToChannels(text, a = DEFAULT_ASSUMPTIONS) {
  const [head, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const idx = Object.fromEntries(head.map((h, i) => [h.trim(), i]));
  if (idx.Channel === undefined || idx.RxMHz === undefined) throw new Error('CSV needs at least Channel and RxMHz columns.');
  const get = (r, k) => (idx[k] === undefined ? '' : (r[idx[k]] ?? '').trim());
  const num = (s) => (s === '' ? undefined : Number(s));
  const sw = (s) => (s === '' ? undefined : /^on|1|true|yes$/i.test(s) ? SEAL_SWITCH.SEAL_ON : SEAL_SWITCH.SEAL_OFF);
  return rows.map((r, n) => {
    const type = get(r, 'Type');
    const typeNo = Object.entries(TYPE_NAMES).find(([, v]) => v.toLowerCase() === type.toLowerCase())?.[0];
    const tone = (raw, label) => {
      if (get(r, raw) !== '') return Number(get(r, raw));
      if (get(r, label) === '') return undefined;
      const v = cssParse(get(r, label), a);
      if (v == null) throw new Error(`CSV row ${n + 2}: can't read tone "${get(r, label)}"`);
      return v;
    };
    const e = {
      chNo: num(get(r, 'Channel')), chType: typeNo !== undefined ? Number(typeNo) : (num(type) ?? SEAL_CHTYPE.SEAL_USERDEF),
      chName: get(r, 'Name'), chRxFreq: mhzToHz(get(r, 'RxMHz')) ?? undefined,
      chTxFreq: mhzToHz(get(r, 'TxMHz') || get(r, 'RxMHz')) ?? undefined,
      chRxCss: tone('RxCssRaw', 'RxTone'), chTxCss: tone('TxCssRaw', 'TxTone'),
      chSq: num(get(r, 'Squelch')), chVox: num(get(r, 'VOX')), chTxPower: num(get(r, 'TxPower')),
      chPowerLevel: num(get(r, 'PowerLevel')), chBand: num(get(r, 'Band')), chElim: sw(get(r, 'Elim')), chPolite: sw(get(r, 'Polite')),
    };
    for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
    return e;
  });
}

export const chTypeName = (t) => TYPE_NAMES[t] ?? enumName(SEAL_CHTYPE, t);

/**
 * The radio keeps custom channels as a packed list: deleting a slot moves every later channel down
 * one (seen on a real LITO). So the target list must be numbered 0..N-1 with no gaps. This renumbers
 * live user channels in their current order, and (given what's on the radio) marks every radio slot
 * past the end for deletion. Returns true if any channel was renumbered.
 * @param {Map<number, object>} [snapshot]  user channels on the radio, by slot
 */
export function compactUserChannels(rows, snapshot = new Map()) {
  const isUser = (c) => c.chType !== SEAL_CHTYPE.SEAL_PUBLIC;
  const live = rows.filter((r) => !r.deleted && isUser(r.ch)).sort((a, b) => a.ch.chNo - b.ch.chNo);
  let moved = false;
  live.forEach((r, i) => { if (r.ch.chNo !== i) { r.ch = { ...r.ch, chNo: i }; moved = true; } });
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].deleted && isUser(rows[i].ch)) rows.splice(i, 1);
  for (const [no, c] of snapshot) if (isUser(c) && no >= live.length) rows.push({ ch: c, deleted: true });
  return moved;
}
