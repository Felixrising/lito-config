import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BAND_PLANS } from '../lito/bands.js';
import { DEFAULT_ASSUMPTIONS as asm } from '../lito/values.js';
import { txMode, followRx, splitClipboard, mapPaste, parseFreq, rowsToTsv, applyCells, headerKey } from '../app/grid.js';

const au = BAND_PLANS.find((p) => p.id === 'au'), us = BAND_PLANS.find((p) => p.id === 'us');
const CH = (n) => (n <= 40 ? 476425000 + (n - 1) * 25000 : 476437500 + (n - 41) * 25000);
const opts = { plan: au, asm };

test('mode follows TX', () => {
  assert.equal(txMode({ chRxFreq: CH(11), chTxFreq: CH(11) }, au), 'simplex');
  assert.equal(txMode({ chRxFreq: CH(1), chTxFreq: CH(31) }, au), 'repeater');
  assert.equal(txMode({ chRxFreq: CH(41), chTxFreq: CH(71) }, au), 'repeater');
  assert.equal(txMode({ chRxFreq: CH(11), chTxFreq: 0 }, au), 'listen');
  assert.equal(txMode({ chRxFreq: CH(11), chTxFreq: CH(12) }, au), 'custom');
  assert.equal(txMode({ chRxFreq: 462550000, chTxFreq: 462550000 + 750000 }, us), 'custom'); // no 750 kHz repeaters outside AU/NZ
});

test('changing RX keeps the mode, and AU repeater outputs fall back sensibly', () => {
  const ch = { chRxFreq: CH(1), chTxFreq: CH(31) };
  ch.chRxFreq = CH(5); followRx(ch, CH(1), au); assert.equal(ch.chTxFreq, CH(35));
  ch.chRxFreq = CH(20); followRx(ch, CH(5), au); assert.equal(ch.chTxFreq, CH(20), 'CH20 has no repeater: simplex');
  ch.chRxFreq = CH(3); followRx(ch, CH(20), au); assert.equal(ch.chTxFreq, CH(33), 'CH1-8 can only transmit via the repeater');
  const l = { chRxFreq: CH(10), chTxFreq: 0 }; l.chRxFreq = CH(12); followRx(l, CH(10), au); assert.equal(l.chTxFreq, 0);
});

test('frequencies parse from MHz, Hz and channel numbers', () => {
  assert.equal(parseFreq('476.425', au), CH(1));
  assert.equal(parseFreq('476425000', au), CH(1));
  assert.equal(parseFreq('CH40', au), CH(40));
  assert.equal(parseFreq('ch 41', au), CH(41));
  assert.equal(parseFreq('nonsense', au), null);
});

test('copied rows paste back the same, and Excel text maps by header', () => {
  const chans = [{ chNo: 0, chType: 2, chName: 'Rpt1', chRxFreq: CH(1), chTxFreq: CH(31), chRxCss: 0, chTxCss: 0 }];
  const tsv = rowsToTsv(chans, opts);
  assert.match(tsv, /^Slot\tName\tRX MHz\tMode\tTX MHz\tRX tone\tTX tone\r\nC01\tRpt1\t476.42500\tRepeater \(\+750 kHz\)\t477.17500\tOff\tOff\r\n$/);
  const { keys, rows } = mapPaste(splitClipboard(tsv));
  const ch = { chRxFreq: CH(10), chTxFreq: CH(10) };
  assert.deepEqual(applyCells(ch, Object.fromEntries(keys.map((k, i) => [k, rows[0][i]]).filter(([k]) => k)), opts), []);
  assert.deepEqual(ch, { chRxFreq: CH(1), chTxFreq: CH(31), chName: 'Rpt1', chRxCss: 0, chTxCss: 0 });

  const xl = mapPaste(splitClipboard('Frequency\tName\tTone\r\n476.525\tHome\t103.5\r\n'));
  assert.deepEqual(xl.keys, ['rx', 'name', 'txTone']);
  const c2 = { chRxFreq: CH(10), chTxFreq: CH(10) };
  applyCells(c2, { rx: '476.525', name: 'Home', txTone: '103.5' }, opts);
  assert.equal(c2.chRxFreq, CH(5)); assert.equal(c2.chTxFreq, CH(35), 'CH5 simplex is not allowed, so it becomes the repeater');
  assert.equal(c2.chTxCss, 269);
});

test('paste without a header fills from the focused column, dropping a slot column', () => {
  assert.deepEqual(mapPaste([['476.425', 'Simplex']], 'rx').keys, ['rx', 'mode']);
  assert.deepEqual(mapPaste([['C01', 'A', '476.425'], ['C02', 'B', '476.45']], 'name').keys, ['name', 'rx']);
  assert.equal(headerKey('Fréquence RX', (s) => (s === 'RX MHz' ? 'Fréquence RX' : s)), 'rx');
});

test('bad cells are reported and leave the channel alone', () => {
  const ch = { chRxFreq: CH(10), chTxFreq: CH(10), chTxCss: 0 };
  assert.deepEqual(applyCells(ch, { rx: 'abc', txTone: '999.9', mode: 'Listen only' }, opts), ['rx', 'txTone']);
  assert.equal(ch.chRxFreq, CH(10)); assert.equal(ch.chTxFreq, 0);
});
