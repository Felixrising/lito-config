import { LitoClient } from '../lito/client.js';
import { WebBluetoothTransport } from '../lito/ble.js';
import { SimulatedRadio } from '../lito/simulator.js';
import { SEAL_SWITCH, SEAL_CHTYPE, SEAL_VOICETYPE, CMD_MESSAGE, cmdName } from '../lito/schema.js';
import { codec } from '../lito/client.js';
import { DEFAULT_ASSUMPTIONS, hzToMHz, mhzToHz, cssDecode, cssParse, cssOptions, bytesToName, nameToBytes } from '../lito/values.js';
import { toHex, fromHex } from '../lito/frame.js';
import { PRESETS, buildPreset } from '../lito/presets.js';
import { cheatSheetHtml } from './cheatsheet.js';
import * as ambience from './ambience.js';
import { BAND_PLANS, expandRanges, planForCountry } from '../lito/bands.js';
import { applyConfig, summarize, CLONEABLE_SETTINGS } from '../lito/sync.js';
import {
  toEditor, diffChannels, rowStatus, validate, buildConfigFile, parseConfigFile, compactUserChannels,
  channelsToCsv, csvToChannels, fromEditor,
} from '../lito/configfile.js';

const $ = (s) => document.querySelector(s);
// Copy each column heading onto its cells so the phone layout can show rows as labelled cards.
function labelCells(table) {
  const heads = [...table.querySelectorAll(':scope > thead th')].map((th) => th.textContent.trim());
  for (const tr of table.querySelectorAll(':scope > tbody > tr:not(.detail)')) [...tr.children].forEach((td, i) => { td.dataset.label = heads[i] || ''; });
}
const ASM_KEY = 'lito.assumptions.v1';
// The official app remembers the deviceId each radio gives on connect and sends it back next time
// so the radio skips the "accept connection?" prompt (confirmed on a real LITO 2026-11-26).
const ID_KEY = 'lito.deviceIds.v1';
const radioKey = (t) => t.device?.id || t.name || '';
function storedDeviceId(t) { try { return JSON.parse(localStorage.getItem(ID_KEY) || '{}')[radioKey(t)]; } catch { return undefined; } }
function rememberDeviceId(t, reply) {
  if (reply?.deviceId == null || !radioKey(t) || t.name === 'Simulator') return;
  try { const m = JSON.parse(localStorage.getItem(ID_KEY) || '{}'); m[radioKey(t)] = reply.deviceId; localStorage.setItem(ID_KEY, JSON.stringify(m)); } catch { /* ignore */ }
}

const state = {
  client: null,
  radioName: '',
  device: null,          // last SEAL_DeviceParam read
  country: null,
  snapshot: new Map(),   // chNo -> editor channel as last read/written on the radio
  haveSnapshot: false,
  rows: [],              // [{ch, deleted, sel}]
  log: [],
  asm: loadAssumptions(),
  busy: false,
};

function loadAssumptions() {
  // Tone encoding is confirmed now, so it always uses the built-in values, whatever was saved earlier.
  const FIXED = ['cssTypeCtcss', 'cssTypeDcsN', 'cssTypeDcsI', 'cssIndexBase', 'editLocked'];
  try {
    const saved = JSON.parse(localStorage.getItem(ASM_KEY) || '{}');
    for (const k of FIXED) delete saved[k];
    return { ...DEFAULT_ASSUMPTIONS, ...saved };
  }
  catch { return { ...DEFAULT_ASSUMPTIONS }; }
}

// ---------- UI helpers ----------
function banner(msg, kind = '') {
  const b = $('#banner');
  if (!msg) { b.className = 'banner hidden'; return; }
  b.className = `banner ${kind}`; $('#bannerText').textContent = msg;
  if (kind === 'ok') setTimeout(() => { if ($('#bannerText').textContent === msg) banner(''); }, 6000);
}
$('#bannerClose').onclick = () => banner('');
function setStatus(text, cls) { const s = $('#connStatus'); s.textContent = text; s.className = `pill ${cls}`; }
function connected() { return !!state.client; }
function refreshButtons() {
  const c = connected(), b = state.busy;
  // one button toggles between Connect and Disconnect
  const bc = $('#btnConnect');
  bc.dataset.connectTip ??= bc.title;
  setLabel(bc, c ? 'Disconnect' : 'Connect radio', c ? 'Disconnect from the radio' : bc.dataset.connectTip);
  bc.classList.toggle('primary', !c);
  bc.disabled = b && !c;
  $('#btnDemo').disabled = c || b;
  for (const id of ['#btnReadCh', '#btnWriteCh', '#btnReadDev', '#btnWriteDev', '#btnRawSend', '#btnProbe', '#btnSlotTest', '#btnSlotDelete', '#btnLimitClean', '#btnTxOffTest', '#btnTxOffDelete']) $(id).disabled = !c || b;
  renderFleet?.();
}
async function busy(label, fn) {
  if (state.busy) return;
  state.busy = true; refreshButtons(); setStatus(label, 'busy');
  try { return await fn(); }
  catch (e) { console.error(e); banner(e.message || String(e), 'error'); }
  finally {
    state.busy = false; refreshButtons();
    if (connected()) setStatus(`Connected: ${state.radioName}`, 'on'); else setStatus('Not connected', 'off');
  }
}

// tabs
for (const t of document.querySelectorAll('.tabs button')) {
  t.onclick = () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === t));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${t.dataset.tab}`));
  };
}

// ---------- log ----------
function logEntry(e) {
  state.log.push({ t: new Date().toISOString(), ...e, hex: e.raw ? toHex(e.raw) : undefined });
  if (state.log.length > 5000) state.log.shift();
  renderLogEntry(state.log[state.log.length - 1]);
}
function jsonable(v) {
  return JSON.stringify(v, (k, x) => (x instanceof Uint8Array ? `bytes(${toHex(x)}) "${bytesToName(x)}"` : x), 2);
}
function renderLogEntry(e) {
  const el = document.createElement('div');
  el.className = `e ${e.dir}`;
  const head = e.dir === 'err' ? `ERROR ${e.text}` : e.dir === 'note' ? `NOTE ${e.text}` : `${e.dir.toUpperCase()} ${cmdName(e.cmd)} (${e.cmd}) seq ${e.seq}`;
  el.innerHTML = `<div class="d"></div><div class="h"></div>${e.msg && $('#logDecoded').checked ? '<pre></pre>' : ''}`;
  el.querySelector('.d').textContent = `${e.t.slice(11, 23)}  ${e.radio ? '[' + e.radio + '] ' : ''}${head}`;
  el.querySelector('.h').textContent = e.hex || '';
  if (el.querySelector('pre')) el.querySelector('pre').textContent = jsonable(e.msg);
  const log = $('#log'); log.appendChild(el); log.scrollTop = log.scrollHeight;
}
$('#btnClearLog').onclick = () => { state.log = []; $('#log').innerHTML = ''; };
$('#btnSaveLog').onclick = () => download(`lito-log-${stamp()}.json`, JSON.stringify(state.log, (k, x) => (x instanceof Uint8Array ? toHex(x) : x), 2), 'application/json');
$('#logDecoded').onchange = () => { $('#log').innerHTML = ''; state.log.forEach(renderLogEntry); };

// ---------- theme ----------
// The Kobayashi console theme renames the main buttons for fun; hovering shows the plain name.
const FUN_LABELS = {
  'Read from radio': 'Scan for lifeforms', 'Write to radio': 'Make it so', 'Connect radio': 'Open hailing frequencies',
  'Disconnect': 'Close channel', 'Demo radio': 'Training simulation', 'Read settings': 'Run diagnostics', 'Save to radio': 'Commit to core',
  'Add channel': 'New frequency', 'Delete selected': 'Jettison selected', 'Undo all edits': 'Reverse course', 'Presets…': 'Flight plans…',
  'Backup…': 'Store in archive…', 'Restore…': 'Retrieve from archive…', 'Cheat sheet': 'Crew briefing', 'Export CSV': 'Export star chart',
  'Write Radios': 'Engage', 'Back up ticked radios': 'Archive the fleet', 'Add radio…': 'Recruit a vessel…', 'Load backup…': 'Retrieve from archive…',
  'Overwrite Channels': 'Overwrite databanks', 'Append to Channels': 'Append to databanks', 'Cancel': 'Belay that', '♪ Ambience': '♪ Engines', '♪ Ambience on': '♪ Engines online',
};
const funOn = () => document.documentElement.dataset.theme === 'console';
/** Set a button's text (and optionally its tooltip), applying the console theme's label when it is on. */
function setLabel(el, plain, tip = el.dataset.tip ?? el.title) {
  el.dataset.plain = plain; el.dataset.tip = tip;
  const fun = funOn() && FUN_LABELS[plain];
  el.textContent = fun || plain;
  el.title = fun ? `${plain.replace(/…$/, '')}${tip ? '. ' + tip : ''}` : tip;
}
function applyFunLabels() {
  for (const el of document.querySelectorAll('button')) {
    const plain = el.dataset.plain ?? el.textContent.trim();
    if (el.dataset.plain || FUN_LABELS[plain]) setLabel(el, plain);
  }
}
$('#themeSel').value = document.documentElement.dataset.theme || '';
applyFunLabels();
$('#themeSel').onchange = (e) => {
  const t = e.target.value;
  if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { if (t) localStorage.setItem('lito.theme', t); else localStorage.removeItem('lito.theme'); } catch { /* private mode */ }
  applyFunLabels();
  if (t !== 'console' && ambience.isPlaying()) toggleAmbience(false, false);
  else if (t === 'console' && ambOn()) toggleAmbience(true, false); // picking the theme is a click, so audio may start
};
// ship's ambience (console theme only). On by default at 80%; browsers block sound until the first click or key,
// so it is armed and starts on the first interaction. The button mutes it and remembers that.
const AMB_KEY = 'lito.amb';
const ambOn = () => { try { return localStorage.getItem(AMB_KEY) !== 'off'; } catch { return true; } };
try { $('#ambVol').value = localStorage.getItem('lito.ambVol') ?? '0.8'; } catch { /* ignore */ }
async function toggleAmbience(on, remember = true) {
  const b = $('#btnAmbience');
  if (remember) try { localStorage.setItem(AMB_KEY, on ? 'on' : 'off'); } catch { /* ignore */ }
  try { if (on) await ambience.start(Number($('#ambVol').value)); else await ambience.stop(); }
  catch (e) { banner(`Ambience: ${e.message}`, 'error'); on = false; }
  b.setAttribute('aria-pressed', String(on));
  setLabel(b, on ? '♪ Ambience on' : '♪ Ambience', on ? 'Press to mute the engines' : 'Play a quiet engine hum, made live in your browser');
}
$('#btnAmbience').onclick = (e) => { e.stopPropagation(); toggleAmbience(!ambience.isPlaying()); };
const armAmbience = (e) => {
  if (e.target?.closest?.('#btnAmbience, #ambVol')) return; // those controls handle themselves
  if (document.documentElement.dataset.theme === 'console' && ambOn() && !ambience.isPlaying()) toggleAmbience(true, false);
};
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, armAmbience, { capture: true });
$('#ambVol').oninput = (e) => { if (!ambience.isPlaying() && ambOn()) toggleAmbience(true, false); ambience.setVolume(Number(e.target.value)); try { localStorage.setItem('lito.ambVol', e.target.value); } catch { /* ignore */ } };

// ---------- connect ----------
async function connectWith(transport, name) {
  const client = new LitoClient(transport, state.asm);
  client.on('frame', logEntry);
  client.on('error', (err, raw) => logEntry({ dir: 'err', text: err.message, raw }));
  client.on('unsolicited', (f) => {
    // the radio pushes cmd 20008 (channel state) when the current channel changes; ch1 = current channel
    if (f.cmd === 20008 && f.msg?.ch1 && state.client === client) { state.currentCh = f.msg.ch1; renderDevice(); }
  });
  client.on('disconnect', () => {
    if (state.client === client) { state.client = null; setStatus('Not connected', 'off'); refreshButtons(); banner('Radio disconnected.', 'error'); }
  });
  await client.open();
  state.radioName = transport.name || name;
  const hs = await client.handshake({ deviceId: storedDeviceId(transport), onWait: () => { setStatus('Confirm on the radio…', 'busy'); banner('The radio is asking for confirmation. Accept the connection on the radio.'); } });
  rememberDeviceId(transport, hs);
  state.client = client;
  banner(`Connected to ${state.radioName}.`, 'ok');
  await readDevice();
}

$('#btnConnect').onclick = () => (connected() ? disconnect() : connectRadio());
const connectRadio = () => busy('Connecting…', async () => {
  if (!WebBluetoothTransport.available()) throw new Error('This browser has no Web Bluetooth. Open the app in Chrome or Edge from http://localhost (run start.cmd) or https.');
  await connectWith(new WebBluetoothTransport({ acceptAll: $('#acceptAll').checked }), 'LITO');
});
$('#btnDemo').onclick = () => busy('Connecting…', async () => {
  const sim = new SimulatedRadio({ requireConfirm: true });
  await connectWith(sim.transport(), 'Simulator');
  banner('Connected to a simulated radio (demo mode). Nothing here touches a real radio.', 'ok');
});
async function disconnect() {
  const c = state.client; state.client = null; refreshButtons(); setStatus('Not connected', 'off');
  try { await c?.close(); } catch { /* ignore */ }
};

// ---------- device ----------
const sw = (v) => v === SEAL_SWITCH.SEAL_ON;
function fmtVer(v) {
  if (v == null) return '—';
  const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  while (b.length > 2 && b[0] === 0) b.shift();
  return `${v} (0x${v.toString(16).toUpperCase()}, maybe v${b.join('.')})`;
}
function renderDevice() {
  const d = state.device;
  if (!d) return;
  $('#f_deviceName').value = bytesToName(d.deviceName);
  $('#f_bleName').value = bytesToName(d.bleName);
  $('#f_voiceType').value = String(d.voiceType ?? SEAL_VOICETYPE.SEAL_VOICETYPE_CLOSE);
  $('#f_voiceAlert').checked = sw(d.voiceAlert);
  $('#f_shareLoc').checked = sw(d.shareLoc);
  $('#f_pwsaveMode').value = d.pwsaveMode ?? '';
  const cc = (d.ch && typeof d.ch === 'object') ? d.ch : {};
  $('#f_chSq').value = cc.chSq != null ? String(cc.chSq) : '';
  if (cc.chSq != null && ![...$('#f_chSq').options].some((o) => o.value === String(cc.chSq))) {
    const o = document.createElement('option'); o.value = String(cc.chSq); o.textContent = `raw ${cc.chSq}`; $('#f_chSq').appendChild(o); $('#f_chSq').value = String(cc.chSq);
  }
  for (const [id, k] of [['#f_chVox', 'chVox'], ['#f_chBand', 'chBand'], ['#f_chPolite', 'chPolite']]) {
    const el = $(id), v = cc[k] != null ? String(cc[k]) : '';
    if (v && ![...el.options].some((o) => o.value === v)) { const o = document.createElement('option'); o.value = v; o.textContent = `raw ${v}`; el.appendChild(o); }
    el.value = v;
  }
  const ch = state.currentCh || (d.ch && (typeof d.ch === 'object' ? d.ch : { chNo: d.ch }));
  const info = [
    ['Connected to', state.radioName],
    ['Hardware version', fmtVer(d.verHw)],
    ['Firmware version', fmtVer(d.verSoft)],
    ['Battery (charge)', d.charge != null ? `${d.charge}` : '—'],
    ['Activated', d.activate ?? '—'],
    ['BT audio', d.btAudio ?? '—'],
    ['All channels public', d.isAllPublic != null ? (sw(d.isAllPublic) ? 'yes' : 'no') : '—'],
    ['Current channel', ch && ch.chNo == null ? 'not reported (the radio only sends that channel\'s squelch/VOX settings)' : ch ? `${ch.chNo == null ? '?' : (ch.chType === SEAL_CHTYPE.SEAL_PUBLIC ? 'L' : 'C') + String(ch.chNo + 1).padStart(2, '0')}${ch.chRxFreq ? ' · ' + hzToMHz(ch.chRxFreq) + ' MHz' : ''}${ch.chName ? ' · ' + bytesToName(ch.chName) : ''}` : '—'],
    ['Region', typeof state.country === 'number' ? `${planForCountry(state.country)?.label ?? 'unknown'} (country code ${state.country})` : (state.country ?? '—')],
  ];
  if (d._unknown) info.push(['Unknown fields', jsonable(d._unknown)]);
  $('#devInfo').innerHTML = '';
  for (const [k, v] of info) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    $('#devInfo').append(dt, dd);
  }
}
async function readDevice() {
  state.device = await state.client.getDeviceParams();
  try { state.country = (await state.client.getCountry()).country; } catch (e) { state.country = `not read (${e.message})`; }
  const plan = typeof state.country === 'number' && planForCountry(state.country);
  if (plan && plan.id !== $('#bandPlan').value) setPlan(plan.id);
  state.currentCh = null;
  try { const st = await state.client.getChannelState(); if (st?.ch1) state.currentCh = st.ch1; } catch { /* radio may only push this unsolicited */ }
  renderDevice();
}
function deviceChanges() {
  const d = state.device || {}, c = {};
  const name = $('#f_deviceName').value, ble = $('#f_bleName').value;
  if (name !== bytesToName(d.deviceName)) c.deviceName = nameToBytes(name);
  if (ble !== bytesToName(d.bleName)) c.bleName = nameToBytes(ble);
  const vt = Number($('#f_voiceType').value); if (vt !== d.voiceType) c.voiceType = vt;
  const va = $('#f_voiceAlert').checked ? SEAL_SWITCH.SEAL_ON : SEAL_SWITCH.SEAL_OFF; if (va !== (d.voiceAlert ?? SEAL_SWITCH.SEAL_OFF)) c.voiceAlert = va;
  const sl = $('#f_shareLoc').checked ? SEAL_SWITCH.SEAL_ON : SEAL_SWITCH.SEAL_OFF; if (sl !== (d.shareLoc ?? SEAL_SWITCH.SEAL_OFF)) c.shareLoc = sl;
  const pm = $('#f_pwsaveMode').value; if (pm !== '' && Number(pm) !== d.pwsaveMode) c.pwsaveMode = Number(pm);
  // squelch / VOX / band / busy lockout are radio-wide and sent inside DeviceParam.ch (as the app does)
  const cc = (d.ch && typeof d.ch === 'object') ? d.ch : {};
  const want = { chSq: $('#f_chSq').value, chVox: $('#f_chVox').value, chBand: $('#f_chBand').value, chPolite: $('#f_chPolite').value };
  const chChanged = Object.entries(want).some(([k, v]) => v !== '' && Number(v) !== cc[k]);
  if (chChanged) {
    c.ch = {};
    for (const [k, v] of Object.entries(want)) { const n = v !== '' ? Number(v) : cc[k]; if (n != null) c.ch[k] = n; }
  }
  return c;
}
$('#btnReadDev').onclick = () => busy('Reading…', async () => { await readDevice(); banner('Settings read.', 'ok'); });
$('#btnWriteDev').onclick = () => busy('Writing…', async () => {
  const c = deviceChanges();
  if (!Object.keys(c).length) { banner('No settings changed.'); return; }
  const list = Object.keys(c).map((k) => (k === 'ch' ? 'squelch/VOX/bandwidth/busy lockout' : k)).join(', ');
  if (!confirm(`Send these settings to the radio?\n\n${list}`)) return;
  await state.client.setDeviceParams(c);
  await readDevice();
  banner(`Saved: ${list}.`, 'ok');
});

// ---------- channels ----------
// One prebuilt tone <select>, cloned for every cell (about 200 options each).
let toneTemplate = null;
function toneOptions() {
  const sel = document.createElement('select'); sel.className = 'w-tone';
  const groups = { Off: sel, CTCSS: null, 'DCS normal': null, 'DCS inverted': null };
  for (const o of cssOptions(state.asm)) {
    const g = o.value === 0 ? 'Off' : o.label.startsWith('D') ? (o.label.endsWith('N') ? 'DCS normal' : 'DCS inverted') : 'CTCSS';
    if (!groups[g]) { groups[g] = document.createElement('optgroup'); groups[g].label = g; sel.appendChild(groups[g]); }
    const op = document.createElement('option'); op.value = String(o.value); op.textContent = o.label; groups[g].appendChild(op);
  }
  toneTemplate = sel;
}
function addRawOption(sel, v, label) {
  if (v == null || [...sel.options].some((o) => o.value === String(v))) return;
  const o = document.createElement('option'); o.value = String(v); o.textContent = label; sel.insertBefore(o, sel.firstChild);
}
function toneCell(row, field, disabled) {
  const sel = toneTemplate.cloneNode(true); sel.disabled = disabled;
  const v = row.ch[field];
  // Values like 256 or 512 also mean "off"; keep them as they are so an unchanged channel isn't rewritten.
  if (v != null) addRawOption(sel, v, toneLabel(v) === 'Off' ? 'Off' : `${toneLabel(v)} (raw ${v})`);
  sel.value = v == null ? '0' : String(v);
  sel.onchange = () => { row.ch[field] = Number(sel.value); renderRowStatus(row); };
  const td = document.createElement('td'); td.appendChild(sel); return td;
}
// ---------- frequency dropdowns ----------
const PLAN_KEY = 'lito.bandplan';
for (const p of BAND_PLANS) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.label; $('#bandPlan').appendChild(o); }
$('#bandPlan').value = localStorage.getItem(PLAN_KEY) || 'au';
function setPlan(id) { $('#bandPlan').value = id; localStorage.setItem(PLAN_KEY, id); for (const k in freqTemplates) delete freqTemplates[k]; renderTable(); }
$('#bandPlan').onchange = () => setPlan($('#bandPlan').value);
const currentPlan = () => BAND_PLANS.find((p) => p.id === $('#bandPlan').value) || BAND_PLANS[0];
const freqTemplates = {};
function freqCell(row, field, disabled) {
  const plan = currentPlan();
  const dir = field === 'chTxFreq' ? 'tx' : 'rx';
  if (!freqTemplates[dir]) {
    const t = document.createElement('select'); t.className = `w-freq ${dir}-freq`;
    for (const hz of expandRanges(plan[dir])) { const o = document.createElement('option'); o.value = String(hz); o.textContent = `${hzToMHz(hz)}  ${plan.name(hz)}`; t.appendChild(o); }
    if (dir === 'tx') { const o = document.createElement('option'); o.value = '0'; o.textContent = 'No transmit (listen only)'; o.title = 'Experimental: run the listen-only test on the Log tab first'; t.appendChild(o); }
    freqTemplates[dir] = t;
  }
  const sel = freqTemplates[dir].cloneNode(true); sel.disabled = disabled;
  const show = () => {
    const v = row.ch[field];
    if (v != null && ![...sel.options].some((o) => o.value === String(v))) {
      // Keep whatever the radio or file has, but flag it: the official app wouldn't allow it.
      const o = document.createElement('option'); o.value = String(v);
      o.textContent = v === 0 ? 'No transmit (listen only)' : `${hzToMHz(v)}  ${plan.name(v)} (not allowed)`.replace('  (', ' (');
      sel.insertBefore(o, sel.firstChild);
    }
    sel.value = v == null ? '' : String(v);
    sel.title = sel.selectedOptions[0]?.textContent.includes('not allowed') ? `The official app doesn't allow this ${dir.toUpperCase()} frequency for ${plan.label}` : '';
  };
  show();
  sel.onchange = () => {
    const hz = Number(sel.value), old = row.ch[field];
    row.ch[field] = hz;
    // Simplex channel: changing RX moves TX with it, if TX may use that frequency.
    if (field === 'chRxFreq' && row.ch.chTxFreq === old && expandRanges(plan.tx).includes(hz)) {
      row.ch.chTxFreq = hz; const t = row.tr.querySelector('select.tx-freq'); if (t) t.replaceWith(freqCell(row, 'chTxFreq', disabled).firstChild);
    }
    show(); renderRowStatus(row);
  };
  const td = document.createElement('td'); td.appendChild(sel); return td;
}
const SQ_OPTS = [['1', 'Normal'], ['2', 'Sensitive']];
const VOX_OPTS = [['0', 'Off'], ['1', 'Low'], ['2', 'Middle'], ['3', 'High']];
const BAND_OPTS = [['0', 'Wide'], ['1', 'Narrow']];
function selectCell(row, field, opts, disabled) {
  const sel = document.createElement('select'); sel.disabled = disabled;
  const blank = document.createElement('option'); blank.value = ''; blank.textContent = '–'; sel.appendChild(blank);
  for (const [v, l] of opts) { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); }
  const v = row.ch[field];
  if (v != null && !opts.some(([x]) => x === String(v))) { const o = document.createElement('option'); o.value = String(v); o.textContent = `raw ${v}`; sel.appendChild(o); }
  sel.value = v == null ? '' : String(v);
  sel.onchange = () => { if (sel.value === '') delete row.ch[field]; else row.ch[field] = Number(sel.value); renderRowStatus(row); };
  const td = document.createElement('td'); td.appendChild(sel); return td;
}
const locked = (ch) => ch.chType === SEAL_CHTYPE.SEAL_PUBLIC && !state.asm.editLocked;

function cellInput(row, field, cls, { get, set, disabled, list, type = 'text' }) {
  const inp = document.createElement('input');
  inp.className = cls; inp.type = type; inp.value = get(row.ch); inp.disabled = disabled;
  if (list) inp.setAttribute('list', list);
  inp.onchange = () => {
    const v = set(inp.value);
    if (v === null) { inp.classList.add('bad'); inp.title = 'Not a valid value'; return; }
    inp.classList.remove('bad'); inp.title = '';
    if (v === undefined) delete row.ch[field]; else row.ch[field] = v;
    renderRowStatus(row);
  };
  const td = document.createElement('td'); td.appendChild(inp); return td;
}
const numSet = (s) => (s.trim() === '' ? undefined : Number.isInteger(Number(s)) && Number(s) >= 0 ? Number(s) : null);
function switchCell(row, field, disabled) {
  const td = document.createElement('td');
  const cb = document.createElement('input'); cb.type = 'checkbox'; cb.disabled = disabled;
  cb.checked = row.ch[field] === SEAL_SWITCH.SEAL_ON;
  cb.onchange = () => { row.ch[field] = cb.checked ? SEAL_SWITCH.SEAL_ON : SEAL_SWITCH.SEAL_OFF; renderRowStatus(row); };
  td.appendChild(cb); return td;
}
function toneLabel(v) { return v == null ? '' : cssDecode(v, state.asm).label; }

const STATUS_TEXT = { same: '', insert: 'new', modify: 'changed', delete: 'will delete', drop: 'removed' };
function renderRowStatus(row) {
  const st = state.haveSnapshot ? rowStatus(state.snapshot, row) : (row.deleted ? 'drop' : 'insert');
  row.tr.className = `st-${st}`;
  row.tr.querySelector('.status').textContent = state.haveSnapshot ? STATUS_TEXT[st] : (row.deleted ? 'removed' : 'new');
  renderSummary();
}

function renderTable() {
  const tb = $('#chTable tbody'); tb.innerHTML = '';
  for (const row of state.rows) {
    if (row.deleted && !state.snapshot.has(row.ch.chNo)) continue;
    const tr = document.createElement('tr'); row.tr = tr;
    const lk = locked(row.ch) || row.deleted;
    const sel = document.createElement('td'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = !!row.sel;
    cb.onchange = () => { row.sel = cb.checked; }; sel.appendChild(cb); tr.appendChild(sel);
    // Slot is the position on the radio (C01, C02 …). The radio keeps a packed list, so it isn't edited directly.
    const tdNo = document.createElement('td'); tdNo.className = 'slot';
    tdNo.textContent = row.ch.chType === SEAL_CHTYPE.SEAL_PUBLIC ? `L${String(row.ch.chNo + 1).padStart(2, '0')}` : `C${String(row.ch.chNo + 1).padStart(2, '0')}`;
    tr.appendChild(tdNo);
    tr.appendChild(cellInput(row, 'chName', 'w-name', { get: (c) => c.chName ?? '', set: (s) => s, disabled: lk }));
    tr.appendChild(freqCell(row, 'chRxFreq', lk));
    tr.appendChild(freqCell(row, 'chTxFreq', lk));
    tr.appendChild(toneCell(row, 'chRxCss', lk));
    tr.appendChild(toneCell(row, 'chTxCss', lk));
    // Squelch/VOX/band/busy lockout are radio-wide (DeviceParam.ch); the radio doesn't report them per channel.
    const st = document.createElement('td'); st.className = 'status'; tr.appendChild(st);
    tb.appendChild(tr);
    renderRowStatus(row);
  }
  labelCells($('#chTable'));
  renderSummary();
}

function renderSummary() {
  renderFleetSetup?.();
  const live = state.rows.filter((r) => !r.deleted);
  if (!state.rows.length) { $('#chSummary').innerHTML = 'No channels loaded. Connect and press <b>Read from radio</b>, or press <b>Restore…</b> to load a backup.'; return; }
  const user = live.filter((r) => r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC).length;
  const max = 60;
  let s = `${user} of ${max} custom channels used.${user > max ? ` Too many: the radio holds ${max}.` : ''}`;
  if (state.haveSnapshot) {
    const d = diffChannels(state.snapshot, state.rows);
    const n = d.inserts.length + d.modifies.length + d.deletes.length;
    s += n ? ` Pending: ${d.inserts.length} new, ${d.modifies.length} changed, ${d.deletes.length} to delete.` : ' No unsaved changes.';
  } else s += ' Not compared with a radio yet.';
  $('#chSummary').textContent = s;
}

function setRowsFromRadio(chans) {
  state.setupSource = `radio ${state.radioName}`;
  state.snapshot = new Map(chans.map((c) => [c.chNo, toEditor(c)]));
  state.haveSnapshot = true;
  state.rows = chans.map((c) => ({ ch: toEditor(c) }));
  renderTable();
}

async function readChannelsInto(onlySnapshot) {
  const chans = await state.client.readAllChannels({ onProgress: (n, r, asking) => setStatus(asking != null ? `Reading channels… ${n} found, asking for #${asking}` : `Reading channels… ${n} found`, 'busy') });
  if (onlySnapshot) { state.snapshot = new Map(chans.map((c) => [c.chNo, toEditor(c)])); state.haveSnapshot = true; renderTable(); }
  else setRowsFromRadio(chans);
  return chans;
}

$('#btnReadCh').onclick = () => busy('Reading channels…', async () => {
  if (hasPendingEdits() && !confirm('Reading from the radio will replace your unsaved edits. Continue?')) return;
  const ch = await readChannelsInto(false);
  banner(`Read ${ch.length} channels.`, 'ok');
});

function hasPendingEdits() {
  if (!state.rows.length) return false;
  if (!state.haveSnapshot) return true;
  const d = diffChannels(state.snapshot, state.rows);
  return d.inserts.length + d.modifies.length + d.deletes.length > 0;
}

$('#btnWriteCh').onclick = () => busy('Writing channels…', async () => {
  const errs = validate(state.rows, state.asm);
  if (errs.length) throw new Error('Fix these first:\n' + errs.map((e) => `  channel ${e.chNo}: ${e.msg}`).join('\n'));
  if (!state.haveSnapshot) { banner('Reading the radio first so only differences are written…'); await readChannelsInto(true); }
  if (!state.rows.some((r) => !r.deleted && r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC)) throw new Error('That would delete every channel on the radio, so nothing was written. Load a preset or file first.');
  if (compactUserChannels(state.rows, state.snapshot)) { renderTable(); banner('Renumbered your channels to close gaps: the radio stores them as a packed list (C01, C02, … with no gaps).'); }
  const d = diffChannels(state.snapshot, state.rows);
  const total = d.inserts.length + d.modifies.length + d.deletes.length;
  if (!total) { banner('Nothing to write: the radio already matches.'); return; }
  if (!confirm(`Write to the radio?\n\n${d.inserts.length} new, ${d.modifies.length} changed, ${d.deletes.length} deleted.\n\nTip: press Backup… first.`)) return;
  const fails = []; let done = 0;
  const step = async (label, ch, fn) => {
    setStatus(`Writing ${++done}/${total}…`, 'busy');
    try { await fn(fromEditor(ch)); } catch (e) { fails.push(`${label} ${ch.chNo}: ${e.message}`); return false; }
    return true;
  };
  // the radio packs the list: deleting a slot moves later ones down, so delete from the top slot down
  for (const ch of [...d.deletes].sort((a, b) => b.chNo - a.chNo)) if (await step('delete', ch, (c) => state.client.deleteChannel(c))) state.snapshot.delete(ch.chNo);
  for (const ch of d.modifies) if (await step('modify', ch, (c) => state.client.modifyChannel(c))) state.snapshot.set(ch.chNo, structuredClone(ch));
  for (const ch of [...d.inserts].sort((a, b) => a.chNo - b.chNo)) if (await step('insert', ch, (c) => state.client.insertChannel(c))) state.snapshot.set(ch.chNo, structuredClone(ch));
  state.rows = state.rows.filter((r) => !(r.deleted && !state.snapshot.has(r.ch.chNo)));
  renderTable();
  if (fails.length) banner(`Wrote ${total - fails.length} of ${total}. Failed:\n${fails.join('\n')}`, 'error');
  else banner(`Wrote ${total} change(s). Press Read from radio to verify.`, 'ok');
});

$('#btnAddCh').onclick = () => {
  const used = new Set(state.rows.map((r) => r.ch.chNo));
  let no = Math.max(0, ...used) + 1; while (used.has(no)) no++;
  const tmpl = state.rows.find((r) => r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC)?.ch || state.rows[0]?.ch || {};
  const ch = { chNo: no, chType: SEAL_CHTYPE.SEAL_USERDEF, chName: `CH${no}`, chRxFreq: tmpl.chRxFreq ?? 476425000, chTxFreq: tmpl.chRxFreq ?? 476425000,
    chRxCss: 0, chTxCss: 0 };
  for (const k of ['chSq', 'chVox', 'chTxPower', 'chPowerLevel', 'chBand', 'chElim', 'chPolite']) if (tmpl[k] !== undefined) ch[k] = tmpl[k];
  state.rows.push({ ch });
  renderTable();
  $('#chTable tbody tr:last-child input.w-name')?.focus();
};
$('#btnDelCh').onclick = () => {
  const sel = state.rows.filter((r) => r.sel);
  if (!sel.length) { banner('Tick the channels to delete first.'); return; }
  const lockedSel = sel.filter((r) => locked(r.ch));
  for (const r of sel) if (!locked(r.ch)) { r.deleted = true; r.sel = false; }
  state.rows = state.rows.filter((r) => !(r.deleted && !state.snapshot.has(r.ch.chNo)));
  renderTable();
  if (lockedSel.length) banner(`${lockedSel.length} locked public channel(s) were skipped.`);
};
$('#btnRevert').onclick = () => {
  if (!state.haveSnapshot) { banner('Nothing to undo to: no radio read yet.'); return; }
  state.rows = [...state.snapshot.values()].sort((a, b) => a.chNo - b.chNo).map((c) => ({ ch: structuredClone(c) }));
  renderTable();
};
$('#selAll').onchange = (e) => { for (const r of state.rows) if (!locked(r.ch)) r.sel = e.target.checked; renderTable(); };

// ---------- files ----------
function stamp() { return new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-'); }
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const liveChannels = () => state.rows.filter((r) => !r.deleted).map((r) => r.ch).sort((a, b) => a.chNo - b.chNo);

$('#btnSave').onclick = () => {
  if (!state.rows.length && !state.device) { banner('Nothing to save yet.'); return; }
  const f = buildConfigFile({ device: state.device, country: typeof state.country === 'number' ? state.country : undefined,
    channels: liveChannels(), assumptions: state.asm, radioName: state.radioName });
  const base = (state.device ? bytesToName(state.device.deviceName) : 'lito').replace(/[^\w-]+/g, '_') || 'lito';
  download(`${base}-${stamp()}.lito.json`, JSON.stringify(f, null, 2), 'application/json');
};
$('#btnCsv').onclick = () => {
  if (!state.rows.length) { banner('No channels to export.'); return; }
  download(`lito-channels-${stamp()}.csv`, '﻿' + channelsToCsv(liveChannels(), state.asm), 'text/csv');
};
function openCheatSheet(opts) {
  const plan = BAND_PLANS.find((p) => p.id === $('#bandPlan').value);
  const html = cheatSheetHtml({ plan, toneLabel, ...opts });
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const w = window.open(url, '_blank');
  if (!w) download(`lito-cheat-sheet-${stamp()}.html`, html, 'text/html'); // popup blocked: save it instead
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('#btnCheat').onclick = () => {
  const chans = liveChannels().filter((c) => c.chType !== SEAL_CHTYPE.SEAL_PUBLIC);
  if (!chans.length) { banner('No channels to put on a cheat sheet.'); return; }
  openCheatSheet({ title: state.radioName ? `${state.radioName} channels` : 'Radio channels', subtitle: state.setupSource ? `From ${state.setupSource}` : 'Current channel list', channels: chans });
};
$('#btnOpen').onclick = () => { $('#fileInput').value = ''; $('#fileInput').click(); };
$('#fileInput').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const text = await file.text();
    let chans, note = '';
    if (/\.csv$/i.test(file.name)) chans = csvToChannels(text, state.asm);
    else {
      const f = parseConfigFile(text); chans = f.channels;
      if (f.device) applyDeviceFromFile(f.device);
      if (f.assumptions && JSON.stringify(f.assumptions) !== JSON.stringify(state.asm)) note = ' The file was saved with different protocol assumptions; tones are shown using your current ones.';
    }
    if (hasPendingEdits() && !confirm('Replace the channels in the editor with this file?')) return;
    // keep radio rows that the file doesn't mention? No: the file is the full desired channel list.
    const fileNos = new Set(chans.map((c) => c.chNo));
    state.rows = chans.map((c) => ({ ch: c }));
    for (const [no, c] of state.snapshot) if (!fileNos.has(no)) state.rows.push({ ch: structuredClone(c), deleted: c.chType !== SEAL_CHTYPE.SEAL_PUBLIC });
    state.rows.sort((a, b) => a.ch.chNo - b.ch.chNo);
    renderTable();
    state.setupSource = `file ${file.name}`;
    banner(`Loaded ${chans.length} channels from ${file.name}.${state.haveSnapshot ? ' Differences from the radio are highlighted.' : ''}${note}`, 'ok');
  } catch (err) { banner(`Could not open ${file.name}: ${err.message}`, 'error'); }
};
function applyDeviceFromFile(dev) {
  state.loadedSettings = true;
  // Fill the settings form so the person can review and press "Save settings to radio".
  if (dev.deviceName != null) $('#f_deviceName').value = dev.deviceName;
  if (dev.bleName != null) $('#f_bleName').value = dev.bleName;
  if (dev.voiceType != null) $('#f_voiceType').value = String(dev.voiceType);
  if (dev.voiceAlert != null) $('#f_voiceAlert').checked = dev.voiceAlert === SEAL_SWITCH.SEAL_ON;
  if (dev.shareLoc != null) $('#f_shareLoc').checked = dev.shareLoc === SEAL_SWITCH.SEAL_ON;
  if (dev.pwsaveMode != null) $('#f_pwsaveMode').value = dev.pwsaveMode;
}

// ---------- raw frame ----------
$('#btnRawSend').onclick = () => busy('Sending…', async () => {
  const cmd = Number($('#rawCmd').value);
  const hex = $('#rawHex').value.trim();
  if (hex) {
    await state.client.sendPayload(cmd, fromHex(hex));
  } else {
    const m = CMD_MESSAGE[cmd];
    if (!m) throw new Error(`No known message for command ${cmd}; use payload hex instead.`);
    await state.client.send(cmd, m, JSON.parse($('#rawJson').value));
  }
  banner('Sent. Responses appear in the log.', 'ok');
});

// ---------- channel paging probe (research) ----------
const PROBES = [
  ['no ch field', {}],
  ['empty ch', { ch: {} }],
  ['chNo 0', { ch: { chNo: 0 } }],
  ['chNo 5', { ch: { chNo: 5 } }],
  ['chType PUBLIC', { ch: { chType: 0 } }],
  ['chType REMOTE', { ch: { chType: 1 } }],
  ['chType USERDEF', { ch: { chType: 2 } }],
  ['chNo 1 + USERDEF', { ch: { chNo: 1, chType: 2 } }],
  ['result CONTINUE echoed', { result: 4 }],
];
$('#btnProbe').onclick = () => busy('Probing…', async () => {
  const summary = [];
  for (const [label, extra] of PROBES) {
    for (let i = 1; i <= 3; i++) {
      logEntry({ dir: 'note', text: `probe "${label}" try ${i}` });
      setStatus(`Probing: ${label} (${i}/3)`, 'busy');
      let res;
      try { res = await state.client.collect(20009, 'SEAL_ChannelInfoOperate', { version: 1, option: 3, ...extra }, 20011, 1500); }
      catch (e) { res = []; logEntry({ dir: 'err', text: e.message }); }
      summary.push(`${label} #${i}: ${res.length ? res.map((m) => `result ${m.result} chNo ${m.ch?.chNo} "${bytesToName(m.ch?.chName)}" rx ${m.ch?.chRxFreq}`).join(' | ') : 'no reply'}`);
    }
  }
  logEntry({ dir: 'note', text: 'probe summary', msg: summary });
  banner('Probe finished. Press Download log and put the file in the project folder.', 'ok');
});

// ---------- slot test (research): does the radio accept a custom channel in a gap? ----------
function slotReport(lines) { $('#slotResult').textContent = lines.join('\n'); $('#slotResult').style.whiteSpace = 'pre-wrap'; }
$('#btnSlotTest').onclick = () => busy('Slot test…', async () => {
  const slot = Number($('#slotNo').value);
  if (!confirm(`Write a test channel "TEST" (476.925 MHz) into custom slot ${slot} (C${String(slot + 1).padStart(2, '0')})?`)) return;
  const lines = [];
  const before = await state.client.readAllChannels();
  lines.push(`Before: ${before.length} custom channels in slots ${before.map((c) => c.chNo).join(', ')}.`);
  const ch = { chNo: slot, chType: SEAL_CHTYPE.SEAL_USERDEF, chName: nameToBytes('TEST'), chRxFreq: 476925000, chTxFreq: 476925000, chRxCss: 0, chTxCss: 0 };
  try { const r = await state.client.insertChannel(ch); lines.push(`Insert at slot ${slot}: OK (radio answered with slot ${r.ch?.chNo ?? '?'}).`); }
  catch (e) { lines.push(`Insert at slot ${slot}: refused (${e.message}).`); }
  const direct = await state.client.readChannel(slot);
  lines.push(`Reading slot ${slot} directly: result ${direct.result}, slot ${direct.ch?.chNo ?? '-'}, name "${bytesToName(direct.ch?.chName)}", ${hzToMHz(direct.ch?.chRxFreq)} MHz.`);
  const after = await state.client.readAllChannels();
  lines.push(`After: ${after.length} custom channels in slots ${after.map((c) => c.chNo).join(', ')}.`);
  const t = after.find((c) => bytesToName(c.chName) === 'TEST');
  lines.push(t ? `The test channel is in slot ${t.chNo}, which shows as C${String(t.chNo + 1).padStart(2, '0')} on the radio (please check).` : 'The test channel was not found in the normal list read (it may sit after a gap).');
  lines.push('Please check the radio screen too, then press Download log.');
  slotReport(lines);
});
// ---------- channel limit test ----------
const LIM_RE = /^LIM\d+$/;
async function removeLimitChannels(lines) {
  // Only ever delete channels the test wrote (named LIMnn), from the top slot down (the list is packed).
  const all = await state.client.readAllChannels();
  const ours = all.filter((c) => LIM_RE.test(bytesToName(c.chName))).map((c) => c.chNo).sort((a, b) => b - a);
  for (const slot of ours) {
    try { await state.client.deleteChannel({ chNo: slot, chType: SEAL_CHTYPE.SEAL_USERDEF }); }
    catch (e) { lines.push(`Could not delete test channel in slot ${slot}: ${e.message}`); }
  }
  const after = await state.client.readAllChannels();
  lines.push(`Removed ${ours.length} test channel(s). The radio now has ${after.length} custom channels.`);
  return after;
}
// ---------- listen-only (TX frequency 0) test ----------
$('#btnTxOffTest').onclick = () => busy('Listen-only test…', async () => {
  const before = await state.client.readAllChannels();
  const slot = before.length;
  const already = before.filter((c) => c.chTxFreq === 0).map((c) => `C${String(c.chNo + 1).padStart(2, '0')}`);
  if (slot >= 60) {
    $('#txOffResult').textContent = `The radio is full (60 channels), so no test channel was added: a 61st makes it reboot.${already.length ? ` These slots are already listen-only, so test PTT on one of them: ${already.join(', ')}.` : ' Delete a channel first, or load a preset with listen-only repeater slots.'}`;
    return;
  }
  if (!confirm(`Write a test channel "TXOFF" (receive 476.625 MHz, transmit frequency 0) into slot C${String(slot + 1).padStart(2, '0')}?`)) return;
  const lines = [];
  try {
    const r = await state.client.insertChannel({ chNo: slot, chType: SEAL_CHTYPE.SEAL_USERDEF, chName: nameToBytes('TXOFF'), chRxFreq: 476625000, chTxFreq: 0, chRxCss: 0, chTxCss: 0 });
    lines.push(`Insert: accepted (result ${r.result ?? 0}).`);
  } catch (e) { lines.push(`Insert: REFUSED by the radio (${e.message}).`); $('#txOffResult').textContent = lines.join('\n'); return; }
  const back = await state.client.readChannel(slot).catch((e) => ({ error: e.message }));
  if (back.ch) lines.push(`Read back slot C${String(slot + 1).padStart(2, '0')}: name "${bytesToName(back.ch.chName)}", RX ${hzToMHz(back.ch.chRxFreq)}, TX ${back.ch.chTxFreq == null ? 'missing' : back.ch.chTxFreq === 0 ? '0 (stored as no transmit)' : hzToMHz(back.ch.chTxFreq) + ' MHz'}.`);
  else lines.push(`Read back failed: ${back.error ?? 'no channel'}.`);
  lines.push(`Now select C${String(slot + 1).padStart(2, '0')} on the radio, press PTT for a second and note what happens. Then press Delete test channel, and send the log.`);
  $('#txOffResult').textContent = lines.join('\n');
});
$('#btnTxOffDelete').onclick = () => busy('Deleting TXOFF…', async () => {
  const all = await state.client.readAllChannels();
  const ours = all.filter((c) => bytesToName(c.chName) === 'TXOFF').map((c) => c.chNo).sort((a, b) => b - a);
  for (const n of ours) await state.client.deleteChannel({ chNo: n, chType: SEAL_CHTYPE.SEAL_USERDEF });
  $('#txOffResult').textContent = ours.length ? `Deleted ${ours.length} TXOFF channel(s).` : 'No TXOFF channel found.';
});
$('#btnLimitClean').onclick = () => busy('Removing test channels…', async () => {
  const lines = []; await removeLimitChannels(lines); $('#limitResult').textContent = lines.join('\n');
});
$('#btnSlotDelete').onclick = () => busy('Deleting test…', async () => {
  const lines = [];
  // Only ever delete slots that really hold the "TEST" channel.
  const slots = new Set((await state.client.readAllChannels()).filter((c) => bytesToName(c.chName) === 'TEST').map((c) => c.chNo));
  const direct = await state.client.readChannel(Number($('#slotNo').value));
  if (direct.ch && bytesToName(direct.ch.chName) === 'TEST') slots.add(direct.ch.chNo);
  if (!slots.size) lines.push('No TEST channel found, nothing deleted.');
  for (const slot of slots) {
    try { await state.client.deleteChannel({ chNo: slot, chType: SEAL_CHTYPE.SEAL_USERDEF }); lines.push(`Deleted slot ${slot}.`); }
    catch (e) { lines.push(`Slot ${slot}: ${e.message}`); }
  }
  const after = await state.client.readAllChannels();
  lines.push(`Now: ${after.length} custom channels in slots ${after.map((c) => c.chNo).join(', ')}.`);
  slotReport(lines);
});

// ---------- presets dialog ----------
let presetId = null;
const presetOpts = () => ({ duplexRepeaters: $('#presetDuplex').checked, includeRepeaterInputs: $('#presetInputs').checked,
  repeaters: $('#presetRptMode').value, spareCh: Number($('#presetSpare').value) });
for (let n = 9; n <= 40; n++) if (n !== 22 && n !== 23) { const o = document.createElement('option'); o.value = String(n); o.textContent = `CH${n}`; $('#presetSpare').appendChild(o); }
const REGION_COUNTRY = { au: 'Australia', nz: 'New Zealand', us: 'United States', eu: 'EU / UK', sg: 'EU / UK' };
function renderPresetList() {
  const list = $('#presetList'); list.innerHTML = '';
  const countries = [...new Set(PRESETS.map((p) => p.country))];
  for (const c of countries) {
    const h = document.createElement('div'); h.className = 'preset-group'; h.textContent = c; list.appendChild(h);
    for (const p of PRESETS.filter((x) => x.country === c)) {
      const it = document.createElement('button'); it.className = 'preset-item'; it.setAttribute('role', 'option');
      it.classList.toggle('sel', p.id === presetId); it.setAttribute('aria-selected', String(p.id === presetId));
      it.innerHTML = '<span class="pi-name"></span><span class="pi-meta"></span>';
      it.querySelector('.pi-name').textContent = p.name;
      it.querySelector('.pi-meta').textContent = `${buildPreset(p.id).length} channels${p.verified ? '' : ' · unverified'}`;
      it.onclick = () => { presetId = p.id; renderPresetList(); showPresetDetail(); };
      list.appendChild(it);
    }
  }
}
function showPresetDetail() {
  const p = PRESETS.find((x) => x.id === presetId);
  $('#presetTitle').textContent = `${p.country}: ${p.name}`;
  $('#presetNotes').textContent = p.notes;
  $('#presetSource').textContent = `Source: ${p.source}`;
  const badges = $('#presetBadges'); badges.innerHTML = '';
  const badge = (t, cls, tip) => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = t; if (tip) b.title = tip; badges.appendChild(b); };
  if (p.slotIsChannel) badge('slot = channel', 'blue', 'Each channel goes in its own numbered slot: C01 holds CH1, C10 holds CH10, and so on');
  badge(p.verified ? 'verified' : 'unverified', p.verified ? 'ok' : 'warn', p.verified ? 'Frequencies checked against the official band plan' : 'Not checked against the official rules yet');
  $('#presetDuplex').closest('label').classList.toggle('hidden', !('duplexRepeaters' in (p.options || {})));
  $('#presetInputs').closest('label').classList.toggle('hidden', !('includeRepeaterInputs' in (p.options || {})));
  $('#presetRptMode').closest('label').classList.toggle('hidden', !('repeaters' in (p.options || {})));
  $('#presetSpare').classList.toggle('hidden', $('#presetRptMode').value !== 'spare');
  const chans = buildPreset(p.id, presetOpts());
  $('#presetCount').textContent = `${chans.length} channels`;
  const pv = $('#presetPreview'); pv.innerHTML = '';
  for (const c of chans) {
    const chip = document.createElement('span'); chip.className = 'chip';
    chip.textContent = c.chName; chip.title = `${hzToMHz(c.chRxFreq)} MHz${c.chTxFreq === 0 ? ', no transmit' : c.chTxFreq !== c.chRxFreq ? `, TX ${hzToMHz(c.chTxFreq)}` : ''}${c.chRxCss ? `, tone ${toneLabel(c.chRxCss)}` : ''}`;
    pv.appendChild(chip);
  }
  const ap = $('#btnPresetAppend');
  ap.disabled = !!p.slotIsChannel;
  ap.title = p.slotIsChannel ? 'This preset puts each channel in its own numbered slot, so it can only overwrite your channels' : 'Keep your current channels and add these after them';
}
$('#presetDuplex').onchange = showPresetDetail; $('#presetInputs').onchange = showPresetDetail;
$('#presetRptMode').onchange = showPresetDetail; $('#presetSpare').onchange = showPresetDetail;
function openPresets() {
  if (!presetId) { const c = REGION_COUNTRY[$('#bandPlan').value]; presetId = (PRESETS.find((p) => p.country === c) || PRESETS[0]).id; }
  renderPresetList(); showPresetDetail();
  $('#presetDialog').showModal();
  $('#presetList .preset-item.sel')?.focus();
}
const closePresets = () => $('#presetDialog').close();
$('#btnPreset').onclick = openPresets;
$('#btnPresetClose').onclick = closePresets; $('#btnPresetCancel').onclick = closePresets;
$('#presetDialog').addEventListener('click', (e) => { if (e.target === $('#presetDialog')) closePresets(); }); // click on the backdrop
function applyPreset(replace) {
  const live = state.rows.filter((r) => !r.deleted && r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC);
  const template = live[0]?.ch || {};
  const preset = PRESETS.find((x) => x.id === presetId);
  if (preset.slotIsChannel && !replace) return;
  const start = replace ? 0 : Math.max(-1, ...live.map((r) => r.ch.chNo)) + 1;
  const chans = buildPreset(presetId, presetOpts(), template, start);
  if (replace) {
    for (const r of state.rows) if (r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC) r.deleted = true;
    const byNo = new Map(state.rows.map((r) => [r.ch.chNo, r]));
    for (const c of chans) { const r = byNo.get(c.chNo); if (r) { r.ch = c; r.deleted = false; } else state.rows.push({ ch: c }); }
  } else for (const c of chans) state.rows.push({ ch: c });
  state.rows = state.rows.filter((r) => !(r.deleted && !state.snapshot.has(r.ch.chNo)));
  state.rows.sort((a, b) => a.ch.chNo - b.ch.chNo);
  renderTable();
  closePresets();
  state.setupSource = `preset "${preset.name}"`; renderFleet();
  banner(`${replace ? 'Overwrote the channel list with' : 'Appended'} ${chans.length} channels from "${preset.name}". Review them, then press Write to radio (or Write Radios in the Bulk Programmer).`, 'ok');
}
$('#btnPresetReplace').onclick = () => applyPreset(true);
$('#btnPresetCheat').onclick = () => {
  const p = PRESETS.find((x) => x.id === presetId);
  const mode = { duplex: 'repeater slots talk through repeaters', spare: `repeater slots are spare copies of CH${$('#presetSpare').value}`, listen: 'repeater slots are listen only' }[$('#presetRptMode').value];
  openCheatSheet({ title: p.name, subtitle: `${p.country} preset${'repeaters' in (p.options || {}) ? ', ' + mode : ''}`, channels: buildPreset(p.id, presetOpts()) });
};
$('#btnPresetAppend').onclick = () => applyPreset(false);

// ---------- bulk programmer ----------
// A plain list of radios. Each row has explicit Connect/Disconnect and Remove; nothing happens on its own.
// Rows are remembered across reloads (name + Bluetooth id). After a reload the browser forgets the
// Bluetooth device object, so Connect may need the picker again unless Chrome supports getDevices().
const FLEET_KEY = 'lito.fleet.v1';
const fleet = []; // {key, name, device, sim, client, include, status, result, info}
let demoSeq = 0;
function saveFleet() {
  try { localStorage.setItem(FLEET_KEY, JSON.stringify(fleet.filter((f) => !f.sim).map((f) => ({ key: f.key, name: f.name, include: f.include })))); } catch { /* ignore */ }
}
function loadFleet() {
  try { for (const f of JSON.parse(localStorage.getItem(FLEET_KEY) || '[]')) fleet.push({ ...f, device: null, client: null, status: 'not connected', result: '' }); } catch { /* ignore */ }
}
const isEditorRadio = (f) => f.client && f.client === state.client;
function renderFleet() {
  const tb = $('#fleetTable tbody'); if (!tb) return; tb.innerHTML = '';
  for (const f of fleet) {
    const tr = document.createElement('tr');
    const cbTd = document.createElement('td'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = f.include;
    cb.onchange = () => { f.include = cb.checked; saveFleet(); renderFleet(); };
    cbTd.appendChild(cb); tr.appendChild(cbTd);
    const ver = f.info ? (fmtVer(f.info.verSoft).match(/v[\d.]+/)?.[0] ?? String(f.info.verSoft)) : '';
    const nameTd = document.createElement('td'); nameTd.className = 'rname';
    nameTd.textContent = f.name + (f.sim ? ' (demo)' : ''); tr.appendChild(nameTd);
    const tg = document.createElement('button'); tg.className = 'twisty'; tg.textContent = f.open ? '▴' : '▾';
    tg.title = f.open ? 'Hide channels' : 'Show channels';
    tg.setAttribute('aria-expanded', String(!!f.open));
    tg.onclick = () => { f.open = !f.open; renderFleet(); };
    // Connected/disconnected shows on the button colour; this column only shows activity, errors and results.
    const plain = /^(connected|disconnected|not connected)$/i.test(f.status || '');
    const shown = [plain ? '' : f.status.replace(/^connected \(also open in the editor\)$/, 'shared with the editor'), f.result].filter(Boolean).join(' · ');
    for (const [txt, cls] of [[ver], [f.info?.charge ?? ''], [shown, 'res']]) {
      const td = document.createElement('td'); td.textContent = txt; if (cls) td.className = cls; tr.appendChild(td);
    }
    const act = document.createElement('td'); act.className = 'acts';
    const busyRow = /connecting|accept|reading|writing/i.test(f.status);
    const bc = document.createElement('button');
    bc.textContent = f.client ? 'Disconnect' : canQuick(f) ? 'Connect' : 'Connect…'; bc.disabled = busyRow || state.fleetBusy;
    if (!f.client && !canQuick(f)) bc.title = 'Opens the Bluetooth picker: choose this radio';
    bc.className = busyRow ? 'st-busy' : f.client ? 'st-on' : 'st-off';
    if (f.client) bc.title = 'Connected. Press to disconnect';
    if (busyRow) bc.textContent = /connecting|accept/i.test(f.status) ? 'Connecting…' : 'Busy…';
    bc.onclick = () => (f.client ? fleetDisconnect(f) : fleetConnect(f));
    const br = document.createElement('button'); br.textContent = 'Remove'; br.disabled = busyRow || state.fleetBusy;
    br.onclick = () => fleetRemove(f);
    const bs = document.createElement('button'); bs.textContent = 'Back up'; bs.title = 'Read this radio and download a .lito.json backup';
    bs.disabled = !f.client || busyRow || state.fleetBusy; bs.onclick = () => fleetBackup(f).catch((e) => banner(`${f.name}: backup failed: ${e.message}`, 'error'));
    act.append(bc, bs, br, tg); tr.appendChild(act); tb.appendChild(tr);
    if (f.open) tb.appendChild(fleetDetail(f));
  }
  labelCells($('#fleetTable'));
  renderFleetSetup();
  const ready = fleet.filter((f) => f.client && f.include).length;
  const chans = state.rows.filter((r) => !r.deleted && r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC).length;
  $('#fleetSummary').textContent = fleet.length
    ? `${fleet.filter((f) => f.client).length} of ${fleet.length} radio(s) connected, ${ready} ticked and ready. Will write ${chans} channel(s) from the Channels tab.`
    : 'No radios yet. Press Add radio… for each one.';
  $('#btnFleetApply').disabled = !ready || !chans || state.fleetBusy;
  setLabel($('#btnFleetApply'), 'Write Radios', chans ? 'Write the setup to every ticked radio' : 'Load a setup first (step 1)');
  $('#btnFleetBackup').disabled = !ready || state.fleetBusy;
  const off = fleet.filter((f) => !f.client);
  const quickN = off.filter(canQuick).length;
  const rc = $('#btnFleetConnectAll');
  rc.classList.toggle('hidden', quickN < 2); rc.textContent = `Reconnect ${quickN}`; rc.disabled = state.fleetBusy;
  $('#fleetConnectHint').textContent = off.some((f) => !canQuick(f))
    ? 'Connect… opens the Bluetooth picker because the browser forgot this radio when the page reloaded. Pick the matching radio. '
      + (knownIds === null ? 'To reconnect without the picker, open chrome://flags (or edge://flags), enable "Use the new permissions backend for Web Bluetooth", and restart the browser.' : '')
    : '';
}
function renderFleetSetup() {
  const el = $('#fleetSetup'); if (!el) return;
  const live = state.rows.filter((r) => !r.deleted && r.ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC).sort((a, b) => a.ch.chNo - b.ch.chNo);
  if (!live.length) { el.textContent = 'No setup loaded yet. Load a preset or a backup, or open a radio\'s channels below and use "Open in Channels tab".'; return; }
  const names = live.slice(0, 6).map((r) => r.ch.chName || hzToMHz(r.ch.chRxFreq)).join(', ');
  el.textContent = `${live.length} channel(s)${state.setupSource ? ' from ' + state.setupSource : ''}: ${names}${live.length > 6 ? ', …' : ''}`;
}
$('#btnFleetPreset').onclick = openPresets;
$('#btnFleetOpen').onclick = () => $('#btnOpen').click();
$('#btnFleetFromEditor').onclick = () => document.querySelector('.tabs [data-tab=channels]').click();

function fleetSet(f, patch) { Object.assign(f, patch); renderFleet(); }

// Expanded row: this radio's channels, read on demand.
function fleetDetail(f) {
  const tr = document.createElement('tr'); tr.className = 'detail';
  const td = document.createElement('td'); td.colSpan = 6; tr.appendChild(td);
  const bar = document.createElement('div'); bar.className = 'toolbar';
  const bRead = document.createElement('button'); bRead.textContent = f.channels ? 'Read again' : 'Read channels';
  bRead.disabled = !f.client || state.fleetBusy || f.reading; bRead.onclick = () => fleetRead(f);
  const bCopy = document.createElement('button'); bCopy.textContent = 'Open in Channels tab';
  bCopy.title = 'Copy these channels into the editor, e.g. to use this radio as the master setup';
  bCopy.disabled = !f.channels; bCopy.onclick = () => fleetToEditor(f);
  const note = document.createElement('span'); note.className = 'small';
  note.textContent = !f.client ? 'Connect this radio to read its channels.' : f.reading ? 'Reading…' : f.channels ? `${f.channels.length} of 60 custom channels` : '';
  bar.append(bRead, bCopy, note); td.appendChild(bar);
  if (f.channels?.length) {
    const t = document.createElement('table'); t.className = 'mini';
    t.innerHTML = '<thead><tr><th>Slot</th><th>Name</th><th>RX MHz</th><th>TX MHz</th><th>RX tone</th><th>TX tone</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const c of f.channels) {
      const r = document.createElement('tr');
      for (const v of [`C${String(c.chNo + 1).padStart(2, '0')}`, c.chName, hzToMHz(c.chRxFreq), hzToMHz(c.chTxFreq), toneLabel(c.chRxCss), toneLabel(c.chTxCss)]) {
        const d = document.createElement('td'); d.textContent = v ?? ''; r.appendChild(d);
      }
      body.appendChild(r);
    }
    t.appendChild(body); td.appendChild(t);
  }
  return tr;
}
async function fleetRead(f) {
  if (!f.client || f.reading) return;
  f.reading = true; renderFleet();
  try { f.channels = (await f.client.readAllChannels()).map(toEditor); }
  catch (e) { banner(`${f.name}: ${e.message}`, 'error'); }
  f.reading = false; renderFleet();
}
function fleetToEditor(f) {
  if (hasPendingEdits() && !confirm('Replace the channels in the editor with this radio\'s channels?')) return;
  state.rows = f.channels.map((c) => ({ ch: structuredClone(c) }));
  if (!isEditorRadio(f)) { state.snapshot = new Map(); state.haveSnapshot = false; }
  else { state.snapshot = new Map(f.channels.map((c) => [c.chNo, structuredClone(c)])); state.haveSnapshot = true; }
  renderTable();
  document.querySelector('.tabs [data-tab=channels]').click();
  state.setupSource = `radio ${f.name}`;
  banner(`Loaded ${f.channels.length} channels from ${f.name} into the editor.`, 'ok');
}

// Bluetooth device ids the browser still has permission for (null = browser can't tell us).
let knownIds = null;
const canQuick = (f) => !!(f.sim || f.device || knownIds?.has(f.key));
async function refreshKnown() {
  const k = await WebBluetoothTransport.remembered();
  knownIds = k ? new Set(k.map((d) => d.id)) : null;
  renderFleet();
}
refreshKnown();

async function deviceFor(f) {
  if (f.device) return f.device;
  const known = await WebBluetoothTransport.remembered();
  const d = known?.find((x) => x.id === f.key);
  if (d) return (f.device = d);
  // The browser forgot it (page reloaded, no getDevices support): ask the person to pick it again.
  const picked = await WebBluetoothTransport.pick({ acceptAll: $('#acceptAll').checked });
  if (picked.id !== f.key && fleet.some((x) => x !== f && x.key === picked.id)) throw new Error(`${picked.name || 'That radio'} is already in the list.`);
  f.key = picked.id; f.name = picked.name || f.name; f.device = picked; saveFleet();
  return picked;
}

async function fleetConnect(f) {
  if (f.client) return;
  // Same radio as the one connected at the top of the page? Share that connection.
  if (!f.sim && state.client && state.client.t?.device?.id === f.key) {
    f.client = state.client; f.info = state.device; fleetSet(f, { status: 'connected (also open in the editor)' }); return;
  }
  try {
    let transport;
    if (f.sim) transport = f.sim.transport();
    else transport = new WebBluetoothTransport({ device: await deviceFor(f) });
    fleetSet(f, { status: 'connecting…', result: '' });
    const client = new LitoClient(transport, state.asm);
    client.on('frame', (e) => logEntry({ ...e, radio: f.name }));
    client.on('error', (err, raw) => logEntry({ dir: 'err', text: err.message, raw, radio: f.name }));
    client.on('disconnect', () => { if (f.client === client) fleetSet(f, { client: null, status: 'disconnected' }); });
    await client.open();
    const hs = await client.handshake({ deviceId: storedDeviceId(transport), onWait: () => fleetSet(f, { status: 'accept on the radio…' }) });
    rememberDeviceId(transport, hs);
    f.client = client;
    fleetSet(f, { status: 'reading info…' });
    f.info = await client.getDeviceParams();
    fleetSet(f, { status: 'connected' });
  } catch (e) {
    try { await f.client?.close(); } catch { /* ignore */ }
    fleetSet(f, { client: null, status: e.name === 'NotFoundError' ? 'not connected (picker cancelled)' : `failed: ${e.message}` });
  }
}
async function fleetDisconnect(f) {
  const c = f.client; f.client = null;
  if (c === state.client) { state.client = null; refreshButtons(); setStatus('Not connected', 'off'); }
  try { await c?.close(); } catch { /* ignore */ }
  fleetSet(f, { status: 'disconnected' });
}
async function fleetRemove(f) {
  await fleetDisconnect(f);
  fleet.splice(fleet.indexOf(f), 1); saveFleet(); renderFleet();
}

$('#btnFleetAdd').onclick = async () => {
  let d;
  try { d = await WebBluetoothTransport.pick({ acceptAll: $('#acceptAll').checked }); }
  catch (e) { if (e.name !== 'NotFoundError') banner(e.message, 'error'); return; } // cancelled picker: add nothing
  let f = fleet.find((x) => x.key === d.id);
  if (!f) { f = { key: d.id, name: d.name || 'LITO', include: true, status: 'not connected', result: '' }; fleet.push(f); saveFleet(); }
  f.device = d;
  renderFleet();
  await fleetConnect(f);
};
$('#btnFleetDemo').onclick = () => {
  const f = { key: `demo-${++demoSeq}`, name: `Demo ${demoSeq}`, sim: new SimulatedRadio({ requireConfirm: true, latencyMs: 10 + Math.random() * 20 }), include: true, status: 'not connected', result: '' };
  fleet.push(f); renderFleet(); fleetConnect(f);
};
function saveRadioBackup(f, channels, tag = '') {
  const file = buildConfigFile({ device: f.info, channels: [...channels].sort((a, b) => a.chNo - b.chNo), assumptions: state.asm, radioName: f.name });
  download(`${f.name.replace(/[^\w-]+/g, '_')}${tag ? '-' + tag : ''}-${stamp()}.lito.json`, JSON.stringify(file, null, 2), 'application/json');
}
async function fleetBackup(f) {
  fleetSet(f, { status: 'backing up…' });
  try {
    f.channels = (await f.client.readAllChannels()).map(toEditor);
    saveRadioBackup(f, f.channels);
    fleetSet(f, { result: `backed up ${f.channels.length} channel(s)` });
  } finally { fleetSet(f, { status: f.client ? 'connected' : 'disconnected' }); }
}
$('#btnFleetConnectAll').onclick = async () => {
  // Only radios the browser can reach without the picker; the picker needs one click per radio.
  await Promise.all(fleet.filter((f) => !f.client && canQuick(f)).map(fleetConnect));
};
$('#btnFleetBackup').onclick = async () => {
  const targets = fleet.filter((f) => f.client && f.include);
  state.fleetBusy = true; renderFleet();
  try {
    await Promise.all(targets.map(fleetBackup));
    if (targets.length > 1) banner(`Saved ${targets.length} backups to your Downloads folder. If the browser asks, allow multiple downloads.`, 'ok');
  } catch (e) { banner(`Backup failed: ${e.message}`, 'error'); }
  state.fleetBusy = false; renderFleet();
};

$('#btnFleetApply').onclick = async () => {
  const errs = validate(state.rows, state.asm);
  if (errs.length) { banner('Fix these in the Channels tab first:\n' + errs.map((e) => `  channel ${e.chNo}: ${e.msg}`).join('\n'), 'error'); return; }
  const targets = fleet.filter((f) => f.client && f.include);
  const channels = state.rows.filter((r) => !r.deleted).map((r) => r.ch);
  const settings = {};
  if ($('#fleetSettings').checked) {
    settings.voiceType = Number($('#f_voiceType').value);
    settings.voiceAlert = $('#f_voiceAlert').checked ? SEAL_SWITCH.SEAL_ON : SEAL_SWITCH.SEAL_OFF;
    settings.shareLoc = $('#f_shareLoc').checked ? SEAL_SWITCH.SEAL_ON : SEAL_SWITCH.SEAL_OFF;
    if ($('#f_pwsaveMode').value !== '') settings.pwsaveMode = Number($('#f_pwsaveMode').value);
  }
  const useSettings = $('#fleetSettings').checked && (state.device || state.loadedSettings);
  const userCh = channels.filter((c) => c.chType !== SEAL_CHTYPE.SEAL_PUBLIC).length;
  if (!userCh) { banner('The setup to write is empty. Load a preset or a file first (step 1).', 'error'); return; }
  if (!confirm(`Write ${userCh} channel(s)${useSettings ? ' and settings (' + CLONEABLE_SETTINGS.join(', ') + ')' : ''} to ${targets.length} radio(s)?${$('#fleetBackupFirst').checked ? '\n\nA backup of each radio is downloaded first.' : ''}${$('#fleetRemove').checked ? '\n\nChannels on those radios that are not in this setup will be DELETED.' : ''}`)) return;
  const backupFirst = $('#fleetBackupFirst').checked;
  state.fleetBusy = true; renderFleet();
  await Promise.all(targets.map(async (f) => {
    try {
      const r = await applyConfig(f.client, { channels, settings: useSettings ? settings : undefined },
        { settings: !!useSettings, removeExtra: $('#fleetRemove').checked, onStep: (t) => fleetSet(f, { status: t }),
          onRadioRead: backupFirst ? (radio) => saveRadioBackup(f, radio, 'before-write') : undefined });
      f.channels = null;
      fleetSet(f, { result: summarize(r), status: r.failures.length ? 'finished with errors' : 'done' });
    } catch (e) { fleetSet(f, { status: 'failed', result: e.message }); }
  }));
  state.fleetBusy = false; renderFleet();
  if (targets.some(isEditorRadio)) state.haveSnapshot = false;
  banner(`Finished writing to ${targets.length} radio(s). See the Result column.`, 'ok');
};
loadFleet();

// ---------- about / developer tools ----------
const DEV_KEY = 'lito.devtools';
function applyDevTools(on) {
  document.querySelectorAll('.tabs .dev').forEach((t) => t.classList.toggle('hidden', !on));
  const active = document.querySelector('.tabs button.active');
  if (!on && active?.classList.contains('dev')) document.querySelector('.tabs [data-tab=about]').click();
}
$('#devToggle').checked = localStorage.getItem(DEV_KEY) === '1';
applyDevTools($('#devToggle').checked);
$('#devToggle').onchange = () => { localStorage.setItem(DEV_KEY, $('#devToggle').checked ? '1' : '0'); applyDevTools($('#devToggle').checked); };
$('#btnAboutLog').onclick = () => $('#btnSaveLog').click();
const BULK_KEY = 'lito.bulk';
function applyBulk(on) {
  document.querySelector('.tabs .bulk').classList.toggle('hidden', !on);
  if (!on && document.querySelector('.tabs button.active')?.classList.contains('bulk')) document.querySelector('.tabs [data-tab=about]').click();
}
$('#bulkToggle').checked = localStorage.getItem(BULK_KEY) === '1';
applyBulk($('#bulkToggle').checked);
$('#bulkToggle').onchange = () => { localStorage.setItem(BULK_KEY, $('#bulkToggle').checked ? '1' : '0'); applyBulk($('#bulkToggle').checked); };

// ---------- assumptions ----------
const ASM_FIELDS = [
  ['chunkSize', 'Bytes per Bluetooth write', 'Set to 20 if writes fail.'],
  ['timeoutMs', 'Response timeout (ms)', ''],
  ['queryMaxChannels', 'Max channels to read', 'Safety stop while reading.'],
  ['nameMaxBytes', 'Max channel name length', 'The official app allows 18 (non-English characters count as 3).'],
];
function renderAssumptions() {
  const f = $('#asmForm'); f.innerHTML = '';
  for (const [k, label, hint] of ASM_FIELDS) {
    const l = document.createElement('label'); l.textContent = label;
    const i = document.createElement('input'); i.type = 'number'; i.id = `asm_${k}`; i.value = Number(state.asm[k] ?? 0);
    l.appendChild(i); f.appendChild(l);
    if (hint) { const h = document.createElement('div'); h.className = 'hint'; h.textContent = hint; f.appendChild(h); }
  }
}
$('#btnAsmSave').onclick = () => {
  const a = { ...state.asm };
  for (const [k] of ASM_FIELDS) a[k] = Number($(`#asm_${k}`).value);
  state.asm = a; localStorage.setItem(ASM_KEY, JSON.stringify(a));
  if (state.client) Object.assign(state.client.opts, a);
  toneOptions(); renderTable(); banner('Assumptions saved.', 'ok');
};
$('#btnAsmReset').onclick = () => { localStorage.removeItem(ASM_KEY); state.asm = { ...DEFAULT_ASSUMPTIONS }; renderAssumptions(); toneOptions(); renderTable(); };

// ---------- boot ----------
toneOptions(); renderAssumptions(); refreshButtons(); renderFleet();
if (!WebBluetoothTransport.available()) {
  banner(location.protocol === 'file:'
    ? 'Open this app through start.cmd (it serves it on http://localhost) so Bluetooth and modules work. The Demo radio also needs that.'
    : 'This browser has no Web Bluetooth. Use Chrome or Edge on Windows. The Demo radio still works.');
}
window.addEventListener('beforeunload', (e) => { if (hasPendingEdits()) { e.preventDefault(); e.returnValue = ''; } });
window.lito = { state, codec }; // handy in DevTools for protocol research
