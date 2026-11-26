# Beebest LITO BLE programming protocol (draft v0.1)

Reverse engineered from the **BEEBEST** Android app v1.1.6 (versionCode 29, package `com.ifengyu.overseas`), Flutter/Dart 3.10 AOT, decompiled with blutter. Source copy: APKPure XAPK (unverified mirror). Date: 2026-11-26.

Confidence tags: **[confirmed]** read directly from code. **[likely]** strong inference from code. **[guess]** needs a BLE capture to verify.

---

## 1. Transport

| Item | Value | |
|---|---|---|
| Link | BLE GATT (flutter_reactive_ble). No classic SPP. | [confirmed] |
| Service | `0xFEBE` → `0000febe-0000-1000-8000-00805f9b34fb` | [confirmed] |
| Write characteristic (app → radio) | `0xBEC7`, **write with response** | [confirmed] |
| Notify characteristic (radio → app) | `0xBEC8`, subscribe for notifications | [confirmed] |
| OTA | `0xBECB` and Telink OTA `00010203-0405-0607-0809-0a0b0c0d2b12` (service `…0d1912`), write without response | [confirmed] |
| MTU | App calls `requestMtu(n)`, then uses the **returned MTU** as the chunk size. The default chunk is 186 before MTU negotiation. | [confirmed] |
| Encryption | **None for LITO.** ECDH (secp256r1) + AES-128-CBC exists in the app but is only used by the A108 model (see §7). | [confirmed] |

Chunking: the app splits each frame into `ceil(len/chunk)` slices and writes them sequentially with write-with-response. In Web Bluetooth, use `chunk = mtu - 3` to be safe; the app passing the raw MTU is probably absorbed by Android long writes. [likely]

Receive: notifications are reassembled. A slice starting with `0xFE` begins a new frame ("header mark"). Bytes accumulate until `length` bytes have arrived, then the CRC is checked. [confirmed]

## 2. Frame format (LITO, `DeviceType.lito`)

All multi-byte integers are **big-endian**.

```
offset size field
0      1    magic      = 0xFE                               [confirmed]
1      1    version    = 0x01  (FyBleContainer.bVer)         [confirmed]
2      2    length     = total frame length = 10 + len(payload)  [confirmed]
4      2    commandId  (see §3)                              [confirmed]
6      2    seq        per-connection counter, starts at 0, +1 per sent frame  [confirmed]
8      N    payload    protobuf-encoded SEAL_* message (plaintext)  [confirmed]
8+N    2    crc16      over bytes [0 .. 8+N), big-endian    [confirmed]
```

**CRC:** CRC-16/MCRF4XX: poly 0x1021 reflected (table uses 0x8408), init 0xFFFF, refin/refout true, xorout 0x0000. [confirmed from the 256-entry table and loop]

```js
function crc16(bytes){ let c=0xFFFF; for(const b of bytes){ c^=b; for(let i=0;i<8;i++) c = (c&1) ? (c>>>1)^0x8408 : c>>>1; } return c&0xFFFF; }
```

(The A108 model uses a 10-byte header with a 12-byte overhead. That's not relevant for LITO.)

## 3. Command IDs

The IDs are a contiguous enum, `20000 + n` (0x4E20 + n). The app registers a response observer for the response ID, then sends the request ID. [confirmed]

| Request (app → radio) | ID | Payload | Response ID | Response payload |
|---|---|---|---|---|
| Connect / handshake | 20001 | `SEAL_Connect` | 20002 | `SEAL_Connect` (connCode = ALLOW/REFUSE/WAIT/LOWPOWER/BUSY) |
| Query device params | 20003 | `SEAL_DeviceParam` | 20005 | `SEAL_DeviceParam` |
| Modify device params | 20004 | `SEAL_DeviceParam` | 20005 | `SEAL_DeviceParam` |
| Query current channel state | 20006 | `SEAL_ChannelStateOperate` | 20008 | `SEAL_ChannelStateOperate` |
| Modify current channel state | 20007 | `SEAL_ChannelStateOperate` | 20008 | `SEAL_ChannelStateOperate` |
| Query all channels (paged) | 20009 | `SEAL_ChannelInfoOperate` (option=QUERY) | 20011 | `SEAL_ChannelInfoOperate` (result=QUERY_CONTINUE … QUERY_FINISH) |
| Insert / modify / delete channel | 20010 | `SEAL_ChannelInfoOperate` | 20011 | `SEAL_ChannelInfoOperate` |
| Firmware upgrade start/complete/reboot | 20012 | `SEAL_UpGradeFileRequest` | 20014 | `SEAL_UpGradeFileResponse` |
| Firmware upgrade data packet | 20013 | `SEAL_UpGradeFilePack` | 20014 | `SEAL_UpGradeFileResponse` |
| Location share update | 20016 | `SEAL_LocationInfo` | 20016 | `SEAL_LocationInfo` (20015 is probably device → app) [guess] |
| BT headset query | 20017 | `SEAL_BtEarConnectState` | 20019 | `SEAL_BtEarConnectState` |
| BT headset connect/disconnect | 20018 | `SEAL_BtEarConnectState` | 20019 | `SEAL_BtEarConnectState` |
| BT headset scan start/pause/stop | 20020 | `SEAL_BtEarScanControl` | 20021 | `SEAL_BtEarScanControl` |
| (unsolicited) headset scan result | 20022 | `SEAL_BtEarScanItem` | | |
| Query region/country | 20026 | `SEAL_DeviceCountry` | 20028 | `SEAL_DeviceCountry` |
| Modify region/country | 20027 | `SEAL_DeviceCountry` | 20028 | `SEAL_DeviceCountry` |

IDs 20000, 20023–20025 are unused by the LITO service. [confirmed absent]

## 4. Protobuf schema

The full schema is in [`seal.proto`](seal.proto). It's proto2 with required fields, and every message starts with `required uint32 version = 1` (the app always sends 1). Field numbers, types, labels, defaults and enum values are exact. [confirmed]

Key messages for programming:

- **`SEAL_ChannelInfo`**
  - `chNo` (1), `chType` (2: PUBLIC=0 / REMOTE=1 / USERDEF=2), `chTxPower` (3)
  - `chRxFreq` (4), `chTxFreq` (5), `chName` (6, bytes)
  - `chSq` (7), `chVox` (8), `chRxCss` (9), `chTxCss` (10)
  - `chElim` (11, SWITCH), `chBand` (12), `chPolite` (13, SWITCH), `chPowerLevel` (14)
- **`SEAL_DeviceParam`**
  - `fullInquiry` (3), `verHw` (4), `verSoft` (5), `deviceName` (6), `bleName` (7)
  - `charge` (8), `activate` (9), `shareLoc` (10), `btAudio` (11), `ch` (12, current channel)
  - `voiceAlert` (13), `isAllPublic` (14), `pwsaveMode` (15)
  - `voiceType` (16: CLOSE=1 / CHINESE=2 / ENGLISH=3)
- **`SEAL_SWITCH`**: OFF = **1**, ON = **2** (not 0/1).

### Value encodings
- **Frequencies** are integers in **Hz**. The UI divides by 1,000,000 and shows 5 decimals, for example 476425000 = 476.42500 MHz. [likely]
- **CSS (CTCSS/DCS)**: `value = type*256 + n`. **type 0** = off. **type 1** = CTCSS, n=1..38 into [67.0, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9, 114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 162.2, 167.9, 173.8, 179.9, 186.2, 192.8, 203.5, 210.7, 218.1, 225.7, 233.6, 241.8, 250.3] Hz. **type 2** = DCS normal (`DxxxN`), n=1..83. **type 3** = DCS inverted (`DxxxI`), n=1..83. The DCS order is the standard 83-code list 023 025 026 031 032 043 047 051 054 065 071 072 073 074 114 115 116 125 131 132 134 143 152 155 156 162 165 172 174 205 223 226 243 244 245 251 261 263 265 271 306 311 315 331 343 346 351 364 365 371 411 412 413 423 431 432 445 464 465 466 503 506 516 532 546 565 606 612 624 627 631 632 654 662 664 703 712 723 731 732 734 743 754. n=0 within any type also means off. [confirmed from ChannelHelper.getCssList/getChannelCss, both 1.1.5 and 1.1.6]
- **Region**: `SEAL_DeviceCountry.country` is a numeric code. The app limits channel and frequency lists per country (`getFreqLinitListByCountry`). [likely]
- **Squelch / VOX / band are per current channel, written through DeviceParam:** cmd 20004 `SEAL_DeviceParam{ ch(12)={ chSq, chVox, chBand } , ... }`. [confirmed, modifyDeviceInfo]
- **chSq**: the UI offers a map {1: Normal, 2: Sensitive}. [likely]
- **chBand**: the UI offers 2 options (wideband / narrowband). The exact numeric codes aren't recovered yet; read the current value back first. [guess]
- **chPolite** = busy-channel lockout (UI 'polite' plus hint). **chElim** is not exposed in the LITO UI. [likely]
- **Names:** channel `chName` and `deviceName` are GBK. `bleName` is **UTF-8**. [confirmed]
- chTxPower / chPowerLevel / chVox / pwsaveMode ranges: not recovered (no UI constants found). [guess]


## 4a. Setting value maps (app UI, confirmed in 1.1.5 and 1.1.6)

| Field | Where it's written | Values |
|---|---|---|
| `chSq` (ChannelInfo 7) | DeviceParam.ch via cmd 20004 | 1 = Normal, 2 = Sensitive [confirmed UI map] |
| `chVox` (ChannelInfo 8) | DeviceParam.ch via cmd 20004 | 1 = Low, 2 = Middle, 3 = High ("Trigger volume"). 0 = off [likely] |
| `chBand` (ChannelInfo 12) | DeviceParam.ch via cmd 20004 | 0 = Wideband, 1 = Narrowband. The UI defaults to 1 if missing [confirmed UI list index] |
| `chPolite` (ChannelInfo 13) | DeviceParam.ch via cmd 20004 | SWITCH, busy-channel lockout ("polite") [confirmed] |
| `voiceAlert` (DeviceParam 13) | cmd 20004 | SWITCH (OFF=1, ON=2) |
| `voiceType` (DeviceParam 16) | cmd 20004 | CLOSE=1, CHINESE=2, ENGLISH=3 |
| `shareLoc` (DeviceParam 10) | cmd 20004 | SWITCH |
| `pwsaveMode` (DeviceParam 15) | cmd 20004 (passed through from the model, no LITO UI) | unknown, test needed |
| `chTxPower` / `chPowerLevel` | never set by LITO UI code | unknown, read back and test |
| `isAllPublic` (DeviceParam 14) | read-only in app (never written) | unknown, probably "only public channels" |
| `chElim` (ChannelInfo 11) | never used by LITO UI | unknown |
| Name length | channel name and device name | max **18 units**: ASCII letters/digits = 1, any other char (e.g. CJK) = 3. Allowed chars `[a-zA-Z0-9一-龥]` only (no spaces/punctuation). Device type A108 = 15 [confirmed FyFilteringTextInputFormatter] |
| Location interval | UI map | {1, 3, 5, 10, 15} minutes [confirmed UI map; field mapping not traced] |

## 5. Session flow

1. Scan for the radio and connect GATT. Subscribe to `0xBEC8`, request a larger MTU, and reset seq to 0. [confirmed]
2. **Connect:** send cmd 20001 with `SEAL_Connect{ version=1, connCode=SEAL_CONNECT(1), appMode=SEAL_OWN_APP(0), deviceType=26, deviceId=<from app's device record, optional> }`. Wait for 20002, where connCode SEAL_ALLOW(4) means accepted. The radio may need user confirmation (WAIT=6) or refuse (5). [confirmed fields; "26" is a constant the app sends]
3. **Read device:** send cmd 20003 with `SEAL_DeviceParam{ version=1, fullInquiry=SEAL_ON }` and get the full param set (20005). [confirmed]
4. **Read channels (radio-driven iteration):** first send cmd 20009 with `SEAL_ChannelInfoOperate{ version=1, option=SEAL_CH_QUERY(3), ch={ chType=SEAL_USERDEF(2) } }`. Set **no chNo** and no result. Each reply is 20011 with `result`. While `result == SEAL_CH_QUERY_CONTINUE(4)`, the app decodes `ch` and sends cmd 20009 again with `{version=1, option=QUERY, ch={} (empty sub-message, encodes as `22 00`), result=SEAL_CH_OK(0)}`, i.e. **chType is not repeated**. That OK is the ack that makes the radio advance. The loop ends on any other result (QUERY_FINISH=5). The app reads `chNo` (1), `chName` (6, **GBK** via fast_gbk), `chRxFreq` (4), `chTxFreq` (5), `chRxCss` (9) and `chTxCss` (10) straight from the reply. There's no per-type remapping of frequencies. [confirmed from queryAllDevSTChannelInfo / continueQueryAllDevSTChannelInfo / transformFyChannelMessage]
5. **Write a channel:** send cmd 20010 with `option = INSERT(0) / DELETE(1) / MODIFY(2)` and the full `SEAL_ChannelInfo`. 20011 returns `result` (OK=0, ERROR, EMPTY, FORBIDE=3 for locked/public channels). [confirmed]
6. **Change settings:** send cmd 20004 with a `SEAL_DeviceParam` holding only the changed fields (name, bleName, voiceAlert, voiceType, pwsaveMode, shareLoc, current-channel squelch/VOX/band…). The response is 20005 with result PARAM_UPDATE_OK(3) or ERROR(4). [confirmed fields]
7. **Disconnect:** the app sends `SEAL_Connect` with connCode = SEAL_DISCONNECT(0) or drops GATT. [guess]

## 6. Worked example (computed, not captured)

Query device params, seq 0:
payload `SEAL_DeviceParam{version:1, fullInquiry:SEAL_ON}` = `08 01 18 02` (4 bytes)

```
FE 01 00 0E 4E 23 00 00  08 01 18 02  82 DA
```

## 7. Crypto (A108 only, kept for reference)

ECDH over secp256r1 (micro_ecc, raw 64-byte public keys). From the 32-byte shared secret, AES key = bytes 0–15 and IV = bytes 16–31. AES-128-CBC with zero padding to 16 bytes and a fixed IV per session. Only used when `FyBleContainer.entry == 1`, which the LITO service never sets. [confirmed]

## 8. Open items (need an HCI snoop log)

- ~~CSS type codes~~ resolved (§4).
- Ranges and units for `chTxPower`, `chPowerLevel`, `chSq`, `chVox`, `chBand`, `pwsaveMode`.
- ~~Channel query paging~~ resolved (see §5 step 4).
- Whether the radio needs a button press to accept the first connection.
- Behaviour of ID 20015 and unsolicited frames.
