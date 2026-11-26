import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreset, PRESETS } from '../lito/presets.js';

test('AU UHF CB preset', () => {
  const c = buildPreset('au-uhf-cb', {}, { chSq: 1, chBand: 1 });
  assert.equal(c.length, 75); // 80 - 22,23 - 61,62,63
  const by = (n) => c.find((x) => x.chName.startsWith(`CH${n} `) || x.chName === `CH${n}`);
  assert.equal(by(1).chRxFreq, 476425000); assert.equal(by(1).chTxFreq, 477175000);
  assert.equal(by(10).chRxFreq, 476650000); assert.equal(by(11).chRxFreq, 476675000);
  assert.equal(by(40).chRxFreq, 477400000); assert.equal(by(41).chRxFreq, 476437500);
  assert.equal(by(80).chRxFreq, 477412500); assert.equal(by(9).chTxFreq, by(9).chRxFreq);
  assert.equal(c[0].chNo, 0); assert.equal(c[0].chSq, 1);
  assert.ok(c.every((x) => x.chName.length <= 18));
  assert.equal(buildPreset('au-uhf-cb', { includeRepeaterInputs: false }).length, 59);
  assert.equal(buildPreset('au-uhf-cb', { duplexRepeaters: false }).find((x) => x.chName === 'CH1 Repeater').chTxFreq, 476425000);
});

test('other presets', () => {
  const frs = buildPreset('us-frs');
  assert.equal(frs.length, 22); assert.equal(frs[0].chRxFreq, 462562500); assert.equal(frs[7].chRxFreq, 467562500); assert.equal(frs[21].chRxFreq, 462725000);
  const pmr = buildPreset('eu-pmr446');
  assert.equal(pmr.length, 16); assert.equal(pmr[0].chRxFreq, 446006250); assert.equal(pmr[15].chRxFreq, 446193750);
  const g = buildPreset('us-gmrs'); assert.equal(g.length, 30); assert.equal(g[22].chTxFreq, 467550000);
  for (const p of PRESETS) assert.ok(buildPreset(p.id).every((x) => x.chName.length <= 18));
});

test('AU variants', () => {
  const fam = buildPreset('au-family');
  assert.equal(fam.length, 10);
  assert.equal(fam.find((c) => c.chName === 'CH15 Family Kids 1').chRxFreq, 476775000);
  assert.equal(fam.find((c) => c.chName === 'CH15 Family Kids 1').chTxCss, 269);
  assert.ok(fam.every((c) => c.chRxFreq !== 476950000 && c.chRxFreq !== 476975000)); // no 22/23
  assert.ok(fam.every((c) => c.chTxFreq === c.chRxFreq));
  const ess = buildPreset('au-essentials');
  assert.equal(ess.find((c) => c.chName === 'CH5 EMERGENCY').chTxFreq, 476525000 + 750000);
  assert.equal(buildPreset('au-touring').length, 16);
});

test('slot-aligned AU presets', () => {
  const a = buildPreset('au-ch1-40', {}, {}, 99);
  assert.equal(a.length, 40);
  assert.ok(a.every((c, i) => c.chNo === i && c.chName.startsWith(`CH${i + 1} `) || c.chName === `CH${i + 1}`));
  assert.equal(a[9].chName, 'CH10 4WD Parks'); assert.equal(a[9].chRxFreq, 476650000);
  assert.equal(a[21].chName, 'CH22 DATA NO VOICE');
  assert.equal(a[0].chTxFreq, 477175000);
  const b = buildPreset('au-ch1-60');
  assert.equal(b.length, 60); assert.equal(b[59].chNo, 59); assert.equal(b[59].chRxFreq, 476437500 + 19 * 25000);
  assert.equal(b[40].chTxFreq, b[40].chRxFreq + 750000); // CH41 repeater
});
