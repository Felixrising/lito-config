// Web Bluetooth transport for the LITO (Chrome / Edge on Windows, macOS, Android, ChromeOS).

export const SERVICE = 0xFEBE;
export const CHAR_WRITE = 0xBEC7;
export const CHAR_NOTIFY = 0xBEC8;

export class WebBluetoothTransport {
  /** @param {{acceptAll?: boolean, device?: BluetoothDevice}} o  pass `device` to reconnect without the chooser */
  constructor({ acceptAll = false, device = null } = {}) {
    this.acceptAll = acceptAll;
    this.preset = device;
    this.onData = () => {};
    this.onDisconnect = () => {};
    this.device = null;
    this.name = 'Bluetooth';
  }

  static available() { return typeof navigator !== 'undefined' && !!navigator.bluetooth; }

  async open() {
    if (!WebBluetoothTransport.available()) throw new Error('Web Bluetooth is not available. Use Chrome or Edge, served from https or localhost.');
    const req = this.acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE] }
      : { filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] };
    this.device = this.preset || await navigator.bluetooth.requestDevice(req);
    this.name = this.device.name || this.device.id;
    this._onGone = () => {
      this.nt?.removeEventListener('characteristicvaluechanged', this._onValue);
      this.device.removeEventListener('gattserverdisconnected', this._onGone);
      this.onDisconnect();
    };
    this.device.addEventListener('gattserverdisconnected', this._onGone);
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    this.wr = await svc.getCharacteristic(CHAR_WRITE);
    this.nt = await svc.getCharacteristic(CHAR_NOTIFY);
    this._onValue = (ev) => {
      const dv = ev.target.value;
      this.onData(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice());
    };
    this.nt.addEventListener('characteristicvaluechanged', this._onValue);
    await this.nt.startNotifications();
  }

  /** Show the browser's Bluetooth picker and return the chosen device (throws if cancelled). */
  static async pick({ acceptAll = false } = {}) {
    if (!WebBluetoothTransport.available()) throw new Error('Web Bluetooth is not available. Use Chrome or Edge, served from https or localhost.');
    return navigator.bluetooth.requestDevice(acceptAll
      ? { acceptAllDevices: true, optionalServices: [SERVICE] }
      : { filters: [{ services: [SERVICE] }], optionalServices: [SERVICE] });
  }

  /** Radios this browser already has permission for (needs Chrome's getDevices support). */
  static async remembered() {
    if (!navigator.bluetooth?.getDevices) return null;
    try { return await navigator.bluetooth.getDevices(); } catch { return null; }
  }

  async write(bytes) {
    if (this.wr.writeValueWithResponse) await this.wr.writeValueWithResponse(bytes);
    else await this.wr.writeValue(bytes);
  }

  async close() {
    try { this.nt?.removeEventListener('characteristicvaluechanged', this._onValue); await this.nt?.stopNotifications(); } catch { /* ignore */ }
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
  }
}
