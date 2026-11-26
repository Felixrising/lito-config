// Apply a saved configuration to a radio: read what's there, write only the differences.
// Used for programming many radios with the same config (in parallel, one LitoClient each).

import { toEditor, fromEditor, diffChannels, compactUserChannels } from './configfile.js';
import { SEAL_CHTYPE } from './schema.js';

// Settings that make sense to clone across radios. Names stay unique per radio.
export const CLONEABLE_SETTINGS = ['voiceType', 'voiceAlert', 'shareLoc', 'pwsaveMode'];

/**
 * @param {LitoClient} client  connected + handshaken
 * @param {{channels: object[], settings?: object}} config  editor channels, device settings
 * @param {{channels?: boolean, settings?: boolean, removeExtra?: boolean, onStep?: (text: string) => void}} opts
 * @returns {Promise<{inserted, modified, deleted, settings: string[], failures: string[]}>}
 */
export async function applyConfig(client, config, { channels = true, settings = true, removeExtra = true, onStep = () => {}, onRadioRead = () => {} } = {}) {
  // Never wipe a radio by writing an empty setup (e.g. after a page reload cleared the editor).
  if (channels && !config.channels.some((c) => c.chType !== SEAL_CHTYPE.SEAL_PUBLIC)) throw new Error('The setup has no channels, so nothing was written. Load a preset or file first.');
  const out = { inserted: 0, modified: 0, deleted: 0, settings: [], failures: [] };

  if (settings && config.settings) {
    onStep('Reading settings…');
    const cur = await client.getDeviceParams();
    const changes = {};
    for (const k of CLONEABLE_SETTINGS) {
      if (config.settings[k] !== undefined && config.settings[k] !== cur[k]) changes[k] = config.settings[k];
    }
    if (Object.keys(changes).length) {
      onStep('Writing settings…');
      try { await client.setDeviceParams(changes); out.settings = Object.keys(changes); }
      catch (e) { out.failures.push(`settings: ${e.message}`); }
    }
  }

  if (channels) {
    onStep('Reading channels…');
    const radio = (await client.readAllChannels()).map(toEditor);
    await onRadioRead(radio); // lets the caller save a backup before anything changes
    const snapshot = new Map(radio.map((c) => [c.chNo, c]));
    const wanted = config.channels.filter((c) => c.chType !== SEAL_CHTYPE.SEAL_PUBLIC);
    const rows = wanted.map((c) => ({ ch: { ...c } }));
    // Packed list: target is slots 0..N-1. Extra radio slots are deleted, or kept after ours.
    if (!removeExtra) for (const c of radio) if (c.chNo >= wanted.length) rows.push({ ch: { ...c, chNo: 1e6 + c.chNo } });
    compactUserChannels(rows, removeExtra ? snapshot : new Map());
    const d = diffChannels(snapshot, rows);
    const total = d.deletes.length + d.modifies.length + d.inserts.length;
    let n = 0;
    const run = async (label, ch, fn, key) => {
      onStep(`Writing channels ${++n}/${total}…`);
      try { await fn(fromEditor(ch)); out[key]++; } catch (e) { out.failures.push(`${label} ${ch.chNo}: ${e.message}`); }
    };
    // The radio packs the list (a delete shifts later slots down), so delete from the top slot down,
    // then modify, then append inserts in order.
    for (const ch of [...d.deletes].sort((a, b) => b.chNo - a.chNo)) await run('delete', ch, (c) => client.deleteChannel(c), 'deleted');
    for (const ch of d.modifies) await run('modify', ch, (c) => client.modifyChannel(c), 'modified');
    for (const ch of [...d.inserts].sort((a, b) => a.chNo - b.chNo)) await run('insert', ch, (c) => client.insertChannel(c), 'inserted');
  }
  onStep(out.failures.length ? `Done with ${out.failures.length} error(s)` : 'Done');
  return out;
}

export function summarize(r) {
  const parts = [];
  if (r.inserted) parts.push(`${r.inserted} added`);
  if (r.modified) parts.push(`${r.modified} changed`);
  if (r.deleted) parts.push(`${r.deleted} deleted`);
  if (r.settings.length) parts.push(`settings: ${r.settings.join(', ')}`);
  if (!parts.length) parts.push('already matched');
  if (r.failures.length) parts.push(`FAILED: ${r.failures.join('; ')}`);
  return parts.join(', ');
}
