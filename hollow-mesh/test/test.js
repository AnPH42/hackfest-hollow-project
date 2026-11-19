// Run with: node --test   (or: npm test). Needs Node 18+.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MeshNode, runEncounters, stepEncounters } from '../shared/mesh.js';
import { encodePacket, decodePacket, splitPackets, MockBoard, KIND_CODE } from '../frontend/ble-link.js';

// A controllable clock so tests can fast-forward time.
function makeClock(start = 1_000_000) {
  let t = start;
  const clock = () => t;
  clock.advance = (ms) => { t += ms; };
  return clock;
}

const mk = (id, opts = {}) => new MeshNode(id, opts);

test('direct hop: a broadcast alert reaches a neighbor', () => {
  const sensor = mk('sensor-1');
  const phone = mk('phone-A');
  sensor.originate({ type: 'ALERT', level: 9, location: 'Recycler 3', payload: { kind: 'WATER_BAD' } });
  sensor.meet(phone);
  assert.equal(phone.inbox.length, 1);
  assert.equal(phone.inbox[0].payload.kind, 'WATER_BAD');
});

test('dedup: meeting repeatedly never duplicates delivery', () => {
  const a = mk('A');
  const b = mk('B');
  a.originate({ type: 'ALERT' });
  a.meet(b);
  a.meet(b);
  b.meet(a);
  assert.equal(b.inbox.length, 1);
});

test('TTL: message stops after its hop budget', () => {
  // A -> B -> C -> D chain, ttl=2 allows exactly two hops.
  const [A, B, C, D] = ['A', 'B', 'C', 'D'].map((id) => mk(id));
  A.originate({ type: 'ALERT', ttl: 2 });
  A.meet(B);
  B.meet(C);
  C.meet(D);
  assert.equal(B.inbox.length, 1);
  assert.equal(C.inbox.length, 1);
  assert.equal(D.inbox.length, 0, 'D is 3 hops away, beyond ttl');
});

test('store-and-forward: a courier carries a message across a gap', () => {
  const sensorDeep = mk('sensor-L12');
  const courier = mk('courier');
  const upperResident = mk('resident-L4');

  sensorDeep.originate({ type: 'ALERT', level: 12, payload: { kind: 'POWER_OUT' } });

  // Sensor and upper resident are never in range of each other.
  sensorDeep.meet(courier);             // courier walks past the sensor...
  assert.equal(upperResident.inbox.length, 0);
  courier.meet(upperResident);          // ...and later passes the upper level.
  assert.equal(upperResident.inbox.length, 1);
  assert.equal(upperResident.inbox[0].level, 12);
});

test('targeted check-in: only the recipient gets it, others just relay', () => {
  const mom = mk('mom');
  const stranger = mk('stranger');
  const kid = mk('kid');

  kid.originate({ type: 'CHECKIN', to: 'mom', payload: { status: 'OK' } });
  kid.meet(stranger);
  assert.equal(stranger.inbox.length, 0, 'stranger is not the recipient');
  stranger.meet(mom);
  assert.equal(mom.inbox.length, 1);
  assert.equal(mom.inbox[0].sender, 'kid');
});

test('expiry: old messages are dropped and not delivered', () => {
  const clock = makeClock();
  const a = mk('A', { clock });
  const b = mk('B', { clock });
  a.originate({ type: 'ALERT', lifetimeMs: 60_000 });
  clock.advance(61_000);
  a.meet(b);
  assert.equal(b.inbox.length, 0);
});

test('buffer limit: low-priority messages are evicted before alerts', () => {
  const a = mk('A', { maxStore: 2 });
  const alert = a.originate({ type: 'ALERT' });
  a.originate({ type: 'REPORT' });
  a.originate({ type: 'REPORT' });
  assert.equal(a.store.size, 2);
  assert.ok(a.store.has(alert.id), 'alert survives eviction');
});

test('verify hook: forged messages are rejected', () => {
  const a = mk('A');
  const b = mk('B', { verify: (msg) => msg.sig === 'valid' });
  a.originate({ type: 'ALERT' });
  a.meet(b);
  assert.equal(b.inbox.length, 0);
});

test('runEncounters: simulator tick spreads a message through a crowd', () => {
  // Five nodes in a line; each is only in range of its immediate neighbors.
  const nodes = ['n0', 'n1', 'n2', 'n3', 'n4'].map((id, i) => {
    const n = mk(id);
    n.x = i;
    return n;
  });
  nodes[0].originate({ type: 'ALERT' });
  const inRange = (a, b) => Math.abs(a.x - b.x) === 1;

  // Within one tick, ordering lets it ripple down the chain; a second tick is harmless.
  runEncounters(nodes, inRange);
  runEncounters(nodes, inRange);
  assert.equal(nodes[4].inbox.length, 1);
});

test('onDeliver callback fires once per delivered message', () => {
  const got = [];
  const a = mk('A');
  const b = mk('B', { onDeliver: (m) => got.push(m.type) });
  a.originate({ type: 'ALERT' });
  a.meet(b);
  a.meet(b);
  assert.deepEqual(got, ['ALERT']);
});

test('stepEncounters: a message moves exactly one hop per step', () => {
  const nodes = ['n0', 'n1', 'n2', 'n3', 'n4'].map((id, i) => {
    const n = mk(id);
    n.x = i;
    return n;
  });
  nodes[0].originate({ type: 'ALERT' });
  const inRange = (a, b) => Math.abs(a.x - b.x) === 1;

  let t = stepEncounters(nodes, inRange);
  assert.equal(t.length, 1);
  assert.equal(nodes[1].inbox.length, 1);
  assert.equal(nodes[2].inbox.length, 0, 'second hop must wait for the next step');

  stepEncounters(nodes, inRange);
  assert.equal(nodes[2].inbox.length, 1);
  stepEncounters(nodes, inRange);
  stepEncounters(nodes, inRange);
  assert.equal(nodes[4].inbox.length, 1);

  t = stepEncounters(nodes, inRange);
  assert.equal(t.length, 0, 'nothing new to hand over once everyone has it');
});

// ---- Bluetooth packet format (must match BLE-SPEC.md) ----

test('ble packet: encodes to the exact bytes in the spec example', () => {
  const bytes = encodePacket({ kind: KIND_CODE.HEAT, level: 12, valueX10: 412, ttl: 8, hops: 0, id: 0x1234 });
  assert.deepEqual([...bytes], [0x48, 0x4d, 5, 12, 0x9c, 0x01, 8, 0, 0x34, 0x12]);
});

test('ble packet: round-trips, including negative readings', () => {
  const p = { kind: KIND_CODE.POWER, level: 12, valueX10: -55, ttl: 3, hops: 2, id: 65535 };
  assert.deepEqual(decodePacket(encodePacket(p)), p);
});

test('ble packet: rejects bad magic, wrong length and unknown kind', () => {
  const good = encodePacket({ kind: 5, level: 12, valueX10: 1, ttl: 1, hops: 0, id: 1 });
  const badMagic = good.slice(); badMagic[0] = 0;
  const badKind = good.slice(); badKind[2] = 99;
  assert.equal(decodePacket(badMagic), null);
  assert.equal(decodePacket(badKind), null);
  assert.equal(decodePacket(good.slice(0, 9)), null);
});

test('ble: splitPackets cuts a long read into 10-byte packets', () => {
  const a = encodePacket({ kind: 5, level: 12, valueX10: 1, ttl: 1, hops: 0, id: 1 });
  const b = encodePacket({ kind: 3, level: 9, valueX10: 2, ttl: 1, hops: 0, id: 2 });
  const both = new Uint8Array([...a, ...b]);
  assert.equal(splitPackets(both).length, 2);
});

test('ble mock board: dedups repeats, caps its store, and only answers in range', async () => {
  const box = new MockBoard('Hollow-Mailbox', 'mailbox', 2);
  await assert.rejects(box.connect(), /out of range/);
  box.setInRange(true);
  await box.connect();
  const pk = (id) => encodePacket({ kind: 5, level: 12, valueX10: 400, ttl: 5, hops: 1, id });
  await box.write(pk(1)); await box.write(pk(1)); await box.write(pk(2)); await box.write(pk(3));
  assert.equal((await box.readAll()).length, 2, 'capacity 2, oldest dropped');
  box.setInRange(false);
  await assert.rejects(box.readAll(), /not connected/);
});
