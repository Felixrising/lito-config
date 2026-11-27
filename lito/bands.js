// Frequencies the official BEEBEST app lets you enter, per radio region (DeviceParam.country).
// Numbers are from the app's bundled country.json (freqLimit.receive / .send), converted to Hz.
// The official keypad only accepts exact grid points (start + k*step up to end).

const r = (start, end, step) => ({ start, end, step });
const AU_RX = [r(476425000, 477400000, 25000), r(476437500, 476912500, 25000), r(477012500, 477412500, 25000)];
const AU_TX = [r(476625000, 477400000, 25000), r(476437500, 476912500, 25000), r(477012500, 477412500, 25000)];
const US = [r(462550000, 462725000, 12500), r(467562500, 467712500, 25000)];
const PMR = [r(446006250, 446193750, 12500)];
const PMR_SG = [r(446006250, 446093750, 12500)];
const EU_CODES = [826, 756, 578, 40, 56, 100, 348, 276, 300, 208, 372, 724, 380, 196, 428, 440, 442, 470, 528, 616, 620, 642, 703, 705, 246, 250, 191, 203, 752, 233];

// AU/NZ UHF CB channel number for a frequency.
function cbName(hz) {
  for (let n = 1; n <= 80; n++) {
    const f = n <= 40 ? 476425000 + (n - 1) * 25000 : 476437500 + (n - 41) * 25000;
    if (f === hz) return n === 22 || n === 23 ? `CH${n} data only` : `CH${n}`;
  }
  return '';
}
function frsName(hz) {
  for (let i = 0; i < 7; i++) if (hz === 462562500 + i * 25000) return `FRS/GMRS ${i + 1}`;
  for (let i = 0; i < 7; i++) if (hz === 467562500 + i * 25000) return `FRS ${i + 8}`;
  for (let i = 0; i < 8; i++) if (hz === 462550000 + i * 25000) return `FRS/GMRS ${i + 15}`;
  return '';
}
const pmrName = (hz) => `PMR${Math.round((hz - 446006250) / 12500) + 1}`;

export const BAND_PLANS = [
  { id: 'au', label: 'Australia', codes: [36], rx: AU_RX, tx: AU_TX, name: cbName, repeater: 750000 },
  { id: 'nz', label: 'New Zealand', codes: [554], rx: AU_RX, tx: AU_TX, name: cbName, repeater: 750000 },
  { id: 'us', label: 'United States / Canada', codes: [840, 124], rx: US, tx: US, name: frsName },
  { id: 'eu', label: 'Europe / UK', codes: EU_CODES, rx: PMR, tx: PMR, name: pmrName },
  { id: 'sg', label: 'Singapore', codes: [65], rx: PMR_SG, tx: PMR_SG, name: pmrName },
];

/** All allowed frequencies (Hz, ascending, unique) for a list of ranges. */
export function expandRanges(ranges) {
  const set = new Set();
  for (const { start, end, step } of ranges) for (let f = start; f <= end; f += step) set.add(f);
  return [...set].sort((a, b) => a - b);
}
export const planForCountry = (code) => BAND_PLANS.find((p) => p.codes.includes(code));
