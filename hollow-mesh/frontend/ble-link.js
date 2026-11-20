// ble-link.js — everything the laptop page needs to talk to a Hollow "board".
//
// A board is an ESP32 acting as a Bluetooth (BLE) device. Two kinds exist, with
// the same layout (see BLE-SPEC.md):
//   * Sensor board  — holds its own alert while the sensor is alarming.
//   * Mailbox board — a fixed drop-off point: laptops write alerts into it, and
//                     other laptops read them back out later.
//
// This file has two interchangeable implementations of "a board":
//   * WebBluetoothBoard — the real thing, using Chrome/Edge's Web Bluetooth.
//   * MockBoard         — an in-page pretend board, for practice and testing.
// The page only uses the shared interface:
//     name, id, connect(), readAll(), subscribe(cb), write(bytes), disconnect(),
//     onDisconnect (callback property)
//
// No browser-only code runs at import time, so tests can import this in Node.

export const SERVICE_UUID = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0000';
export const FEED_UUID    = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0001'; // read + notify: alerts the board holds
export const INBOX_UUID   = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0002'; // write: drop an alert into the board
export const NAME_PREFIX  = 'Hollow-';

export const PACKET_LEN = 10;
export const KIND_CODE = {
  POWER: 1,
  AIR: 2,
  WATER: 3,
  FLOOD: 4,
  HEAT: 5,
  EARTHQUAKE: 6,
  VIBRATION: 7
};
export const KIND_NAME = Object.fromEntries(Object.entries(KIND_CODE).map(([k, v]) => [v, k]));

/**
 * 10-byte packet, little-endian:
 *   0-1 magic 'H','M'   2 kind   3 level   4-5 valueX10 (int16)   6 ttl   7 hops   8-9 id (uint16)
 */
export function encodePacket({ kind, level, valueX10, ttl, hops, id }) {
  const b = new Uint8Array(PACKET_LEN);
  const v = new DataView(b.buffer);
  b[0] = 0x48; b[1] = 0x4d;
  b[2] = kind; b[3] = level;
  v.setInt16(4, valueX10, true);
  b[6] = ttl; b[7] = hops;
  v.setUint16(8, id, true);
  return b;
}

export function decodePacket(bytes) {
  if (!bytes || bytes.length !== PACKET_LEN) return null;
  if (bytes[0] !== 0x48 || bytes[1] !== 0x4d) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = { kind: bytes[2], level: bytes[3], valueX10: v.getInt16(4, true), ttl: bytes[6], hops: bytes[7], id: v.getUint16(8, true) };
  return KIND_NAME[p.kind] ? p : null;
}

export const packetKey = (p) => `${p.kind}-${p.id}`;

export function splitPackets(u8) {
  const out = [];
  for (let i = 0; i + PACKET_LEN <= u8.length; i += PACKET_LEN) out.push(u8.slice(i, i + PACKET_LEN));
  return out;
}

// ------------------------------------------------------------ real Bluetooth

export class WebBluetoothBoard {
  constructor(device) {
    this.device = device;
    this.name = device.name || 'Hollow board';
    this.id = device.id;
    this.onDisconnect = null;
    this.feed = null;
    this.inbox = null;
    device.addEventListener('gattserverdisconnected', () => this.onDisconnect?.());
  }

  async connect(timeoutMs = 10000) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { this.disconnect(); reject(new Error('timed out')); }, timeoutMs);
    });
    const attempt = this._connect();
    attempt.catch(() => {});          // the losing side of the race must not become an unhandled rejection
    try { await Promise.race([attempt, timeout]); } finally { clearTimeout(timer); }
  }

  async _connect() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    this.feed = await service.getCharacteristic(FEED_UUID);
    this.inbox = await service.getCharacteristic(INBOX_UUID);
  }

  async readAll() {
    const dv = await this.feed.readValue();
    return splitPackets(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
  }

  async subscribe(cb) {
    await this.feed.startNotifications();
    this.feed.addEventListener('characteristicvaluechanged', (e) => {
      const dv = e.target.value;
      for (const p of splitPackets(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength))) cb(p);
    });
  }

  async write(bytes) {
    const fn = this.inbox.writeValueWithResponse ?? this.inbox.writeValue;
    await fn.call(this.inbox, bytes);
  }

  disconnect() {
    try { this.device.gatt.disconnect(); } catch { /* already disconnected */ }
  }
}

// ----------------------------------------------------------- pretend board

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** A board that lives inside the page. Behaves like the real firmware should:
 *  - holds up to `capacity` alerts (newest replaces oldest), ignores repeats,
 *  - tells subscribers about each new alert,
 *  - only answers while `inRange` is true. */
export class MockBoard {
  constructor(name, role, capacity = 4) {
    this.name = name;
    this.id = `mock-${name}`;
    this.role = role;                // 'sensor' | 'mailbox'
    this.capacity = capacity;
    this.inRange = false;
    this.connected = false;
    this.store = [];                 // Uint8Array packets
    this.cb = null;
    this.onDisconnect = null;
  }

  async connect() {
    await wait(150);
    if (!this.inRange) throw new Error('out of range');
    this.connected = true;
  }

  async readAll() {
    this._need();
    return this.store.map((p) => p.slice());
  }

  async subscribe(cb) { this._need(); this.cb = cb; }

  async write(bytes) {
    this._need();
    if (this.role === 'sensor') return;     // a sensor board ignores drop-offs
    this._add(bytes);
  }

  disconnect() { this.connected = false; this.cb = null; }

  setInRange(v) {
    this.inRange = v;
    if (!v && this.connected) {
      this.connected = false;
      this.cb = null;
      this.onDisconnect?.();
    }
  }

  /** (sensor role) start alarming: the board now holds its own alert. */
  raiseAlert(kindName, level, value) {
    const id = 1 + Math.floor(Math.random() * 65534);
    this._add(encodePacket({ kind: KIND_CODE[kindName], level, valueX10: Math.round(value * 10), ttl: 8, hops: 0, id }));
  }

  clearAlerts() { this.store = []; }

  _need() { if (!this.inRange || !this.connected) throw new Error('not connected'); }

  _add(bytes) {
    const p = decodePacket(bytes);
    if (!p) return;
    if (this.store.some((s) => packetKey(decodePacket(s)) === packetKey(p))) return;
    this.store.push(bytes.slice());
    while (this.store.length > this.capacity) this.store.shift();
    this.cb?.(bytes.slice());
  }
}
