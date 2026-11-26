// Transport-agnostic LITO client. A transport is any object with:
//   open(): Promise, write(Uint8Array): Promise, close(): Promise,
//   onData = (Uint8Array) => void, onDisconnect = () => void
// so the same client works over Web Bluetooth, a simulator, or (later) a native BLE bridge.

import { createCodec } from './protobuf.js';
import { MESSAGES, CMD, CMD_MESSAGE, SEAL_SWITCH, SEAL_CONNCODE, SEAL_CHOPTION, SEAL_CH_UERR, SEAL_CHTYPE, SEAL_DEV_UERR, enumName, cmdName } from './schema.js';
import { encodeFrame, FrameAssembler } from './frame.js';
import { DEFAULT_ASSUMPTIONS } from './values.js';

export const codec = createCodec(MESSAGES);

export class ProtocolError extends Error {}

export const MAX_USER_CHANNELS = 60;

export class LitoClient {
  constructor(transport, opts = {}) {
    this.t = transport;
    this.opts = { ...DEFAULT_ASSUMPTIONS, ...opts };
    this.seq = 0;
    this.waiters = [];               // {cmd, resolve, reject, timer}
    this.listeners = { frame: [], unsolicited: [], disconnect: [], error: [] };
    this.queue = Promise.resolve();
    this.asm = new FrameAssembler((fr, raw) => this._onFrame(fr, raw), (e, raw) => this._emit('error', e, raw));
    this.t.onData = (chunk) => this.asm.push(chunk);
    this.t.onDisconnect = () => { this._failAll(new ProtocolError('disconnected')); this._emit('disconnect'); };
  }

  on(ev, fn) { this.listeners[ev].push(fn); return () => { this.listeners[ev] = this.listeners[ev].filter((f) => f !== fn); }; }
  _emit(ev, ...args) { for (const fn of this.listeners[ev]) { try { fn(...args); } catch (e) { console.error(e); } } }

  static decodePayload(cmd, payload) {
    const m = CMD_MESSAGE[cmd];
    if (!m) return null;
    try { return codec.decode(m, payload); } catch (e) { return { _decodeError: e.message }; }
  }

  _onFrame(fr, raw) {
    // Windows/Chrome sometimes delivers the same notification twice (seen on a real LITO after a
    // reconnect). An identical frame within 50 ms is a duplicate, not a new reply: drop it.
    const now = Date.now();
    if (this._last && now - this._last.t < 50 && this._last.raw.length === raw.length && this._last.raw.every((b, i) => b === raw[i])) {
      this._emit('error', new Error('duplicate notification ignored'), raw);
      return;
    }
    this._last = { t: now, raw };
    const msg = LitoClient.decodePayload(fr.cmd, fr.payload);
    this._emit('frame', { dir: 'rx', cmd: fr.cmd, seq: fr.seq, raw, msg });
    const i = this.waiters.findIndex((w) => w.cmd === fr.cmd);
    if (i >= 0) {
      const [w] = this.waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve({ ...fr, msg });
    } else {
      this._emit('unsolicited', { ...fr, msg });
    }
  }

  _failAll(err) { for (const w of this.waiters.splice(0)) { clearTimeout(w.timer); w.reject(err); } }

  async open() { this.seq = 0; this.asm.reset(); await this.t.open(); }
  async close() {
    try { await this.send(CMD.CONNECT, 'SEAL_Connect', { version: 1, connCode: SEAL_CONNCODE.SEAL_DISCONNECT }); } catch { /* best effort */ }
    await this.t.close();
  }

  /** Encode and write one frame, split into GATT-sized chunks. */
  async send(cmd, msgName, obj) {
    const payload = msgName ? codec.encode(msgName, obj) : new Uint8Array(0);
    return this.sendPayload(cmd, payload, obj);
  }

  /** Write a frame around an already-encoded payload (useful for protocol research). */
  async sendPayload(cmd, payload, logMsg = LitoClient.decodePayload(cmd, payload)) {
    const seq = this.seq; this.seq = (this.seq + 1) & 0xFFFF;
    const raw = encodeFrame(cmd, seq, payload);
    this._emit('frame', { dir: 'tx', cmd, seq, raw, msg: logMsg });
    const n = Math.max(20, this.opts.chunkSize | 0);
    for (let off = 0; off < raw.length; off += n) await this.t.write(raw.subarray(off, off + n));
    return raw;
  }

  /** Wait for the next frame with this command ID. Resolves null on timeout when soft=true. */
  waitFor(cmd, timeoutMs = this.opts.timeoutMs, soft = false) {
    return new Promise((resolve, reject) => {
      const w = { cmd, resolve, reject };
      w.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        if (soft) resolve(null); else reject(new ProtocolError(`timeout waiting for ${cmdName(cmd)} (${cmd})`));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }

  /** Serialise whole operations so request/response pairs never interleave. */
  _exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async _request(cmd, msgName, obj, respCmd, timeoutMs) {
    const p = this.waitFor(respCmd, timeoutMs);
    try { await this.send(cmd, msgName, obj); } catch (e) { p.catch(() => {}); throw e; }
    return (await p).msg;
  }

  request(cmd, msgName, obj, respCmd, timeoutMs) {
    return this._exclusive(() => this._request(cmd, msgName, obj, respCmd, timeoutMs));
  }

  /** Handshake. If the radio answers WAIT (asks the user to confirm on the radio), keep waiting. */
  handshake({ deviceId, waitForUserMs = 30000, onWait } = {}) {
    return this._exclusive(async () => {
      const req = { version: 1, connCode: SEAL_CONNCODE.SEAL_CONNECT, appMode: 0, deviceType: 26, language: 1 };
      if (deviceId != null) req.deviceId = deviceId;
      let r = await this._request(CMD.CONNECT, 'SEAL_Connect', req, CMD.CONNECT_RESP);
      const deadline = Date.now() + waitForUserMs;
      while (r.connCode === SEAL_CONNCODE.SEAL_WAIT && Date.now() < deadline) {
        onWait?.();
        const next = await this.waitFor(CMD.CONNECT_RESP, Math.max(1, deadline - Date.now()), true);
        if (!next) break;
        r = next.msg;
      }
      if (r.connCode !== SEAL_CONNCODE.SEAL_ALLOW) throw new ProtocolError(`radio did not accept connection: ${enumName(SEAL_CONNCODE, r.connCode)}`);
      return r;
    });
  }

  async getDeviceParams() {
    const r = await this.request(CMD.DEVPARAM_QUERY, 'SEAL_DeviceParam', { version: 1, fullInquiry: SEAL_SWITCH.SEAL_ON }, CMD.DEVPARAM_RESP);
    if (r.result === SEAL_DEV_UERR.SEAL_PARAM_QUERY_ERROR) throw new ProtocolError('radio reported PARAM_QUERY_ERROR');
    return r;
  }

  /** Send only the changed fields. */
  async setDeviceParams(changes) {
    const r = await this.request(CMD.DEVPARAM_MODIFY, 'SEAL_DeviceParam', { version: 1, ...changes }, CMD.DEVPARAM_RESP);
    if (r.result !== SEAL_DEV_UERR.SEAL_PARAM_UPDATE_OK) throw new ProtocolError(`settings not saved: ${enumName(SEAL_DEV_UERR, r.result)}`);
    return r;
  }

  getCountry() { return this.request(CMD.COUNTRY_QUERY, 'SEAL_DeviceCountry', { version: 1 }, CMD.COUNTRY_RESP); }

  getChannelState() {
    return this.request(CMD.CHSTATE_QUERY, 'SEAL_ChannelStateOperate', { version: 1, option: 1 /* ST_QUERY */ }, CMD.CHSTATE_RESP);
  }

  /** Query one channel by number. */
  readChannel(chNo, chType = SEAL_CHTYPE.SEAL_USERDEF) {
    return this.request(CMD.CHINFO_QUERY, 'SEAL_ChannelInfoOperate', { version: 1, option: SEAL_CHOPTION.SEAL_CH_QUERY, ch: { chType, chNo } }, CMD.CHINFO_RESP);
  }

  /**
   * Read all user channels.
   * Seen on a real LITO (fw 0x01000008): {option: QUERY, ch: {chType: USERDEF}} with no chNo returns
   * user channel 0 (result CONTINUE). Acking with result=OK just replays channel 0, but asking for
   * {chType: USERDEF, chNo: n} returns channel n with result OK. So: channel 0 first, then ask by number
   * until the radio says EMPTY/FINISH/ERROR, returns a different number, returns junk, or goes quiet.
   */
  readAllChannels({ onProgress, chType = SEAL_CHTYPE.SEAL_USERDEF } = {}) {
    const o = this.opts;
    const U = SEAL_CH_UERR;
    return this._exclusive(async () => {
      const found = new Map();
      const ask = async (ch) => {
        const p = this.waitFor(CMD.CHINFO_RESP, o.timeoutMs, true);
        await this.send(CMD.CHINFO_QUERY, 'SEAL_ChannelInfoOperate', { version: 1, option: SEAL_CHOPTION.SEAL_CH_QUERY, ch });
        return (await p)?.msg ?? null;
      };
      const good = (r, n) => r && [U.SEAL_CH_OK, U.SEAL_CH_QUERY_CONTINUE, U.SEAL_CH_QUERY_FINISH].includes(r.result ?? U.SEAL_CH_OK)
        && r.ch && (r.ch.chNo ?? 0) === n && (r.ch.chRxFreq || r.ch.chTxFreq);

      const first = await ask({ chType });
      if (!first) throw new ProtocolError('the radio did not answer the channel query');
      if (first.result === U.SEAL_CH_ERROR || first.result === U.SEAL_CH_FORBIDE) throw new ProtocolError(`channel query failed: ${enumName(U, first.result)}`);
      if (!good(first, 0)) { onProgress?.(0, first); return []; }
      found.set(0, { ...first.ch, chNo: 0 });
      onProgress?.(found.size, first);
      if (first.result === U.SEAL_CH_QUERY_FINISH) return [...found.values()];

      for (let n = 1; n < o.queryMaxChannels; n++) {
        onProgress?.(found.size, null, n);
        let r = await ask({ chType, chNo: n });
        // a late or repeated reply for an earlier channel: wait briefly for the real one
        for (let k = 0; k < 3 && r && r.ch && r.ch.chNo != null && r.ch.chNo < n; k++) r = (await this.waitFor(CMD.CHINFO_RESP, o.timeoutMs, true))?.msg ?? null;
        if (!good(r, n)) break;
        found.set(n, r.ch);
        onProgress?.(found.size, r);
        if (r.result === U.SEAL_CH_QUERY_FINISH) break;
      }
      return [...found.values()].sort((a, b) => a.chNo - b.chNo);
    });
  }

  /** Send one frame and collect every response with respCmd that arrives within windowMs. */
  collect(cmd, msgName, obj, respCmd, windowMs = 1500) {
    return this._exclusive(async () => {
      const got = [];
      const off = this.on('unsolicited', (f) => { if (f.cmd === respCmd) got.push(f.msg); });
      const first = this.waitFor(respCmd, windowMs, true);
      await this.send(cmd, msgName, obj);
      const r = await first; if (r) got.unshift(r.msg);
      await new Promise((res) => setTimeout(res, r ? 400 : 0));
      off();
      return got;
    });
  }

  async editChannel(option, ch) {
    const r = await this.request(CMD.CHINFO_EDIT, 'SEAL_ChannelInfoOperate', { version: 1, option, ch }, CMD.CHINFO_RESP);
    if (r.result !== SEAL_CH_UERR.SEAL_CH_OK) throw new ProtocolError(`channel ${ch.chNo}: ${enumName(SEAL_CH_UERR, r.result)}`);
    return r;
  }
  insertChannel(ch) {
    // The radio holds 60 custom channels and reboots (instead of refusing) when asked to insert a 61st.
    if (ch.chType !== SEAL_CHTYPE.SEAL_PUBLIC && ch.chNo >= MAX_USER_CHANNELS) return Promise.reject(new Error(`slot ${ch.chNo + 1} is past the radio's 60-channel limit`));
    return this.editChannel(SEAL_CHOPTION.SEAL_CH_INSERT, ch);
  }
  modifyChannel(ch) { return this.editChannel(SEAL_CHOPTION.SEAL_CH_MODIFY, ch); }
  deleteChannel(ch) { return this.editChannel(SEAL_CHOPTION.SEAL_CH_DELETE, { chNo: ch.chNo, chType: ch.chType }); }
}
