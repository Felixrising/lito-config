// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { crc16, encodeFrame, decodeFrame, FrameAssembler, toHex, fromHex } from '../lito/frame.js';
import { codec, LitoClient } from '../lito/client.js';
import { CMD, SEAL_SWITCH, SEAL_CHTYPE } from '../lito/schema.js';
import { SimulatedRadio } from '../lito/simulator.js';
import { cssDecode, cssParse, cssOptions, DEFAULT_ASSUMPTIONS, mhzToHz, hzToMHz, bytesToName, nameToBytes } from '../lito/values.js';

test('CRC-16/MCRF4XX check value', () => {
  assert.equal(crc16(new TextEncoder().encode('123456789')), 0x6F91);
});

test('spec worked example: query device params, seq 0', () => {
  const payload = codec.encode('SEAL_DeviceParam', { version: 1, fullInquiry: SEAL_SWITCH.SEAL_ON });
  assert.equal(toHex(payload), '08 01 18 02');
  const f = encodeFrame(CMD.DEVPARAM_QUERY, 0, payload);
  assert.equal(toHex(f), 'FE 01 00 0E 4E 23 00 00 08 01 18 02 82 DA');
  const d = decodeFrame(f);
  assert.equal(d.cmd, 20003);
  assert.deepEqual(codec.decode('SEAL_DeviceParam', d.payload), { version: 1, fullInquiry: 2 });
});

test('protobuf round trip incl. nested, bytes, big uint32, sint32, unknown fields', () => {
  const ch = { chNo: 101, chType: SEAL_CHTYPE.SEAL_USERDEF, chRxFreq: 476425000, chTxFreq: 477175000, chName: nameToBytes('CAMP'), chRxCss: 268, chElim: 1 };
  const enc = codec.encode('SEAL_ChannelInfoOperate', { version: 1, option: 2, ch });
  const dec = codec.decode('SEAL_ChannelInfoOperate', enc);
  assert.equal(dec.ch.chRxFreq, 476425000);
  assert.equal(bytesToName(dec.ch.chName), 'CAMP');
  const big = codec.decode('SEAL_ChannelInfo', codec.encode('SEAL_ChannelInfo', { chRxFreq: 4294967295 }));
  assert.equal(big.chRxFreq, 4294967295);
  const loc = codec.decode('SEAL_LocationInfo', codec.encode('SEAL_LocationInfo', { version: 1, longitude: -1534567, latitude: 275000 }));
  assert.equal(loc.longitude, -1534567);
  // unknown field 99 survives
  const withUnknown = Uint8Array.from([...enc, 0x98, 0x06, 0x07]); // field 99 varint 7
  const d2 = codec.decode('SEAL_ChannelInfoOperate', withUnknown);
  assert.deepEqual(d2._unknown, [{ no: 99, wt: 0, value: 7 }]);
  assert.deepEqual(codec.encode('SEAL_ChannelInfoOperate', d2), withUnknown);
});

test('required fields enforced', () => {
  assert.throws(() => codec.encode('SEAL_Connect', { version: 1 }), /required/);
});

test('assembler handles slices, junk and back-to-back frames', () => {
  const a = encodeFrame(20005, 1, Uint8Array.from([8, 1]));
  const b = encodeFrame(20011, 2, Uint8Array.from([8, 1, 16, 5]));
  const bad = Uint8Array.from(a); bad[bad.length - 1] ^= 0xFF;
  const got = [], errs = [];
  const asm = new FrameAssembler((f) => got.push(f.cmd), (e) => errs.push(e.message));
  const stream = Uint8Array.from([0x00, 0x11, ...bad, ...a, ...b]);
  for (let i = 0; i < stream.length; i += 3) asm.push(stream.subarray(i, i + 3));
  assert.deepEqual(got, [20005, 20011]);
  assert.ok(errs.length >= 1);
});

test('CSS encode/decode under default assumptions', () => {
  const a = DEFAULT_ASSUMPTIONS;
  assert.equal(cssDecode(0, a).label, 'Off');
  assert.equal(cssDecode(256, a).label, 'Off');   // seen on a real radio
  assert.equal(cssDecode(512, a).label, 'Off');   // seen on a real radio: RX open
  assert.equal(cssDecode(269, a).label, '103.5'); // Family Kids tone, if index is 1-based
  assert.equal(cssDecode(257, a).label, '67.0');
  assert.equal(cssParse('88.5', a), 256 + 8);
  assert.equal(cssParse('D023N', a), 513);
  assert.equal(cssParse('754I', a), 768 + 83);
  assert.equal(cssParse('raw:999', a), 999);
  assert.equal(cssOptions(a).length, 1 + 38 + 83 * 2);
  const b = { ...a, cssIndexBase: 0 };
  assert.equal(cssDecode(256, b).label, '67.0');
});

test('frequency helpers', () => {
  assert.equal(hzToMHz(476425000), '476.42500');
  assert.equal(mhzToHz('476.4375'), 476437500);
  assert.equal(mhzToHz('abc'), null);
});

test('client against simulator: handshake, params, channels, edits', async () => {
  const sim = new SimulatedRadio({ requireConfirm: true, latencyMs: 1 });
  const cl = new LitoClient(sim.transport(), { chunkSize: 20, timeoutMs: 1000, queryStreamGapMs: 20 });
  await cl.open();
  let waited = false;
  await cl.handshake({ onWait: () => { waited = true; } });
  assert.ok(waited);
  const p = await cl.getDeviceParams();
  assert.equal(bytesToName(p.deviceName), 'LITO Sim');
  await cl.setDeviceParams({ deviceName: nameToBytes('Radio 1') });
  assert.equal(bytesToName((await cl.getDeviceParams()).deviceName), 'Radio 1');
  const c = await cl.getCountry();
  assert.equal(c.country, 36);
  let prog = 0;
  const chans = await cl.readAllChannels({ onProgress: (n) => { prog = n; } });
  assert.equal(chans.length, 1);
  assert.equal(prog, 1);
  assert.equal(chans[0].chNo, 0);
  await cl.insertChannel({ chNo: 1, chType: SEAL_CHTYPE.SEAL_USERDEF, chRxFreq: 477000000, chTxFreq: 477000000, chName: nameToBytes('NEW') });
  await cl.modifyChannel({ ...chans[0], chName: nameToBytes('CAMP2') });
  await assert.rejects(cl.modifyChannel({ chNo: 1, chType: 0, chName: nameToBytes('X') }), /FORBIDE/);
  await cl.deleteChannel({ chNo: 1, chType: SEAL_CHTYPE.SEAL_USERDEF });
  const after = await cl.readAllChannels();
  assert.equal(after.length, 1);
  assert.equal(bytesToName(after[0].chName), 'CAMP2');
});

test('fromHex/toHex', () => { assert.equal(toHex(fromHex('fe01 000e')), 'FE 01 00 0E'); });

test('channel read: channel 0 without chNo, then by number until EMPTY', async () => {
  const sim = new SimulatedRadio({ latencyMs: 1 });
  const cl = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await cl.open(); await cl.handshake();
  const sent = []; cl.on('frame', (f) => { if (f.dir === 'tx' && f.cmd === CMD.CHINFO_QUERY) sent.push(f.msg); });
  const chans = await cl.readAllChannels();
  assert.deepEqual(chans.map((c) => c.chNo), [0]);
  assert.deepEqual(sent[0], { version: 1, option: 3, ch: { chType: 2 } });
  assert.deepEqual(sent[1], { version: 1, option: 3, ch: { chType: 2, chNo: 1 } });
  assert.equal(sent.length, 2);
  // first request bytes: 08 01 18 03 22 02 10 02
  assert.equal(toHex(codec.encode('SEAL_ChannelInfoOperate', sent[0])), '08 01 18 03 22 02 10 02');
});

test('duplicate notifications are ignored', async () => {
  const sim = new SimulatedRadio({ latencyMs: 1, sliceSize: 512 });
  const t = sim.transport();
  const origOpen = t.open.bind(t);
  t.open = async () => { await origOpen(); const f = sim.toApp; sim.toApp = (b) => { f(b); f(b); }; };
  const cl = new LitoClient(t, { timeoutMs: 1000 });
  await cl.open(); await cl.handshake();
  await cl.insertChannel({ chNo: 1, chType: 2, chRxFreq: 476700000, chTxFreq: 476700000, chName: nameToBytes('B') });
  await cl.insertChannel({ chNo: 2, chType: 2, chRxFreq: 476725000, chTxFreq: 476725000, chName: nameToBytes('C') });
  const chans = await cl.readAllChannels();
  assert.deepEqual(chans.map((c) => c.chNo), [0, 1, 2]);
});
