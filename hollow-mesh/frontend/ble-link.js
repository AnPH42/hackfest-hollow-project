
export const SERVICE_UUID = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0000';
export const FEED_UUID = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0001';
export const INBOX_UUID = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0002';

export const COMMUNITY_FEED_UUID = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0003';
export const COMMUNITY_INBOX_UUID = '7e3b0001-6a21-4d5b-9c47-5b1d1a4e0004';

export const NAME_PREFIX = 'Hollow-';
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

export const KIND_NAME = Object.fromEntries(
  Object.entries(KIND_CODE).map(([k, v]) => [v, k])
);

export const MESSAGE_TYPE = {
  CHECKIN: 8,
  REPORT: 9,
  BULLETIN: 10
};

export const MESSAGE_TYPE_NAME = Object.fromEntries(
  Object.entries(MESSAGE_TYPE).map(([name, code]) => [code, name])
);

// ------------------------------------------------------------
// Emergency alert packet encoding (10 bytes)
// ------------------------------------------------------------

export function encodePacket({ kind, level, valueX10, ttl, hops, id }) {
  const b = new Uint8Array(PACKET_LEN);
  const v = new DataView(b.buffer);

  b[0] = 0x48;
  b[1] = 0x4d;
  b[2] = kind;
  b[3] = level;

  v.setInt16(4, valueX10, true);

  b[6] = ttl;
  b[7] = hops;

  v.setUint16(8, id, true);

  return b;
}

export function decodePacket(bytes) {
  if (!bytes || bytes.length !== PACKET_LEN) return null;
  if (bytes[0] !== 0x48 || bytes[1] !== 0x4d) return null;

  const v = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength
  );

  const p = {
    kind: bytes[2],
    level: bytes[3],
    valueX10: v.getInt16(4, true),
    ttl: bytes[6],
    hops: bytes[7],
    id: v.getUint16(8, true)
  };

  return KIND_NAME[p.kind] ? p : null;
}

// ------------------------------------------------------------
// Community message encoding
// ------------------------------------------------------------

export function encodeMessage(message) {
  const json = JSON.stringify(message);
  const body = new TextEncoder().encode(json);

  const bytes = new Uint8Array(body.length + 2);

  bytes[0] = 0x48;
  bytes[1] = 0x4a;
  bytes.set(body, 2);

  return bytes;
}

export function decodeMessage(bytes) {
  if (!bytes || bytes.length < 3) return null;
  if (bytes[0] !== 0x48 || bytes[1] !== 0x4a) return null;

  try {
    const json = new TextDecoder().decode(bytes.slice(2));
    const message = JSON.parse(json);

    if (!['CHECKIN', 'REPORT', 'BULLETIN'].includes(message.type)) {
      return null;
    }

    return message;
  } catch {
    return null;
  }
}

export const packetKey = (p) => `${p.kind}-${p.id}`;

export function splitPackets(u8) {
  const out = [];

  if (
    u8.length >= 3 &&
    u8[0] === 0x48 &&
    u8[1] === 0x4a
  ) {
    if (decodeMessage(u8)) {
      out.push(u8.slice());
    }

    return out;
  }

  for (let i = 0; i + PACKET_LEN <= u8.length; i += PACKET_LEN) {
    const packet = u8.slice(i, i + PACKET_LEN);

    if (decodePacket(packet)) {
      out.push(packet);
    }
  }

  return out;
}

// ------------------------------------------------------------
// Real Bluetooth board
// ------------------------------------------------------------

export class WebBluetoothBoard {
  constructor(device) {
    this.device = device;
    this.name = device.name || 'Hollow board';
    this.id = device.id;

    this.onDisconnect = null;

    this.feed = null;
    this.inbox = null;

    this.communityFeed = null;
    this.communityInbox = null;
    this._gattTail = Promise.resolve();
    this._communityPending = null;
    this._communityReady = false;
    this._communityListenerAttached = false;
    this._communityToken = 1 + Math.floor(Math.random() * 65535);

    device.addEventListener(
      'gattserverdisconnected',
      () => {
        this._communityReady = false;
        if (this._communityPending) {
          const pending = this._communityPending;
          this._communityPending = null;
          clearTimeout(pending.timer);
          pending.reject(new Error('Bluetooth disconnected'));
        }
        this.onDisconnect?.();
      }
    );
  }

  // One queue for every GATT operation on this browser connection.
  _queued(fn) {
    const next = this._gattTail.catch(() => {}).then(fn);
    this._gattTail = next.catch(() => {});
    return next;
  }

  async _enableCommunityNotifications() {
    if (!this.communityFeed || this._communityReady) return;
    if (!this._communityListenerAttached) this.communityFeed.addEventListener('characteristicvaluechanged', (event) => {
      const dv = event.target.value;
      const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength).slice();
      const pending = this._communityPending;
      if (!pending || bytes.length < 3) return;
      if (bytes[1] !== (this._communityToken & 255) ||
          bytes[2] !== (this._communityToken >> 8)) return;
      if (!pending.matches(bytes)) return;
      this._communityPending = null;
      clearTimeout(pending.timer);
      pending.resolve(bytes);
    });
    this._communityListenerAttached = true;
    await this.communityFeed.startNotifications();
    this._communityReady = true;
  }

  async _requestCommunity(command, matches, timeoutMs = 5000) {
    if (!this._communityReady) throw new Error('Community notifications unavailable');
    if (this._communityPending) throw new Error('Community request already pending');
    let pending;
    const response = new Promise((resolve, reject) => {
      pending = { resolve, reject, matches, timer: null };
      pending.timer = setTimeout(() => {
        if (this._communityPending === pending) this._communityPending = null;
        reject(new Error('Community response timeout'));
      }, timeoutMs);
    });
    this._communityPending = pending;
    try {
      const fn = this.communityInbox.writeValueWithResponse ?? this.communityInbox.writeValue;
      await fn.call(this.communityInbox, command);
      return await response;
    } catch (error) {
      if (this._communityPending === pending) this._communityPending = null;
      clearTimeout(pending.timer);
      // Avoid unhandled rejection if the write failed before awaiting response.
      response.catch(() => {});
      throw error;
    }
  }

  _tokenCommand(command, ...fields) {
    return new Uint8Array([command, this._communityToken & 255,
      this._communityToken >> 8, ...fields]);
  }

  async connect(timeoutMs = 10000) {
    let timer;

    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this.disconnect();
        reject(new Error('timed out'));
      }, timeoutMs);
    });

    const attempt = this._connect();
    attempt.catch(() => {});

    try {
      await Promise.race([attempt, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async _connect() {
    const server = await this.device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);

    this.feed = await service.getCharacteristic(FEED_UUID);
    this.inbox = await service.getCharacteristic(INBOX_UUID);

    // Community characteristics exist on mailbox boards,
    // but may not exist on sensor boards.
    try {
      this.communityFeed =
        await service.getCharacteristic(COMMUNITY_FEED_UUID);

      this.communityInbox =
        await service.getCharacteristic(COMMUNITY_INBOX_UUID);
    } catch {
      this.communityFeed = null;
      this.communityInbox = null;
    }
    if (this.communityFeed) await this._enableCommunityNotifications();
  }

  // Read emergency alerts
  async readAll() {
    const dv = await this._queued(() => this.feed.readValue());

    return splitPackets(
      new Uint8Array(
        dv.buffer,
        dv.byteOffset,
        dv.byteLength
      )
    );
  }

  // Subscribe to emergency alerts
  async subscribe(cb) {
    await this._queued(() => this.feed.startNotifications());

    this.feed.addEventListener(
      'characteristicvaluechanged',
      (e) => {
        const dv = e.target.value;

        const packets = splitPackets(
          new Uint8Array(
            dv.buffer,
            dv.byteOffset,
            dv.byteLength
          )
        );

        for (const p of packets) {
          cb(p);
        }
      }
    );
  }

  // Write emergency alert
  async write(bytes) {
    const fn =
      this.inbox.writeValueWithResponse ??
      this.inbox.writeValue;

    await this._queued(() => fn.call(this.inbox, bytes));
  }

  // ----------------------------------------------------------
  // Upload community message in BLE chunks
  // ----------------------------------------------------------

  async writeCommunity(message) {
    return this._queued(async () => {
      if (!this.communityInbox || !this._communityReady) throw new Error('Community Inbox unavailable');
      const bytes = new TextEncoder().encode(JSON.stringify(message));
      if (!bytes.length || bytes.length > 512) throw new Error('Community message exceeds 512 bytes');
      const ack = (b) => b[0] === 0x41 && b.length === 4;
      let accepted = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await this._requestCommunity(
          this._tokenCommand(0x53, bytes.length & 255, bytes.length >> 8), ack);
        if (result[3] === 1) { accepted = true; break; }
        if (result[3] !== 2) throw new Error('Mailbox rejected upload start');
        await new Promise((resolve) => setTimeout(resolve, 350 + Math.random() * 250));
      }
      if (!accepted) throw new Error('Mailbox busy: upload timed out');
      const fn = this.communityInbox.writeValueWithResponse ?? this.communityInbox.writeValue;
      let seq = 0;
      for (let i = 0; i < bytes.length; i += 16) {
        const chunk = bytes.slice(i, i + 16);
        await fn.call(this.communityInbox, this._tokenCommand(0x44, seq++, ...chunk));
      }
      const result = await this._requestCommunity(this._tokenCommand(0x45), ack);
      if (result[3] !== 1 && result[3] !== 4) throw new Error('Mailbox did not store community message');
    });
  }

  async readCommunity() {
    return this._queued(async () => {
      if (!this.communityInbox || !this._communityReady) return [];
      this.communityReading = true;
      try {
        const countReply = await this._requestCommunity(
          this._tokenCommand(0x4e), b => b[0] === 0x4e && b.length === 5);
        const count = Math.min(countReply[3], 4);
        const version = countReply[4];
        const messages = [];
        for (let index = 0; index < count; index++) {
          const chunks = [];
          let total = null;
          for (let chunk = 0; chunk < 40; chunk++) {
            const reply = await this._requestCommunity(
              this._tokenCommand(0x52, index, chunk),
              b => b[0] === 0x46 && b.length >= 7 && b[3] === index && b[5] === chunk);
            if (reply[6] !== version) throw new Error('Mailbox changed during download; retrying next poll');
            if (total === null) {
              total = reply[4];
              if (!total || total > 40) throw new Error('Invalid community chunk count');
            }
            if (reply[4] !== total) throw new Error('Community chunk count changed');
            chunks.push(reply.slice(7));
            if (chunk + 1 >= total) break;
          }
          const length = chunks.reduce((n, part) => n + part.length, 0);
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const part of chunks) { bytes.set(part, offset); offset += part.length; }
          try {
            const message = JSON.parse(new TextDecoder().decode(bytes));
            if (['CHECKIN', 'REPORT', 'BULLETIN'].includes(message.type)) messages.push(message);
          } catch { /* malformed message */ }
        }
        return messages;
      } finally {
        this.communityReading = false;
      }
    });
  }

  disconnect() {
    if (this._communityPending) {
      const pending = this._communityPending;
      this._communityPending = null;
      clearTimeout(pending.timer);
      pending.reject(new Error('Bluetooth disconnected'));
    }
    this._communityReady = false;
    try {
      this.device.gatt.disconnect();
    } catch {
      // Already disconnected.
    }
  }
}

// ------------------------------------------------------------
// Mock board
// ------------------------------------------------------------

const wait = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

export class MockBoard {
  constructor(name, role, capacity = 4) {
    this.name = name;
    this.id = `mock-${name}`;
    this.role = role;
    this.capacity = capacity;

    this.inRange = false;
    this.connected = false;

    this.store = [];
    this.communityStore = [];

    this.cb = null;
    this.onDisconnect = null;
  }

  async connect() {
    await wait(150);

    if (!this.inRange) {
      throw new Error('out of range');
    }

    this.connected = true;
  }

  async readAll() {
    this._need();
    return this.store.map((p) => p.slice());
  }

  async subscribe(cb) {
    this._need();
    this.cb = cb;
  }

  async write(bytes) {
    this._need();

    if (this.role === 'sensor') return;

    this._add(bytes);
  }

  async writeCommunity(message) {
    this._need();

    if (this.role === 'sensor') return;

    const json = JSON.stringify(message);

    if (new TextEncoder().encode(json).length > 512) {
      throw new Error('Community message exceeds 512 bytes');
    }

    if (
      this.communityStore.some(
        (m) => m.id === message.id
      )
    ) {
      return;
    }

    this.communityStore.push(
      JSON.parse(json)
    );

    while (this.communityStore.length > 4) {
      this.communityStore.shift();
    }
  }

  async readCommunity() {
    this._need();

    return this.communityStore.map(
      (message) => JSON.parse(JSON.stringify(message))
    );
  }

  disconnect() {
    this.connected = false;
    this.cb = null;
  }

  setInRange(value) {
    this.inRange = value;

    if (!value && this.connected) {
      this.connected = false;
      this.cb = null;
      this.onDisconnect?.();
    }
  }

  raiseAlert(kindName, level, value) {
    const id = 1 + Math.floor(Math.random() * 65534);

    this._add(
      encodePacket({
        kind: KIND_CODE[kindName],
        level,
        valueX10: Math.round(value * 10),
        ttl: 8,
        hops: 0,
        id
      })
    );
  }

  clearAlerts() {
    this.store = [];
  }

  _need() {
    if (!this.inRange || !this.connected) {
      throw new Error('not connected');
    }
  }

  _add(bytes) {
    const p = decodePacket(bytes);

    if (!p) return;

    if (
      this.store.some(
        (s) =>
          packetKey(decodePacket(s)) === packetKey(p)
      )
    ) {
      return;
    }

    this.store.push(bytes.slice());

    while (this.store.length > this.capacity) {
      this.store.shift();
    }

    this.cb?.(bytes.slice());
  }
}
