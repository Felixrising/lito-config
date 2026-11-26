// A simulated LITO that speaks the real frame + protobuf protocol over an in-memory transport.
// It exists for demo mode and tests. Its behaviour follows the spec's best guesses, NOT a capture.

import { codec } from './client.js';
import { encodeFrame, FrameAssembler } from './frame.js';
import { CMD, CMD_MESSAGE, SEAL_SWITCH, SEAL_CONNCODE, SEAL_CHOPTION, SEAL_CH_UERR, SEAL_CHTYPE, SEAL_DEV_UERR, SEAL_VOICETYPE } from './schema.js';
import { nameToBytes } from './values.js';

const key = (type, no) => `${type}:${no}`;

function auCbChannels() {
  const chans = [];
  for (let n = 1; n <= 80; n++) {
    const rx = n <= 40 ? 476425000 + (n - 1) * 25000 : 476437500 + (n - 41) * 25000;
    const repeater = (n >= 1 && n <= 8) || (n >= 41 && n <= 48);
    chans.push({
      chNo: n, chType: SEAL_CHTYPE.SEAL_PUBLIC, chTxPower: 1, chRxFreq: rx, chTxFreq: repeater ? rx + 750000 : rx,
      chName: nameToBytes(`CB${n}`), chSq: 3, chVox: 0, chRxCss: 0, chTxCss: 0,
      chElim: SEAL_SWITCH.SEAL_OFF, chBand: 0, chPolite: SEAL_SWITCH.SEAL_OFF, chPowerLevel: 2,
    });
  }
  return chans;
}

export class SimulatedRadio {
  constructor({ requireConfirm = false, latencyMs = 15, sliceSize = 20, maxUser = 60 } = {}) {
    this.maxUser = maxUser;
    this.latencyMs = latencyMs;
    this.sliceSize = sliceSize;
    this.requireConfirm = requireConfirm;
    // Channel numbers are per type on the real radio (user channels start at 0), so key by type + number.
    this.channels = new Map(auCbChannels().map((c) => [key(c.chType, c.chNo), c]));
    this.channels.set(key(SEAL_CHTYPE.SEAL_USERDEF, 0), { chNo: 0, chType: SEAL_CHTYPE.SEAL_USERDEF, chTxPower: 1, chRxFreq: 476925000, chTxFreq: 476925000,
      chName: nameToBytes('CAMP'), chSq: 3, chVox: 0, chRxCss: 256 + 12, chTxCss: 256 + 12, chElim: SEAL_SWITCH.SEAL_OFF, chBand: 0, chPolite: SEAL_SWITCH.SEAL_OFF, chPowerLevel: 2 });
    this.params = {
      verHw: 0x0100, verSoft: 0x010203, deviceName: nameToBytes('LITO Sim'), bleName: nameToBytes('LITO-SIM'),
      charge: 78, activate: 1, shareLoc: SEAL_SWITCH.SEAL_OFF, btAudio: 0, voiceAlert: SEAL_SWITCH.SEAL_ON,
      isAllPublic: SEAL_SWITCH.SEAL_OFF, pwsaveMode: 1, voiceType: SEAL_VOICETYPE.SEAL_VOICETYPE_ENGLISH, ch: 1,
    };
    this.country = 61;
    this.seq = 0;
    this.toApp = () => {};
    this.asm = new FrameAssembler((fr) => this._handle(fr));
  }

  /** Returns a transport the LitoClient can use. */
  transport() {
    const radio = this;
    const t = {
      name: 'Simulator',
      onData: () => {}, onDisconnect: () => {},
      async open() { radio.toApp = (b) => setTimeout(() => t.onData(b), radio.latencyMs); },
      async write(bytes) { radio.asm.push(Uint8Array.from(bytes)); },
      async close() { setTimeout(() => t.onDisconnect(), 0); },
    };
    return t;
  }

  _reply(cmd, obj) {
    const f = encodeFrame(cmd, this.seq++ & 0xFFFF, codec.encode(CMD_MESSAGE[cmd], obj));
    // deliver in 20-byte notification slices like a small-MTU radio would
    for (let i = 0; i < f.length; i += this.sliceSize) this.toApp(f.slice(i, i + this.sliceSize));
  }

  _handle(fr) {
    const m = CMD_MESSAGE[fr.cmd] ? codec.decode(CMD_MESSAGE[fr.cmd], fr.payload) : {};
    switch (fr.cmd) {
      case CMD.CONNECT:
        if (m.connCode === SEAL_CONNCODE.SEAL_DISCONNECT) return;
        if (this.requireConfirm) {
          this._reply(CMD.CONNECT_RESP, { version: 1, connCode: SEAL_CONNCODE.SEAL_WAIT });
          setTimeout(() => this._reply(CMD.CONNECT_RESP, { version: 1, connCode: SEAL_CONNCODE.SEAL_ALLOW }), 800);
        } else this._reply(CMD.CONNECT_RESP, { version: 1, connCode: SEAL_CONNCODE.SEAL_ALLOW });
        return;
      case CMD.DEVPARAM_QUERY: {
        const cur = this.channels.get(key(SEAL_CHTYPE.SEAL_PUBLIC, this.params.ch));
        this._reply(CMD.DEVPARAM_RESP, { version: 1, result: SEAL_DEV_UERR.SEAL_PARAM_QUERY_OK, ...this.params, ch: cur });
        return;
      }
      case CMD.DEVPARAM_MODIFY: {
        const { version, result, fullInquiry, ch, _unknown, ...rest } = m;
        Object.assign(this.params, rest);
        this._reply(CMD.DEVPARAM_RESP, { version: 1, result: SEAL_DEV_UERR.SEAL_PARAM_UPDATE_OK });
        return;
      }
      case CMD.COUNTRY_QUERY:
        this._reply(CMD.COUNTRY_RESP, { version: 1, country: this.country, result: 1 });
        return;
      case CMD.CHINFO_QUERY: {
        // Mimics a real radio: no chNo -> channel 0 with CONTINUE; with chNo -> that channel with OK,
        // or EMPTY past the end. (Acking with result=OK replays channel 0, like the real one.)
        const type = m.ch?.chType ?? SEAL_CHTYPE.SEAL_PUBLIC;
        const list = [...this.channels.values()].filter((c) => c.chType === type).sort((a, b) => a.chNo - b.chNo);
        if (m.ch?.chNo === undefined) {
          if (!list.length) { this._reply(CMD.CHINFO_RESP, { version: 1, result: SEAL_CH_UERR.SEAL_CH_QUERY_FINISH, option: 3 }); return; }
          this._reply(CMD.CHINFO_RESP, { version: 1, result: SEAL_CH_UERR.SEAL_CH_QUERY_CONTINUE, option: 3, ch: list[0] });
          return;
        }
        const c = this.channels.get(key(type, m.ch.chNo));
        this._reply(CMD.CHINFO_RESP, c ? { version: 1, result: SEAL_CH_UERR.SEAL_CH_OK, option: 3, ch: c }
          : { version: 1, result: SEAL_CH_UERR.SEAL_CH_EMPTY, option: 3, ch: { chNo: m.ch.chNo } });
        return;
      }
      case CMD.CHINFO_EDIT: {
        const ch = m.ch || {};
        const type = ch.chType ?? SEAL_CHTYPE.SEAL_USERDEF, k = key(type, ch.chNo);
        const existing = this.channels.get(k);
        let result = SEAL_CH_UERR.SEAL_CH_OK;
        if (type === SEAL_CHTYPE.SEAL_PUBLIC) result = SEAL_CH_UERR.SEAL_CH_FORBIDE;
        else if (m.option === SEAL_CHOPTION.SEAL_CH_INSERT) { if (existing || (type === SEAL_CHTYPE.SEAL_USERDEF && [...this.channels.values()].filter((c) => c.chType === type).length >= this.maxUser)) result = SEAL_CH_UERR.SEAL_CH_ERROR; else this.channels.set(k, { ...ch, chType: type }); }
        else if (m.option === SEAL_CHOPTION.SEAL_CH_MODIFY) { if (!existing) result = SEAL_CH_UERR.SEAL_CH_EMPTY; else this.channels.set(k, { ...ch, chType: type }); }
        else if (m.option === SEAL_CHOPTION.SEAL_CH_DELETE) {
          // Like the real radio: an out-of-range delete is ERROR, and later slots shift down one.
          if (!existing) result = SEAL_CH_UERR.SEAL_CH_ERROR;
          else {
            this.channels.delete(k);
            const later = [...this.channels.values()].filter((c) => c.chType === type && c.chNo > ch.chNo).sort((a, b) => a.chNo - b.chNo);
            for (const c of later) { this.channels.delete(key(type, c.chNo)); this.channels.set(key(type, c.chNo - 1), { ...c, chNo: c.chNo - 1 }); }
          }
        }
        this._reply(CMD.CHINFO_RESP, { version: 1, result, option: m.option, ch: this.channels.get(k) ?? { chNo: ch.chNo } });
        return;
      }
      case CMD.CHSTATE_QUERY:
        this._reply(CMD.CHSTATE_RESP, { version: 1, result: 0, deviceMode: 0, ch1: this.channels.get(key(SEAL_CHTYPE.SEAL_PUBLIC, this.params.ch)) });
        return;
      default:
        // unknown command: say nothing, like a real device probably would
    }
  }
}
