# LITO Config

An unofficial browser app for backing up and programming **Beebest LITO** UHF CB radios over Bluetooth.

**Try it:** https://felixrising.github.io/lito-config/ (Chrome or Edge on Windows, macOS, ChromeOS or Android). Press **Demo radio** to try it without a radio.

> Not affiliated with or endorsed by Beebest. Use at your own risk. Save a backup before writing, and only program channels that are legal where you use them (in Australia: no voice on CH22/23, never transmit on CH61-63).

## What it does

- **Channels:** read, edit, add and delete the radio's custom channels (name, RX/TX frequency, CTCSS/DCS tones), then write only the differences back.
- **Radio settings:** device and Bluetooth name, voice prompts, alerts, location sharing, and current-channel squelch, VOX, bandwidth and busy lockout.
- **Presets:** Australian UHF CB layouts (CH1-40, CH1-60 or CH1-80 with slot = channel, essentials, touring, family), plus New Zealand, US FRS/GMRS and EU/UK PMR446.
- **Files:** save and open full backups (`.lito.json`), and export or import channels as CSV.
- **Bulk Programmer** (About > Advanced): write one setup to several radios at once.
- **Developer tools** (About): a decoded frame log, a custom-frame sender and a channel limit test.

The radio holds 60 custom channels according to the official app. The channel limit test measures what your radio actually accepts.

## Using it

1. Open the link above in Chrome or Edge. Firefox and Safari don't support Web Bluetooth.
2. Close the official app on your phone first: the radio accepts one Bluetooth connection at a time.
3. Press **Connect radio**, pick your LITO, and accept on the radio the first time.
4. Press **Read from radio**, then **Backup…** to save a backup before you change anything.

To run it locally, serve the folder over `http://localhost` (for example `npx serve` or `python -m http.server`). On Windows, `start.cmd` does this with PowerShell only. Opening `index.html` straight from disk won't work, because Web Bluetooth needs https or localhost.

## Help finish the decoding

A few values are still raw numbers: TX power, power level, power save and the "all public" flag. The **Protocol status** tab (developer tools) lists what's confirmed and what isn't. If you work one out, for example by changing it in the official app and reading it back here, open an issue or pull request with what you changed and the downloaded log.

## Code

```
lito/            protocol layer, no dependencies, runs in browsers and Node
  frame.js       framing and CRC-16/MCRF4XX
  protobuf.js    small schema-driven proto2 codec
  schema.js      SEAL_* messages, enums and command IDs
  values.js      frequency and tone encodings
  client.js      LitoClient: handshake, settings, channel read/write (any transport)
  ble.js         Web Bluetooth transport
  simulator.js   simulated radio for the demo and tests
  configfile.js  editor model, diffing, .lito.json and CSV
  sync.js        apply a setup to a radio (used by the Bulk Programmer)
  presets.js     channel presets
app/             the UI (vanilla JS, no build step)
tests/           node --test (npm test, Node 20+)
docs/            protocol notes and the reconstructed seal.proto
```

`docs/LITO-BLE-protocol.md` describes the Bluetooth protocol for interoperability. It was worked out from the official app's behaviour and confirmed on real radios. No code from the official app is included.

## Licence

MIT. See [LICENSE](LICENSE).
