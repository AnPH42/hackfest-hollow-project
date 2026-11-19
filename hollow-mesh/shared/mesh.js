// mesh.js — core routing logic for the Hollow mesh network.
//
// No browser or networking code in here on purpose: it runs unchanged in Node
// (tests, bridge) and in the browser (simulator). A "transport" (the simulator,
// Web Bluetooth, an ESP32 bridge, ...) only has to decide WHEN two nodes meet
// and then call a.meet(b).
//
// How it works (epidemic / delay-tolerant routing):
//   - Every message has a unique id, so a node never processes it twice (dedup).
//   - Every message has a TTL = how many more hops this copy may travel.
//   - Every node keeps a buffer of messages it has seen (store-and-forward).
//     When it meets someone who hasn't seen a message, it hands it over.
//     A commuter walking between levels carries messages across gaps.

export const MessageType = Object.freeze({
  ALERT: 'ALERT',       // sensor or verified warning: power, air, water, flooding
  CHECKIN: 'CHECKIN',   // "I'm OK" beacons, usually addressed to a specific person
  REPORT: 'REPORT',     // resident reports: symptoms, hazards, supply needs
  BULLETIN: 'BULLETIN', // neighborhood announcements and organizing
});

// Higher number = kept longer when a node's buffer is full.
const PRIORITY = { ALERT: 3, CHECKIN: 2, BULLETIN: 1, REPORT: 1 };

export const DEFAULT_TTL = 8;                          // max hops
export const DEFAULT_LIFETIME_MS = 6 * 60 * 60 * 1000; // drop after 6 hours

let counter = 0;

/**
 * Message format. Every field here is part of the wire format, so agree on it
 * with your team before building on top of it.
 *
 *  id         unique id (used for dedup)
 *  type       one of MessageType
 *  sender     sender's public key / node id
 *  to         recipient id, or null for broadcast
 *  level      Hollow level the message is about (e.g. 12)
 *  location   free-form place name, e.g. "Recycler 3" or { x, y }
 *  payload    type-specific data, e.g. { kind: 'WATER_BAD', value: 412, unit: 'ppm' }
 *  timestamp  creation time (ms since epoch)
 *  expiresAt  after this time nodes drop it
 *  ttl        remaining hops for this copy
 *  hops       hops travelled so far (handy for the simulator's stats)
 *  sig        signature over the message (stub for now, see `verify` below)
 */
export function createMessage({
  type,
  sender,
  to = null,
  level = null,
  location = null,
  payload = {},
  ttl = DEFAULT_TTL,
  lifetimeMs = DEFAULT_LIFETIME_MS,
  now = Date.now(),
}) {
  if (!MessageType[type]) throw new Error(`Unknown message type: ${type}`);
  if (!sender) throw new Error('Message needs a sender');
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 6);
  return {
    id: `${sender}-${now.toString(36)}-${counter}-${rand}`,
    type,
    sender,
    to,
    level,
    location,
    payload,
    timestamp: now,
    expiresAt: now + lifetimeMs,
    ttl,
    hops: 0,
    sig: null,
  };
}

export class MeshNode {
  /**
   * @param {string} id  this node's id (public key in the real system)
   * @param {object} opts
   *   maxStore   max messages kept for forwarding
   *   clock      () => ms; pass the simulator's clock so time can be sped up
   *   verify     (msg) => boolean; reject forged messages. Stub accepts all;
   *              swap in a real signature check (WebCrypto / tweetnacl) later.
   *   onDeliver  (msg) => void; called when a message addressed to us (or
   *              broadcast) arrives. The UI hooks notifications here.
   */
  constructor(id, { maxStore = 200, clock = Date.now, verify = () => true, onDeliver = null } = {}) {
    this.id = id;
    this.maxStore = maxStore;
    this.clock = clock;
    this.verify = verify;
    this.onDeliver = onDeliver;

    this.seen = new Set();    // ids we've already processed (dedup)
    this.store = new Map();   // id -> message copy we may still forward
    this.inbox = [];          // messages delivered to this node
  }

  /** Create a message at this node and queue it for forwarding. */
  originate(fields) {
    const msg = createMessage({ ...fields, sender: this.id, now: this.clock() });
    this.seen.add(msg.id);
    this._store(msg);
    return msg;
  }

  /**
   * Receive a message from a neighbor. Returns true if it was new and accepted.
   */
  receive(msg) {
    if (this.seen.has(msg.id)) return false;      // dedup
    if (this._expired(msg)) return false;         // too old
    if (!this.verify(msg)) return false;          // forged / invalid

    this.seen.add(msg.id);

    const forMe = msg.to === null || msg.to === this.id;
    if (forMe) {
      this.inbox.push(msg);
      if (this.onDeliver) this.onDeliver(msg);
    }

    // Keep relaying unless it reached its specific target or ran out of hops.
    if (msg.to !== this.id && msg.ttl > 0) this._store({ ...msg });
    return true;
  }

  /**
   * Two nodes come into range: swap everything the other side hasn't seen.
   * Returns counts so the simulator can animate/report traffic.
   */
  meet(other) {
    return {
      sentToOther: this._forwardTo(other),
      sentToThis: other._forwardTo(this),
    };
  }

  _forwardTo(other) {
    this._prune();
    let sent = 0;
    for (const m of this.store.values()) {
      if (m.ttl <= 0) continue;
      if (other.seen.has(m.id)) continue;
      // Receiver gets a copy with one fewer hop left.
      const copy = { ...m, ttl: m.ttl - 1, hops: m.hops + 1 };
      if (other.receive(copy)) sent += 1;
    }
    return sent;
  }

  _store(msg) {
    this.store.set(msg.id, msg);
    this._prune();
    // Buffer full: evict lowest priority, then oldest.
    while (this.store.size > this.maxStore) {
      let victim = null;
      for (const m of this.store.values()) {
        if (
          victim === null ||
          PRIORITY[m.type] < PRIORITY[victim.type] ||
          (PRIORITY[m.type] === PRIORITY[victim.type] && m.timestamp < victim.timestamp)
        ) {
          victim = m;
        }
      }
      this.store.delete(victim.id);
    }
  }

  _expired(msg) {
    return this.clock() >= msg.expiresAt;
  }

  _prune() {
    for (const [id, m] of this.store) {
      if (this._expired(m)) this.store.delete(id);
    }
  }
}

/**
 * Simulator helper: call once per tick. `inRange(a, b)` decides whether two
 * nodes are close enough to talk (distance check, same level, shaft, etc.).
 * Returns the list of encounters so you can draw message hops.
 */
export function runEncounters(nodes, inRange) {
  const encounters = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (inRange(nodes[i], nodes[j])) {
        const result = nodes[i].meet(nodes[j]);
        if (result.sentToOther || result.sentToThis) {
          encounters.push({ a: nodes[i].id, b: nodes[j].id, ...result });
        }
      }
    }
  }
  return encounters;
}

/**
 * One synchronized "hop" for the whole network. Unlike runEncounters (where a
 * message can ripple through a whole connected cluster in a single call), this
 * snapshots every node's buffer first, so a message moves at most ONE hop per
 * call. Call it on a timer (e.g. every 0.5 s of simulated time) and the spread
 * of a message is visible and realistic.
 *
 * Returns [{ from, to, msg }] for every message handed over this step, so the
 * UI can animate it.
 */
export function stepEncounters(nodes, inRange) {
  const snapshot = nodes.map((n) => {
    n._prune();
    return [...n.store.values()];
  });
  const transfers = [];
  const hand = (from, to, msgs) => {
    for (const m of msgs) {
      if (m.ttl <= 0 || to.seen.has(m.id)) continue;
      const copy = { ...m, ttl: m.ttl - 1, hops: m.hops + 1 };
      if (to.receive(copy)) transfers.push({ from: from.id, to: to.id, msg: copy });
    }
  };
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      if (inRange(nodes[i], nodes[j])) {
        hand(nodes[i], nodes[j], snapshot[i]);
        hand(nodes[j], nodes[i], snapshot[j]);
      }
    }
  }
  return transfers;
}
