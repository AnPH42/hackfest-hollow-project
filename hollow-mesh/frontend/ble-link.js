
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

    device.addEventListener(
      'gattserverdisconnected',
      () => this.onDisconnect?.()
    );
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
  }

  // Read emergency alerts
  async readAll() {
    const dv = await this.feed.readValue();

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
    await this.feed.startNotifications();

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

    await fn.call(this.inbox, bytes);
  }

  // ----------------------------------------------------------
  // Upload community message in BLE chunks
  // ----------------------------------------------------------

  async writeCommunity(message) {
    if (!this.communityInbox) {
      throw new Error('Community Inbox not available');
    }

    const bytes = new TextEncoder().encode(
      JSON.stringify(message)
    );

    if (bytes.length === 0 || bytes.length > 512) {
      throw new Error('Community message exceeds 512 bytes');
    }

    const write = async (data) => {
      const fn =
        this.communityInbox.writeValueWithResponse ??
        this.communityInbox.writeValue;

      await fn.call(this.communityInbox, data);
    };

    // Start transfer
    await write(new Uint8Array([
      0x53,
      bytes.length & 0xff,
      (bytes.length >> 8) & 0xff
    ]));

    let sequence = 0;

    // Send 18 bytes per chunk
    for (let i = 0; i < bytes.length; i += 18) {
      const chunk = bytes.slice(i, i + 18);
      const packet = new Uint8Array(chunk.length + 2);

      packet[0] = 0x44;
      packet[1] = sequence++;
      packet.set(chunk, 2);

      await write(packet);
    }

    // End transfer
    await write(new Uint8Array([0x45]));
  }

  // ----------------------------------------------------------
  // Retrieve stored community messages
  // ----------------------------------------------------------

  async readCommunity() {
    if (!this.communityFeed || !this.communityInbox) {
      return [];
    }

    const write = async (data) => {
      const fn =
        this.communityInbox.writeValueWithResponse ??
        this.communityInbox.writeValue;

      await fn.call(this.communityInbox, data);
    };

    const read = async () => {
      const dv = await this.communityFeed.readValue();

      return new Uint8Array(
        dv.buffer,
        dv.byteOffset,
        dv.byteLength
      ).slice();
    };

    // Ask mailbox how many messages it holds.
    await write(new Uint8Array([0x4e])); // N

    const countReply = await read();

    if (
      countReply.length !== 2 ||
      countReply[0] !== 0x4e
    ) {
      throw new Error('Invalid community count response');
    }

    const count = Math.min(countReply[1], 4);
    const messages = [];

    for (let index = 0; index < count; index++) {
      const chunks = [];
      let totalChunks = null;

      for (let chunk = 0; chunk < 32; chunk++) {
        // Request message index and chunk index.
        await write(new Uint8Array([
          0x52,
          index,
          chunk
        ]));

        const reply = await read();

        if (
          reply.length < 4 ||
          reply[0] !== 0x46 ||
          reply[1] !== index ||
          reply[3] !== chunk
        ) {
          throw new Error('Invalid community chunk response');
        }

        if (totalChunks === null) {
          totalChunks = reply[2];

          if (totalChunks === 0 || totalChunks > 32) {
            throw new Error('Invalid community chunk count');
          }
        }

        if (reply[2] !== totalChunks) {
          throw new Error('Community message changed during read');
        }

        chunks.push(reply.slice(4));

        if (chunk + 1 >= totalChunks) {
          break;
        }
      }

      const length = chunks.reduce(
        (sum, part) => sum + part.length,
        0
      );

      const bytes = new Uint8Array(length);
      let offset = 0;

      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.length;
      }

      try {
        const message = JSON.parse(
          new TextDecoder().decode(bytes)
        );

        if (
          ['CHECKIN', 'REPORT', 'BULLETIN'].includes(
            message.type
          )
        ) {
          messages.push(message);
        }
      } catch {
        // Ignore malformed messages.
      }
    }

    return messages;
  }

  disconnect() {
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
