import test from 'node:test';
import assert from 'node:assert/strict';
import { LitoClient } from '../lito/client.js';
import { SimulatedRadio } from '../lito/simulator.js';
import { applyConfig } from '../lito/sync.js';
import { toEditor } from '../lito/configfile.js';
import { bytesToName } from '../lito/values.js';

const config = {
  channels: [
    { chNo: 0, chType: 2, chName: 'CH10 General', chRxFreq: 476650000, chTxFreq: 476650000, chRxCss: 0, chTxCss: 0 },
    { chNo: 1, chType: 2, chName: 'CH11 Call', chRxFreq: 476675000, chTxFreq: 476675000, chRxCss: 0, chTxCss: 0 },
  ],
  settings: { voiceType: 1, voiceAlert: 1, deviceName: 'must not be cloned' },
};

test('apply the same config to several radios in parallel', async () => {
  const sims = [new SimulatedRadio({ latencyMs: 2 }), new SimulatedRadio({ latencyMs: 5 }), new SimulatedRadio({ latencyMs: 1 })];
  const clients = sims.map((s) => new LitoClient(s.transport(), { timeoutMs: 1000 }));
  for (const c of clients) { await c.open(); await c.handshake(); }
  const results = await Promise.all(clients.map((c) => applyConfig(c, config)));
  for (const r of results) {
    assert.deepEqual(r.failures, []);
    assert.equal(r.inserted, 1); assert.equal(r.modified, 1); assert.equal(r.deleted, 0);
    assert.deepEqual(r.settings.sort(), ['voiceAlert', 'voiceType']);
  }
  for (const c of clients) {
    const chans = (await c.readAllChannels()).map(toEditor);
    assert.deepEqual(chans.map((x) => x.chName), ['CH10 General', 'CH11 Call']);
    const p = await c.getDeviceParams();
    assert.equal(bytesToName(p.deviceName), 'LITO Sim');
    assert.equal(p.voiceType, 1);
  }
  // second run is a no-op
  const again = await applyConfig(clients[0], config);
  assert.equal(again.inserted + again.modified + again.deleted, 0);
  assert.deepEqual(again.settings, []);
});

test('removeExtra deletes radio channels not in the config', async () => {
  const sim = new SimulatedRadio({ latencyMs: 1 });
  const c = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await c.open(); await c.handshake();
  await applyConfig(c, { channels: [...config.channels, { chNo: 2, chType: 2, chName: 'X', chRxFreq: 476700000, chTxFreq: 476700000 }] });
  const r = await applyConfig(c, { channels: config.channels.slice(0, 1) }, { settings: false });
  assert.equal(r.deleted, 2);
  assert.equal((await c.readAllChannels()).length, 1);
});

test('shrinking 60 -> 40 on a radio that packs its list (real LITO behaviour)', async () => {
  const { buildPreset } = await import('../lito/presets.js');
  const sim = new SimulatedRadio({ latencyMs: 0 });
  const c = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await c.open(); await c.handshake();
  await applyConfig(c, { channels: buildPreset('au-ch1-60') }, { settings: false });
  assert.equal((await c.readAllChannels()).length, 60);
  const r = await applyConfig(c, { channels: buildPreset('au-ch1-40') }, { settings: false });
  assert.deepEqual(r.failures, []);
  const after = (await c.readAllChannels()).map(toEditor);
  assert.equal(after.length, 40);
  assert.equal(after[39].chName, 'CH40 Highway Truck');
});

test('a gap in the middle is closed instead of leaving the radio shifted', async () => {
  const sim = new SimulatedRadio({ latencyMs: 0 });
  const c = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await c.open(); await c.handshake();
  const five = [0, 1, 2, 3, 4].map((i) => ({ chNo: i, chType: 2, chName: `N${i}`, chRxFreq: 476425000 + i * 25000, chTxFreq: 476425000 + i * 25000, chRxCss: 0, chTxCss: 0 }));
  await applyConfig(c, { channels: five }, { settings: false });
  const without2 = five.filter((x) => x.chNo !== 2);
  const r = await applyConfig(c, { channels: without2 }, { settings: false });
  assert.deepEqual(r.failures, []);
  const after = (await c.readAllChannels()).map(toEditor);
  assert.deepEqual(after.map((x) => x.chName), ['N0', 'N1', 'N3', 'N4']);
});

test('an empty setup is refused and the radio is left alone', async () => {
  const sim = new SimulatedRadio({ latencyMs: 1 });
  const c = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await c.open(); await c.handshake();
  const before = (await c.readAllChannels()).length;
  await assert.rejects(applyConfig(c, { channels: [] }), /no channels/);
  assert.equal((await c.readAllChannels()).length, before);
});

test('onRadioRead receives the radio channels before any write', async () => {
  const sim = new SimulatedRadio({ latencyMs: 1 });
  const c = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await c.open(); await c.handshake();
  let seen = null;
  await applyConfig(c, config, { settings: false, onRadioRead: (r) => { seen = r.map((x) => x.chName); } });
  assert.deepEqual(seen, ['CAMP']);
});

test('the client refuses to insert a 61st custom channel (the radio reboots instead of refusing)', async () => {
  const sim = new SimulatedRadio({ latencyMs: 1 });
  const c = new LitoClient(sim.transport(), { timeoutMs: 1000 });
  await c.open(); await c.handshake();
  await assert.rejects(c.insertChannel({ chNo: 60, chType: 2, chName: 'X', chRxFreq: 476425000, chTxFreq: 476425000 }), /60-channel limit/);
});
