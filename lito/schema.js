// SEAL protobuf schema for the Beebest LITO, transcribed from protocol/seal.proto
// (BEEBEST Android app v1.1.6). Field numbers, types and enum values are exact.

export const SEAL_SWITCH = { SEAL_OFF: 1, SEAL_ON: 2 };

export const SEAL_CONNCODE = {
  SEAL_DISCONNECT: 0, SEAL_CONNECT: 1, SEAL_ALLOW: 4, SEAL_REFUSE: 5, SEAL_WAIT: 6,
  SEAL_LOWPOWER: 7, SEAL_DIS_ALLOW: 8, SEAL_DIS_REFUSE: 9, SEAL_DIS_WAIT: 10,
  SEAL_DIS_LOWPOWER: 11, SEAL_BUSY: 12,
};

export const SEAL_APPTYPE = { SEAL_OWN_APP: 0, SEAL_MIJIA_APP: 1 };
export const SEAL_LANGUAGETYPE = { SEAL_CHINESE: 0, SEAL_ENGLISH: 1 };

export const SEAL_CHOPTION = { SEAL_CH_INSERT: 0, SEAL_CH_DELETE: 1, SEAL_CH_MODIFY: 2, SEAL_CH_QUERY: 3 };
export const SEAL_CH_UERR = {
  SEAL_CH_OK: 0, SEAL_CH_ERROR: 1, SEAL_CH_EMPTY: 2, SEAL_CH_FORBIDE: 3,
  SEAL_CH_QUERY_CONTINUE: 4, SEAL_CH_QUERY_FINISH: 5,
};
export const SEAL_CHTYPE = { SEAL_PUBLIC: 0, SEAL_REMOTE: 1, SEAL_USERDEF: 2 };

export const SEAL_MODE = {
  SEAL_MODE_NORMAL: 0, SEAL_SOS_T: 1, SEAL_SOS_R: 2, SEAL_SCAN_CH: 3,
  SEAL_SCAN_FREQ: 4, SEAL_TEAM_M: 5, SEAL_TEAM_S: 6,
};
export const SEAL_STOPTION = { SEAL_ST_UPDATE: 0, SEAL_ST_QUERY: 1 };
export const SEAL_ST_UERR = { SEAL_ST_OK: 0, SEAL_ST_ERROR: 1, SEAL_ST_EMPTY: 2, SEAL_ST_FORBIDE: 3 };

export const SEAL_COUNTRY_UERR = {
  SEAL_COUNTRY_QUERY_OK: 1, SEAL_COUNTRY_QUERY_ERROR: 2,
  SEAL_COUNTRY_UPDATE_OK: 3, SEAL_COUNTRY_UPDATE_ERROR: 4,
};
export const SEAL_DEV_UERR = {
  SEAL_PARAM_QUERY_OK: 1, SEAL_PARAM_QUERY_ERROR: 2,
  SEAL_PARAM_UPDATE_OK: 3, SEAL_PARAM_UPDATE_ERROR: 4,
};
export const SEAL_VOICETYPE = { SEAL_VOICETYPE_CLOSE: 1, SEAL_VOICETYPE_CHINESE: 2, SEAL_VOICETYPE_ENGLISH: 3 };

export function enumName(enumObj, value) {
  for (const [k, v] of Object.entries(enumObj)) if (v === value) return k;
  return `#${value}`;
}

const F = (no, name, type, extra = {}) => ({ no, name, type, ...extra });
const E = (no, name, enumObj, extra = {}) => ({ no, name, type: 'enum', enum: enumObj, ...extra });
const M = (no, name, msg, extra = {}) => ({ no, name, type: 'message', msg, ...extra });
const REQ = { required: true };

export const MESSAGES = {
  SEAL_Connect: { fields: [
    F(1, 'version', 'uint32', REQ),
    E(2, 'connCode', SEAL_CONNCODE, REQ),
    F(3, 'deviceId', 'uint32'),
    F(4, 'deviceType', 'uint32'),
    E(5, 'appMode', SEAL_APPTYPE),
    E(6, 'language', SEAL_LANGUAGETYPE),
    F(7, 'color', 'uint32'),
    F(8, 'btmac', 'bytes'),
  ] },
  SEAL_ChannelInfo: { fields: [
    F(1, 'chNo', 'uint32'),
    E(2, 'chType', SEAL_CHTYPE),
    F(3, 'chTxPower', 'uint32'),
    F(4, 'chRxFreq', 'uint32'),
    F(5, 'chTxFreq', 'uint32'),
    F(6, 'chName', 'bytes'),
    F(7, 'chSq', 'uint32'),
    F(8, 'chVox', 'uint32'),
    F(9, 'chRxCss', 'uint32'),
    F(10, 'chTxCss', 'uint32'),
    E(11, 'chElim', SEAL_SWITCH),
    F(12, 'chBand', 'uint32'),
    E(13, 'chPolite', SEAL_SWITCH),
    F(14, 'chPowerLevel', 'uint32'),
  ] },
  SEAL_DeviceParam: { fields: [
    F(1, 'version', 'uint32', REQ),
    E(2, 'result', SEAL_DEV_UERR),
    E(3, 'fullInquiry', SEAL_SWITCH),
    F(4, 'verHw', 'uint32'),
    F(5, 'verSoft', 'uint32'),
    F(6, 'deviceName', 'bytes'),
    F(7, 'bleName', 'bytes'),
    F(8, 'charge', 'uint32'),
    F(9, 'activate', 'uint32'),
    E(10, 'shareLoc', SEAL_SWITCH),
    F(11, 'btAudio', 'uint32'),
    M(12, 'ch', 'SEAL_ChannelInfo'),
    E(13, 'voiceAlert', SEAL_SWITCH),
    E(14, 'isAllPublic', SEAL_SWITCH),
    F(15, 'pwsaveMode', 'uint32'),
    E(16, 'voiceType', SEAL_VOICETYPE),
  ] },
  SEAL_DeviceCountry: { fields: [
    F(1, 'version', 'uint32', REQ),
    F(2, 'country', 'uint32'),
    E(3, 'result', SEAL_COUNTRY_UERR),
  ] },
  SEAL_ChannelStateOperate: { fields: [
    F(1, 'version', 'uint32', REQ),
    E(2, 'result', SEAL_ST_UERR),
    E(3, 'option', SEAL_STOPTION),
    E(4, 'deviceMode', SEAL_MODE),
    F(5, 'stateMode', 'uint32'),
    M(6, 'ch1', 'SEAL_ChannelInfo'),
  ] },
  SEAL_ChannelInfoOperate: { fields: [
    F(1, 'version', 'uint32', REQ),
    E(2, 'result', SEAL_CH_UERR),
    E(3, 'option', SEAL_CHOPTION),
    M(4, 'ch', 'SEAL_ChannelInfo'),
  ] },
  SEAL_LocationInfo: { fields: [
    F(1, 'version', 'uint32', REQ),
    E(2, 'ctlsync', SEAL_SWITCH),
    F(3, 'userId', 'uint32'),
    F(4, 'userName', 'bytes'),
    F(5, 'userFreq', 'uint32'),
    F(6, 'longitude', 'sint32'),
    F(7, 'latitude', 'sint32'),
    F(8, 'altitude', 'sint32'),
    F(9, 'timeSync', 'uint32'),
    F(10, 'rxCss', 'uint32'),
  ] },
};

// Command IDs (big-endian uint16 in the frame header). Request -> response pairs.
export const CMD = {
  CONNECT: 20001, CONNECT_RESP: 20002,
  DEVPARAM_QUERY: 20003, DEVPARAM_MODIFY: 20004, DEVPARAM_RESP: 20005,
  CHSTATE_QUERY: 20006, CHSTATE_MODIFY: 20007, CHSTATE_RESP: 20008,
  CHINFO_QUERY: 20009, CHINFO_EDIT: 20010, CHINFO_RESP: 20011,
  UPGRADE_REQ: 20012, UPGRADE_PACK: 20013, UPGRADE_RESP: 20014,
  LOCATION_DEV: 20015, LOCATION: 20016,
  BTEAR_QUERY: 20017, BTEAR_CONNECT: 20018, BTEAR_RESP: 20019,
  BTEAR_SCAN: 20020, BTEAR_SCAN_RESP: 20021, BTEAR_SCAN_ITEM: 20022,
  COUNTRY_QUERY: 20026, COUNTRY_MODIFY: 20027, COUNTRY_RESP: 20028,
};

// Which message each command ID carries, so the log can decode any frame.
export const CMD_MESSAGE = {
  20001: 'SEAL_Connect', 20002: 'SEAL_Connect',
  20003: 'SEAL_DeviceParam', 20004: 'SEAL_DeviceParam', 20005: 'SEAL_DeviceParam',
  20006: 'SEAL_ChannelStateOperate', 20007: 'SEAL_ChannelStateOperate', 20008: 'SEAL_ChannelStateOperate',
  20009: 'SEAL_ChannelInfoOperate', 20010: 'SEAL_ChannelInfoOperate', 20011: 'SEAL_ChannelInfoOperate',
  20015: 'SEAL_LocationInfo', 20016: 'SEAL_LocationInfo',
  20026: 'SEAL_DeviceCountry', 20027: 'SEAL_DeviceCountry', 20028: 'SEAL_DeviceCountry',
};

export function cmdName(id) {
  for (const [k, v] of Object.entries(CMD)) if (v === id) return k;
  return `CMD_${id}`;
}
