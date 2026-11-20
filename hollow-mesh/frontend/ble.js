// ble.js — the laptop page for the Bluetooth demo.
//
// This laptop is a "courier". It pairs with Hollow boards (ESP32s acting as
// Bluetooth devices) once, then reconnects on its own whenever it walks back
// into range of one. On each connection it:
//   1. reads the alerts the board holds   -> adds them to its own mesh node
//   2. drops off the alerts it is carrying -> into the board's inbox
// So an alert can go: sensor board -> this laptop -> mailbox board -> another laptop,
// with no Wi-Fi and no server. The routing is the real MeshNode from mesh.js.
//
// Practice mode (?mock=1, or the button) swaps the real boards for pretend ones
// so you can rehearse the whole story on one screen.

import { MeshNode } from '../shared/mesh.js';
import { SENSOR_DEFS } from '../shared/sim.js';
import {
  SERVICE_UUID, NAME_PREFIX, KIND_CODE, KIND_NAME,
  encodePacket, decodePacket, packetKey, WebBluetoothBoard, MockBoard,
} from './ble-link.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);
const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();

let nodeId = params.get('id') || `LAPTOP-${rand()}`;
let node = makeNode();
const boards = [];      // { link, name, connected, connecting, pushing, known:Set, mock }
const notifs = [];      // {t, msg}
const events = [];      // activity log lines

function makeNode() {
  return new MeshNode(nodeId, {
    onDeliver: (msg) => { notifs.unshift({ t: new Date(), msg }); render(); },
  });
}

function log(text) {
  events.unshift({ t: new Date(), text });
  if (events.length > 30) events.pop();
  render();
}

// ----------------------------------------------- packets <-> mesh messages

const messageId = (kindName, id) => `ble-${kindName}-${id}`;

/** A packet read from a board becomes a mesh message. Reading is one hop. */
function ingest(p, board) {
  const kindName = KIND_NAME[p.kind];
  const def = SENSOR_DEFS[kindName];
  if (!def) return false;
  board.known.add(packetKey(p));
  const now = Date.now();
  const msg = {
    id: messageId(kindName, p.id), type: 'ALERT', sender: board.name, to: null,
    level: p.level, location: def.location,
    payload: { kind: kindName, title: def.title, advice: def.advice, value: p.valueX10 / 10, unit: def.unit },
    timestamp: now, expiresAt: now + 6 * 3600 * 1000,
    ttl: Math.max(0, p.ttl - 1), hops: p.hops + 1, sig: null,
  };
  const fresh = node.receive(msg);
  if (fresh) log(`Picked up "${def.title}" from ${board.name}`);
  return fresh;
}

/** A message we carry becomes a packet for a board. Dropping off is one hop. */
function packetFromMessage(m) {
  const mt = /^ble-([A-Z]+)-(\d+)$/.exec(m.id);
  if (!mt || !KIND_CODE[mt[1]]) return null;
  return {
    kind: KIND_CODE[mt[1]], level: m.level, valueX10: Math.round((m.payload?.value ?? 0) * 10),
    ttl: m.ttl, hops: m.hops, id: Number(mt[2]),
  };
}

async function pushTo(board) {
  if (board.pushing || !board.connected) return;
  board.pushing = true;
  try {
    for (const m of [...node.store.values()]) {
      if (board.name === 'Hollow-Sensor') continue;
      const pk = packetFromMessage(m);
      if (!pk || m.ttl <= 0) continue;
      if (board.known.has(packetKey(pk))) continue;         // the board already has it
      await board.link.write(encodePacket({ ...pk, ttl: pk.ttl - 1, hops: pk.hops + 1 }));
      board.known.add(packetKey(pk));
      log(`Dropped "${m.payload.title}" at ${board.name}`);
    }
  } catch { /* the connection dropped mid-write; we'll retry on reconnect */ }
  finally { board.pushing = false; render(); }
}

const syncAll = () => boards.forEach((b) => pushTo(b));

// ------------------------------------------------------ connection manager

async function connectBoard(b) {
  if (b.connecting || b.connected) return;
  b.connecting = true;
  render();
  try {
    await b.link.connect();
    b.connected = true;
    b.known = new Set();
    b.link.onDisconnect = () => { b.connected = false; log(`${b.name}: out of range`); };
    log(`Connected to ${b.name}`);
    for (const bytes of await b.link.readAll()) {
      const p = decodePacket(bytes);
      if (p) ingest(p, b);
    }
    await b.link.subscribe((bytes) => {
      const p = decodePacket(bytes);
      if (p && ingest(p, b)) syncAll();
    });
    await pushTo(b);
    syncAll();               // anything we just picked up should also reach other boards in range
  } catch {
    b.connected = false;
    b.link.disconnect();
  } finally {
    b.connecting = false;
    render();
  }
}

// every few seconds, try to reach any paired board we're not connected to
setInterval(() => boards.forEach((b) => { if (!b.connected && !b.connecting) connectBoard(b); }), 1500);

function addBoard(link, mock = false) {
  boards.push({ link, name: link.name, connected: false, connecting: false, pushing: false, known: new Set(), mock });
  render();
}

// -------------------------------------------------------------------- pairing

async function pair() {
  if (!window.isSecureContext || !navigator.bluetooth) {
    log('Web Bluetooth is not available. Use Chrome or Edge, and open this page from http://localhost (not a network address).');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE_UUID],
    });
    if (boards.some((b) => b.link.id === device.id)) { log(`${device.name} is already paired`); return; }
    addBoard(new WebBluetoothBoard(device));
    log(`Paired with ${device.name}. It will connect whenever it is in range.`);
  } catch (e) {
    if (e.name !== 'NotFoundError') log(`Pairing failed: ${e.message}`);   // NotFoundError = you closed the popup
  }
}

// ------------------------------------------------------------ practice mode

function startPractice() {
  if (boards.some((b) => b.mock)) return;
  addBoard(new MockBoard('Hollow-Sensor (practice)', 'sensor'), true);
  addBoard(new MockBoard('Hollow-Mailbox (practice)', 'mailbox'), true);
  log('Practice mode: tick "In range" to walk this laptop up to a board.');
}

function switchLaptop() {
  nodeId = `LAPTOP-${rand()}`;
  node = makeNode();
  notifs.length = 0;
  for (const b of boards) { b.known = new Set(); b.link.disconnect(); b.connected = false; }
  log(`You are now a different laptop (${nodeId}) with no memory of earlier alerts.`);
}

// ------------------------------------------------------------------------ UI

function render() {
  $('me').textContent = nodeId;
  const carrying = [...node.store.values()].filter((m) => m.ttl > 0).length;
  $('carry').innerHTML = `Carrying <b>${carrying}</b>`;
  $('practiceBtn').style.display = boards.some((b) => b.mock) ? 'none' : '';
  $('switchBtn').style.display = boards.some((b) => b.mock) ? '' : 'none';

  $('boards').innerHTML = boards.length ? boards.map((b, i) => {
    const state = b.connected ? '<span class="chip ok"><b>connected</b></span>'
      : b.connecting ? '<span class="chip"><b>looking…</b></span>' : '<span class="chip bad"><b>not in range</b></span>';
    const mockCtl = b.mock ? `
      <div class="mock">
        <label><input type="checkbox" data-act="range" data-i="${i}" ${b.link.inRange ? 'checked' : ''}> In range</label>
        ${b.link.role === 'sensor' ? `<button data-act="raise" data-i="${i}">Sensor raises alert</button><button data-act="clear" data-i="${i}">Clear</button>` : ''}
        <span class="muted">holds ${b.link.store.length} alert${b.link.store.length === 1 ? '' : 's'}</span>
      </div>` : '';
    return `<div class="board"><div class="bhead"><b>${esc(b.name)}</b>${state}</div>${mockCtl}</div>`;
  }).join('') : '<div class="empty">No boards paired yet. Stand near a board, press “Pair a board”, and pick it from the list.</div>';

  $('notifs').innerHTML = notifs.length ? notifs.map(({ t, msg }, i) => {
    const color = SENSOR_DEFS[msg.payload.kind]?.color ?? '#ffb020';
    const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `<div class="notif${i === 0 ? ' flash' : ''}" style="border-color:${color}"><b style="color:${color}">⚠ ${esc(msg.payload.title)}</b>${esc(msg.payload.advice)}<small>From Level ${msg.level} · reading ${msg.payload.value} ${esc(msg.payload.unit)} · Via Bluetooth · ${msg.hops} hop${msg.hops === 1 ? '' : 's'} · ${time}</small></div>`;
  }).join('') : '<div class="empty">Nothing yet. Walk this laptop near the sensor board.</div>';

  $('log').innerHTML = events.slice(0, 12).map((e) =>
    `<div class="logline"><span>${e.t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span> ${esc(e.text)}</div>`).join('');
}

document.addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  const b = boards[Number(e.target.dataset.i)];
  if (act === 'raise' && b?.mock) { b.link.raiseAlert('HEAT', 12, 41.2); log('Practice sensor started alarming (heat, 41.2 °C)'); }
  if (act === 'clear' && b?.mock) { b.link.clearAlerts(); render(); }
});
document.addEventListener('change', (e) => {
  if (e.target.dataset?.act === 'range') {
    const b = boards[Number(e.target.dataset.i)];
    if (b?.mock) { b.link.setInRange(e.target.checked); render(); }
  }
});
$('pairBtn').onclick = pair;
$('practiceBtn').onclick = startPractice;
$('switchBtn').onclick = switchLaptop;

if (params.get('mock') === '1') startPractice();
render();

// handy for poking around from the browser console, and for tests
window.ble = { boards, get node() { return node; }, get notifs() { return notifs; } };
