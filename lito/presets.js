// Country channel presets. Each returns editor channels (user-defined, numbered from 0).
// Frequencies are from the public band plans named in `source`. Check local rules before use:
// the LITO hardware may also refuse frequencies outside its own region's band.

import { SEAL_CHTYPE } from './schema.js';

const kHz = 1000;

function auNames(n) {
  const names = {
    5: 'EMERG RPT', 35: 'EMERG RPT IN', 9: 'General', 10: '4WD Parks', 11: 'Call', 18: 'Caravans',
    29: 'Pacific Hwy', 40: 'Highway Truck',
  };
  if (names[n]) return `CH${n} ${names[n]}`;
  if ((n >= 1 && n <= 8) || (n >= 41 && n <= 48)) return `CH${n} Repeater`;
  return `CH${n}`;
}

function auNzPlan({ duplexRepeaters, includeRepeaterInputs, region }) {
  const out = [];
  for (let n = 1; n <= 80; n++) {
    if (n === 22 || n === 23) continue;             // telemetry/telecommand only, no voice
    if (n >= 61 && n <= 63) continue;               // reserved guard channels
    const isInput = (n >= 31 && n <= 38) || (n >= 71 && n <= 78);
    if (isInput && !includeRepeaterInputs) continue;
    const rx = n <= 40 ? 476425 * kHz + (n - 1) * 25 * kHz : 476437.5 * kHz + (n - 41) * 25 * kHz;
    const isRpt = (n >= 1 && n <= 8) || (n >= 41 && n <= 48);
    out.push({ n, name: region === 'NZ' ? `CH${n}` : auNames(n), rx, tx: isRpt && duplexRepeaters ? rx + 750 * kHz : rx });
  }
  return out;
}

export const auFreq = (n) => (n <= 40 ? 476425 * kHz + (n - 1) * 25 * kHz : 476437.5 * kHz + (n - 41) * 25 * kHz);
const auRpt = (n) => (n >= 1 && n <= 8) || (n >= 41 && n <= 48);

/** [[channel, name, {tone?, duplex?}]] -> preset channels. tone is a raw CSS value (see Protocol assumptions). */
function auList(list, o = {}) {
  return list.map(([n, name, x = {}]) => {
    const rx = auFreq(n);
    const duplex = auRpt(n) && (x.duplex ?? o.duplexRepeaters);
    return { n, name, rx, tx: duplex ? rx + 750 * kHz : rx, rxCss: x.rxTone ?? x.tone, txCss: x.tone };
  });
}

// Tone used on the Family Kids channels: 269 = CTCSS 103.5 Hz (confirmed in the official app).

const FAMILY_TONE = 269;

function auAligned(last, { duplexRepeaters, dataSlots }) {
  const out = [];
  for (let n = 1; n <= last; n++) {
    const rx = auFreq(n);
    if (n >= 61 && n <= 63) { out.push({ n, name: `CH${n} RESERVED`, rx, tx: rx }); continue; } // guard channels: do not transmit
    if (n === 22 || n === 23) {
      if (dataSlots === 'skip') continue;
      out.push({ n, name: `CH${n} DATA NO VOICE`, rx, tx: rx });
      continue;
    }
    out.push({ n, name: auNames(n), rx, tx: auRpt(n) && duplexRepeaters ? rx + 750 * kHz : rx });
  }
  return out;
}

export const PRESETS = [
  {
    id: 'au-ch1-40', country: 'Australia', name: 'CH1-40, slot = channel (C01 = CH1)',
    source: 'ACMA CB Class Licence 2015',
    verified: true, slotIsChannel: true,
    notes: 'C01 holds CH1, C40 holds CH40. Slots 22 and 23 are labelled DATA NO VOICE: voice is not allowed on those channels, so never talk on them. Repeater channels 1-8 transmit +750 kHz when duplex is on.',
    options: { duplexRepeaters: true },
    build: (o) => auAligned(40, o),
  },
  {
    id: 'au-ch1-60', country: 'Australia', name: 'CH1-60, slot = channel (fills all 60)',
    source: 'ACMA CB Class Licence 2015',
    verified: true, slotIsChannel: true,
    notes: 'Uses all 60 custom slots: C01 = CH1 ... C60 = CH60. Slots 22 and 23 are labelled DATA NO VOICE (voice not allowed). Repeaters 1-8 and 41-48 transmit +750 kHz when duplex is on.',
    options: { duplexRepeaters: true },
    build: (o) => auAligned(60, o),
  },
  {
    id: 'au-ch1-80', country: 'Australia', name: 'CH1-80, slot = channel (needs an 80-channel radio)',
    source: 'ACMA CB Class Licence 2015',
    verified: true, slotIsChannel: true, needsChannels: 80,
    notes: 'C01 = CH1 ... C80 = CH80. Only works if your radio holds 80 custom channels: run the channel limit test (About > developer tools > Log) first. CH22/23 are DATA NO VOICE and CH61-63 are RESERVED guard channels: never transmit on those. Repeaters 1-8 and 41-48 transmit +750 kHz when duplex is on.',
    options: { duplexRepeaters: true },
    build: (o) => auAligned(80, o),
  },
  {
    id: 'au-essentials', country: 'Australia', name: 'Essentials (8 channels)',
    source: 'ACMA CB Class Licence 2015; common Australian channel conventions',
    verified: true,
    notes: 'CH5 emergency repeater, CH9/10/11/18/29/40 by convention, CH35 emergency simplex. Conventions are custom, not law (except CH5/35 emergency and no voice on 22/23).',
    options: { duplexRepeaters: true },
    build: (o) => auList([[5, 'CH5 EMERGENCY'], [9, 'CH9 General'], [10, 'CH10 4WD Parks'], [11, 'CH11 Call/Find'],
      [18, 'CH18 Caravans'], [29, 'CH29 Pacific Hwy'], [35, 'CH35 Emergency'], [40, 'CH40 Highway']], o),
  },
  {
    id: 'au-touring', country: 'Australia', name: 'Touring / 4WD (16 channels)',
    source: 'ACMA CB Class Licence 2015; common Australian channel conventions',
    verified: true,
    notes: 'Highway, convoy and 4WD channels plus repeater channels 1-8 (duplex, +750 kHz) for outback/regional repeaters.',
    options: { duplexRepeaters: true },
    build: (o) => auList([[10, 'CH10 4WD Parks'], [18, 'CH18 Caravans'], [40, 'CH40 Highway'], [29, 'CH29 Pacific Hwy'],
      [11, 'CH11 Call/Find'], [5, 'CH5 EMERGENCY'], [35, 'CH35 Emergency'],
      [1, 'CH1 Repeater'], [2, 'CH2 Repeater'], [3, 'CH3 Repeater'], [4, 'CH4 Repeater'], [6, 'CH6 Repeater'], [7, 'CH7 Repeater'], [8, 'CH8 Repeater'],
      [9, 'CH9 General'], [12, 'CH12 General']], o),
  },
  {
    id: 'au-family', country: 'Australia', name: 'Family (10 channels, kids channels with a tone)',
    source: 'Based on a real family setup, 2026-11-26',
    verified: true,
    notes: 'A family layout. Family Kids channels use CTCSS 103.5 Hz so the kids only hear each other. CH24 is used instead of CH22, which is telemetry only (no voice).',
    build: (o) => auList([[10, 'CH10 General use'], [11, 'CH11 Call/Find'], [14, 'CH14 General OPEN'],
      [15, 'CH15 Family Kids 1', { tone: FAMILY_TONE }], [16, 'CH16 General chat'], [17, 'CH17 Family Kids 2', { tone: FAMILY_TONE }],
      [18, 'CH18 Camping 4WD'], [20, 'CH20 Family Kids 3', { tone: FAMILY_TONE }], [24, 'CH24 General use 2'], [40, 'CH40 Convoy/Hwy']], o),
  },

  {
    id: 'au-uhf-cb', country: 'Australia', name: 'Full UHF CB band (75 voice channels)',
    source: 'ACMA Radiocommunications (Citizen Band Radio Stations) Class Licence 2015',
    verified: true,
    notes: 'Skips 22/23 (telemetry only) and 61-63 (reserved). Max 5 W. Repeater channels 1-8 and 41-48 transmit +750 kHz when duplex is on. Ch 5/35 emergency.',
    options: { duplexRepeaters: true, includeRepeaterInputs: true },
    build: (o) => auNzPlan({ ...o, region: 'AU' }),
  },
  {
    id: 'nz-uhf-prs', country: 'New Zealand', name: 'UHF PRS / CB, 80 channels',
    source: 'RSM General User Radio Licence for Citizen Band Radio (aligned with the AU plan)',
    verified: false,
    notes: 'UNVERIFIED: assumes the same 80-channel plan as Australia. Check RSM rules before use.',
    options: { duplexRepeaters: true, includeRepeaterInputs: true },
    build: (o) => auNzPlan({ ...o, region: 'NZ' }),
  },
  {
    id: 'us-frs', country: 'United States', name: 'FRS, 22 channels',
    source: 'FCC 47 CFR 95.563',
    verified: true,
    notes: 'Licence-free. 2 W on 1-7 and 15-22, 0.5 W on 8-14. Out of the AU LITO\'s band, so an AU radio will probably refuse these.',
    build: () => {
      const f = [];
      for (let i = 0; i < 7; i++) f.push(462562.5 * kHz + i * 25 * kHz);
      for (let i = 0; i < 7; i++) f.push(467562.5 * kHz + i * 25 * kHz);
      for (let i = 0; i < 8; i++) f.push(462550 * kHz + i * 25 * kHz);
      return f.map((rx, i) => ({ n: i + 1, name: `FRS${i + 1}`, rx, tx: rx }));
    },
  },
  {
    id: 'us-gmrs', country: 'United States', name: 'GMRS, 22 + 8 repeater',
    source: 'FCC 47 CFR 95.1763',
    verified: true,
    notes: 'Needs an FCC GMRS licence. Repeater channels transmit +5 MHz. Out of the AU LITO\'s band.',
    options: { duplexRepeaters: true },
    build: (o) => {
      const f = [];
      for (let i = 0; i < 7; i++) f.push(462562.5 * kHz + i * 25 * kHz);
      for (let i = 0; i < 7; i++) f.push(467562.5 * kHz + i * 25 * kHz);
      for (let i = 0; i < 8; i++) f.push(462550 * kHz + i * 25 * kHz);
      const out = f.map((rx, i) => ({ n: i + 1, name: `GMRS${i + 1}`, rx, tx: rx }));
      if (o.duplexRepeaters) for (let i = 0; i < 8; i++) out.push({ n: 23 + i, name: `GMRS RPT${15 + i}`, rx: f[14 + i], tx: f[14 + i] + 5000 * kHz });
      return out;
    },
  },
  {
    id: 'eu-pmr446', country: 'EU / UK', name: 'PMR446, 16 channels',
    source: 'ECC Decision (15)05; Ofcom IR 2030',
    verified: true,
    notes: 'Licence-free, 0.5 W ERP, 12.5 kHz. Out of the AU LITO\'s band.',
    build: () => Array.from({ length: 16 }, (_, i) => {
      const rx = 446006.25 * kHz + i * 12.5 * kHz;
      return { n: i + 1, name: `PMR${i + 1}`, rx, tx: rx };
    }),
  },
];

/**
 * Turn a preset into editor channels.
 * @param {object} template  a channel whose squelch/power/etc. to copy (those fields aren't decoded yet)
 */
export function buildPreset(id, options = {}, template = {}, startNo = 0) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown preset ${id}`);
  const o = { ...(p.options || {}), ...options };
  const copy = {};
  for (const k of ['chTxPower', 'chSq', 'chVox', 'chElim', 'chBand', 'chPolite', 'chPowerLevel']) if (template[k] !== undefined) copy[k] = template[k];
  // Keep the radio's slot order the same as the CB channel order (C01 lowest CH number, and so on).
  return p.build(o).sort((a, b) => a.n - b.n).map((c, i) => ({
    chNo: p.slotIsChannel ? c.n - 1 : startNo + i, chType: SEAL_CHTYPE.SEAL_USERDEF, chName: c.name.slice(0, 18),
    chRxFreq: Math.round(c.rx), chTxFreq: Math.round(c.tx), chRxCss: c.rxCss ?? 0, chTxCss: c.txCss ?? 0, ...copy,
  }));
}

