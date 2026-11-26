import test from 'node:test';
import assert from 'node:assert/strict';
import { toEditor, fromEditor, diffChannels, rowStatus, validate, buildConfigFile, parseConfigFile, channelsToCsv, csvToChannels } from '../lito/configfile.js';
import { nameToBytes, DEFAULT_ASSUMPTIONS } from '../lito/values.js';

const radio = [
  { chNo: 1, chType: 0, chRxFreq: 476425000, chTxFreq: 477175000, chName: nameToBytes('CB1') },
  { chNo: 101, chType: 2, chRxFreq: 476925000, chTxFreq: 476925000, chName: nameToBytes('CAMP'), chRxCss: 268, chTxCss: 268, _unknown: [{ no: 30, wt: 2, value: Uint8Array.from([1, 2]) }] },
];

test('editor conversion round trip', () => {
  const e = toEditor(radio[1]);
  assert.equal(e.chName, 'CAMP');
  assert.deepEqual(fromEditor(e), radio[1]);
});

test('diff detects insert / modify / delete', () => {
  const snap = new Map(radio.map((c) => [c.chNo, toEditor(c)]));
  const rows = radio.map((c) => ({ ch: toEditor(c) }));
  assert.deepEqual(diffChannels(snap, rows), { deletes: [], modifies: [], inserts: [] });
  rows[1].ch.chName = 'CAMP2';
  rows.push({ ch: { chNo: 102, chType: 2, chRxFreq: 477000000, chTxFreq: 477000000, chName: 'NEW' } });
  rows[0].deleted = true;
  const d = diffChannels(snap, rows);
  assert.equal(d.modifies.length, 1); assert.equal(d.inserts.length, 1); assert.equal(d.deletes.length, 1);
  assert.equal(rowStatus(snap, rows[2]), 'insert');
});

test('validate', () => {
  const errs = validate([{ ch: { chNo: 5, chRxFreq: 1, chTxFreq: 1 } }, { ch: { chNo: 5, chName: 'x'.repeat(40) } }], DEFAULT_ASSUMPTIONS);
  assert.ok(errs.some((e) => /duplicate/.test(e.msg)));
  assert.ok(errs.some((e) => /RX/.test(e.msg)));
  assert.ok(errs.some((e) => /longer/.test(e.msg)));
});

test('config file round trip keeps unknown fields', () => {
  const chans = radio.map(toEditor);
  const f = buildConfigFile({ device: { deviceName: nameToBytes('Radio'), verSoft: 5 }, country: 61, channels: chans, assumptions: DEFAULT_ASSUMPTIONS });
  const back = parseConfigFile(JSON.stringify(f));
  assert.equal(back.device.deviceName, 'Radio');
  assert.deepEqual(back.channels, chans);
  assert.throws(() => parseConfigFile('{"format":"x"}'), /not a LITO/);
});

test('CSV round trip', () => {
  const chans = radio.map(toEditor).map(({ _unknown, ...c }) => c);
  const csv = channelsToCsv(chans);
  assert.match(csv, /100\.0/);
  const back = csvToChannels(csv);
  assert.deepEqual(back.map((c) => ({ ...c })), chans.map((c) => ({ ...c })));
  const hand = csvToChannels('Channel,Name,RxMHz,RxTone\n7,"Hi, there",476.5,D023N\n');
  assert.equal(hand[0].chName, 'Hi, there'); assert.equal(hand[0].chTxFreq, 476500000); assert.equal(hand[0].chRxCss, 513);
});
