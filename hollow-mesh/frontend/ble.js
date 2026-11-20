// ble.js — the courier page for the Bluetooth proximity demo.
//
// This device is a "courier". It pairs with Hollow boards (ESP32s acting as
// Bluetooth devices) once, then reconnects on its own whenever it walks back
// into range of one. On each connection it:
//   1. reads the alerts & community messages the board holds -> adds to MeshNode
//   2. drops off the alerts & community messages it carries   -> into the mailbox
// So messages travel: sensor/courier -> this device -> mailbox ESP32 -> another device,
// with no Wi-Fi and no server. Routing uses the real MeshNode from mesh.js.
//
// When server.js is reachable, ble.js sends optional, fail-silent spectator
// telemetry (/events + /telemetry) so board.html lights up with hops in real time.

import { MeshNode } from '../shared/mesh.js';
import { SENSOR_DEFS, LEVELS } from '../shared/sim.js';
import {
  SERVICE_UUID, NAME_PREFIX, KIND_CODE, KIND_NAME,
  encodePacket, decodePacket, packetKey, WebBluetoothBoard, MockBoard,
} from './ble-link.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const params = new URLSearchParams(location.search);
const rand = () => Math.random().toString(36).slice(2, 6).toUpperCase();

let nodeId = params.get('id') || `COURIER-${rand()}`;
let node = makeNode();
const boards = [];      // { link, name, role, connected, connecting, pushing, communityPushing, known:Set, communityKnown:Set, packets:Array, communityPackets:Array, mock }
const notifs = [];      // { t, msg }
const events = [];      // { t, text, kind }
let droppedCount = 0;   // total items dropped into a mailbox this session

let boardEs = null;
let telemetryOnline = false;
let telemetryRetryTimer = null;
let flushingTelemetry = false;
const telemetryQueue = [];
let currentZone = 0;

function makeNode() {
  return new MeshNode(nodeId, {
    onDeliver: (msg) => { notifs.unshift({ t: new Date(), msg }); render(); },
  });
}

function log(text, kind = 'info') {
  events.unshift({ t: new Date(), text, kind });
  if (events.length > 40) events.pop();
  render();
}

function inferRole(link) {
  if (link.role) return link.role;
  return /sensor/i.test(link.name) ? 'sensor' : 'mailbox';
}

function zoneForLevel(levelId) {
  const idx = LEVELS.findIndex((lv) => lv.id === levelId);
  return idx >= 0 ? idx : 0;
}

// ----------------------------------------- optional spectator board telemetry

function scheduleTelemetryReconnect() {
  if (telemetryRetryTimer) return;
  telemetryRetryTimer = setTimeout(() => {
    telemetryRetryTimer = null;
    connectBoardTelemetry();
  }, 4000);
}

function connectBoardTelemetry() {
  if (boardEs) { try { boardEs.close(); } catch { /* ignore */ } boardEs = null; }
  try {
    const es = new EventSource(`/events?id=${encodeURIComponent(nodeId)}&zone=${currentZone}&rtc=0`);
    boardEs = es;
    es.onopen = () => {
      telemetryOnline = true;
      flushTelemetry();
    };
    es.addEventListener('hello', () => {
      telemetryOnline = true;
      flushTelemetry();
    });
    es.onerror = () => {
      telemetryOnline = false;
      if (boardEs === es) {
        try { es.close(); } catch { /* ignore */ }
        boardEs = null;
      }
      scheduleTelemetryReconnect();
    };
  } catch {
    telemetryOnline = false;
    scheduleTelemetryReconnect();
  }
}

async function flushTelemetry() {
  if (flushingTelemetry || !telemetryOnline || !telemetryQueue.length) return;
  flushingTelemetry = true;
  try {
    while (telemetryQueue.length && telemetryOnline) {
      const item = telemetryQueue.shift();
      try {
        const res = await fetch('/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch {
        telemetryQueue.unshift(item);
        telemetryOnline = false;
        break;
      }
    }
  } finally {
    flushingTelemetry = false;
  }
}

function moveBoardZone(zone) {
  if (zone === currentZone) return;
  currentZone = zone;
  if (!telemetryOnline) return;
  fetch('/zone', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: nodeId, zone: currentZone }),
  }).catch(() => {});
}

function reportBoardHop(from, to, zone, msg) {
  telemetryQueue.push({ from, to, zone, msg });
  if (telemetryQueue.length > 50) telemetryQueue.shift();
  if (telemetryOnline) flushTelemetry();
}

// ----------------------------------------------- packets <-> mesh messages

const messageId = (kindName, id) => `ble-${kindName}-${id}`;

function upsertBoardPacket(board, p) {
  const key = packetKey(p);
  const idx = board.packets.findIndex((x) => packetKey(x) === key);
  if (idx >= 0) board.packets[idx] = p;
  else {
    board.packets.push(p);
    while (board.packets.length > 4) board.packets.shift();
  }
}

function upsertCommunityPacket(board, msg) {
  const idx = board.communityPackets.findIndex((x) => x.id === msg.id);
  if (idx >= 0) board.communityPackets[idx] = msg;
  else {
    board.communityPackets.push(msg);
    while (board.communityPackets.length > 4) board.communityPackets.shift();
  }
}

/** A packet read from a board becomes a mesh message. Reading is one hop. */
function ingest(p, board) {
  const kindName = KIND_NAME[p.kind];
  const def = SENSOR_DEFS[kindName];
  if (!def) return false;
  board.known.add(packetKey(p));
  upsertBoardPacket(board, p);
  const now = Date.now();
  const msg = {
    id: messageId(kindName, p.id), type: 'ALERT', sender: board.name, to: null,
    level: p.level, location: def.location,
    payload: { kind: kindName, title: def.title, advice: def.advice, value: p.valueX10 / 10, unit: def.unit },
    timestamp: now, expiresAt: now + 6 * 3600 * 1000,
    ttl: Math.max(0, p.ttl - 1), hops: p.hops + 1, sig: null,
  };
  const fresh = node.receive(msg);
  if (fresh) {
    const z = zoneForLevel(p.level);
    moveBoardZone(z);
    reportBoardHop(board.name, nodeId, z, msg);
    log(`Picked up "${def.title}" from ${board.name} (hop ${msg.hops})`, 'pickup');
  }
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
      if (board.role === 'sensor' || board.name === 'Hollow-Sensor') continue;
      const pk = packetFromMessage(m);
      if (!pk || m.ttl <= 0) continue;
      if (board.known.has(packetKey(pk))) continue;
      const outPkt = { ...pk, ttl: pk.ttl - 1, hops: pk.hops + 1 };
      await board.link.write(encodePacket(outPkt));
      board.known.add(packetKey(pk));
      upsertBoardPacket(board, outPkt);
      droppedCount++;
      moveBoardZone(0);
      reportBoardHop(nodeId, board.name, 0, { ...m, hops: outPkt.hops });
      log(`Transferred "${m.payload.title}" to ${board.name} (hop ${outPkt.hops})`, 'dropoff');
    }
  } catch { /* connection dropped mid-write; will retry on reconnect */ }
  finally { board.pushing = false; render(); }
}

const syncAll = () => boards.forEach((b) => pushTo(b));

// Community BLE messages use a separate characteristic from emergency alerts.
// Queue messages in MeshNode and retry whenever a mailbox reconnects.
const COMMUNITY_TYPES = new Set(['CHECKIN', 'REPORT', 'BULLETIN']);

function communityWireMessage(m) {
  return {
    id: m.id, type: m.type, sender: m.sender,
    to: m.to ?? null, level: m.level,
    payload: m.payload, timestamp: m.timestamp,
    expiresAt: m.expiresAt, ttl: m.ttl, hops: m.hops, sig: null,
  };
}

async function receiveCommunityMessages(board) {
  if (board.role !== 'mailbox' || typeof board.link.readCommunity !== 'function') return;
  try {
    const messages = await board.link.readCommunity();
    let fresh = 0;
    for (const msg of messages) {
      if (!msg || !COMMUNITY_TYPES.has(msg.type) || !msg.id) continue;
      upsertCommunityPacket(board, msg);
      if (node.receive(msg)) {
        fresh++;
        reportBoardHop(board.name, nodeId, zoneForLevel(msg.level), msg);
      }
      board.communityKnown.add(msg.id);
    }
    if (fresh) log(`Picked up ${fresh} community message(s) from ${board.name}`, 'pickup');
    render();
  } catch (error) {
    log(`Community retrieval failed: ${error.message}`);
  }
}

async function pushCommunity(board) {
  if (!board.connected || board.role !== 'mailbox' || board.communityPushing) return;
  if (typeof board.link.writeCommunity !== 'function') return;
  board.communityPushing = true;
  try {
    for (const m of [...node.store.values()]) {
      if (!COMMUNITY_TYPES.has(m.type) || m.ttl <= 0) continue;
      if (board.communityKnown.has(m.id)) continue;
      const outbound = communityWireMessage({ ...m, ttl: m.ttl - 1, hops: m.hops + 1 });
      await board.link.writeCommunity(outbound);
      board.communityKnown.add(m.id);
      upsertCommunityPacket(board, outbound);
      droppedCount++;
      reportBoardHop(nodeId, board.name, zoneForLevel(m.level), outbound);
      log(`Transferred ${m.type} to ${board.name} (hop ${outbound.hops})`, 'dropoff');
    }
  } catch (error) {
    log(`Community send failed: ${error.message}`);
  } finally {
    board.communityPushing = false;
    render();
  }
}

function sendCommunityMessage() {
  for (const board of boards) {
    if (board.connected && board.role === 'mailbox') void pushCommunity(board);
  }
}

// ------------------------------------------------------ connection manager

async function connectBoard(b) {
  if (b.connecting || b.connected) return;
  b.connecting = true;
  render();
  try {
    await b.link.connect();
    b.connected = true;
    b.known = new Set();
    b.communityKnown = new Set();
    b.packets = [];
    b.communityPackets = [];
    if (b.role === 'sensor') moveBoardZone(3);
    else moveBoardZone(0);
    b.link.onDisconnect = () => {
      b.connected = false;
      log(`${b.name}: out of range`, 'info');
    };
    log(`Connected to ${b.name} (in range)`, 'info');
    for (const bytes of await b.link.readAll()) {
      const p = decodePacket(bytes);
      if (p) ingest(p, b);
    }
    await b.link.subscribe((bytes) => {
      const p = decodePacket(bytes);
      if (p && ingest(p, b)) syncAll();
    });
    await receiveCommunityMessages(b);
    await pushTo(b);
    await pushCommunity(b);
    syncAll();
  } catch {
    b.connected = false;
    b.link.disconnect();
  } finally {
    b.connecting = false;
    render();
  }
}

setInterval(() => boards.forEach((b) => { if (!b.connected && !b.connecting) connectBoard(b); }), 1500);

function addBoard(link, mock = false) {
  boards.push({
    link,
    name: link.name,
    role: inferRole(link),
    connected: false,
    connecting: false,
    pushing: false,
    communityPushing: false,
    communityKnown: new Set(),
    known: new Set(),
    packets: [],
    communityPackets: [],
    mock,
  });
  render();
}

// -------------------------------------------------------------------- pairing

async function pair() {
  if (!window.isSecureContext || !navigator.bluetooth) {
    log(`Web Bluetooth unavailable on ${location.origin}. Enable the Chrome flag or open localhost.`, 'info');
    return;
  }
  try {
    const device = await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: NAME_PREFIX }], optionalServices: [SERVICE_UUID],
    });
    if (boards.some((b) => b.link.id === device.id)) { log(`${device.name} is already paired`); return; }
    addBoard(new WebBluetoothBoard(device));
    log(`Paired with ${device.name}. It will auto-connect whenever in range.`);
  } catch (e) {
    if (e.name !== 'NotFoundError') log(`Pairing failed: ${e.message}`);
  }
}

// ----------------------------------------------- check-in, reports, bulletins

function sendCheckin() {
  const name = ($('checkinName')?.value || '').trim() || nodeId;
  const level = Number($('checkinLevel')?.value || 12);
  const msg = node.originate({
    type: 'CHECKIN',
    level,
    ttl: 12,
    payload: { name, status: 'OK' },
  });
  notifs.unshift({ t: new Date(), msg });
  const z = zoneForLevel(level);
  moveBoardZone(z);
  reportBoardHop(name, nodeId, z, msg);
  log(`Check-in sent: ${name} is OK (Level ${level})`, 'dropoff');
  sendCommunityMessage();
}

function sendReport() {
  const category = $('reportKind')?.value || 'Lung sickness';
  const level = Number($('reportLevel')?.value || 12);
  const note = ($('reportNote')?.value || '').trim() || 'Reported by resident on site.';
  const title = `${category} — Level ${level}`;
  const msg = node.originate({
    type: 'REPORT',
    level,
    ttl: 12,
    payload: { category, title, note },
  });
  if ($('reportNote')) $('reportNote').value = '';
  notifs.unshift({ t: new Date(), msg });
  const z = zoneForLevel(level);
  moveBoardZone(z);
  reportBoardHop(nodeId, `Level ${level}`, z, msg);
  log(`Symptom/supply report logged: ${title}`, 'pickup');
  sendCommunityMessage();
}

function sendBulletin() {
  const category = $('bulletinKind')?.value || 'Sharing food / water';
  const level = Number($('bulletinLevel')?.value || 12);
  const note = ($('bulletinNote')?.value || '').trim() || 'Available now—ask locally.';
  const title = `${category} — Level ${level}`;
  const msg = node.originate({
    type: 'BULLETIN',
    level,
    ttl: 12,
    payload: { category, title, note },
  });
  if ($('bulletinNote')) $('bulletinNote').value = '';
  notifs.unshift({ t: new Date(), msg });
  const z = zoneForLevel(level);
  moveBoardZone(z);
  reportBoardHop(nodeId, `Level ${level}`, z, msg);
  log(`Resource bulletin posted: ${title}`, 'dropoff');
  sendCommunityMessage();
}

// ------------------------------------------------------------ practice & reset

function startPractice() {
  if (boards.some((b) => b.mock)) return;
  addBoard(new MockBoard('Hollow-Sensor (practice)', 'sensor'), true);
  addBoard(new MockBoard('Hollow-Mailbox (practice)', 'mailbox'), true);
  log('Practice mode ready: tick "In range" to walk this device between boards.');
}

function resetView() {
  node = makeNode();
  notifs.length = 0;
  events.length = 0;
  telemetryQueue.length = 0;
  droppedCount = 0;
  for (const b of boards) {
    b.known = new Set();
    b.communityKnown = new Set();
    b.packets = [];
    b.communityPackets = [];
  }
  log('View reset (paired boards kept). Ready for next demo run.');
}

function switchLaptop() {
  nodeId = `COURIER-${rand()}`;
  node = makeNode();
  notifs.length = 0;
  telemetryQueue.length = 0;
  droppedCount = 0;
  telemetryOnline = false;
  for (const b of boards) {
    b.known = new Set();
    b.communityKnown = new Set();
    b.packets = [];
    b.communityPackets = [];
    b.link.disconnect();
    b.connected = false;
  }
  connectBoardTelemetry();
  log(`Switched to a new device (${nodeId}) with an empty memory.`);
}

// ------------------------------------------------------------------------ UI

function renderCompat() {
  const el = $('compatBanner');
  if (!window.isSecureContext) {
    el.style.display = 'block';
    el.innerHTML = `<b>Web Bluetooth requires a secure origin (currently <code>${esc(location.origin)}</code>).</b> On this device, open <code>chrome://flags/#unsafely-treat-insecure-origin-as-secure</code>, enable it, add <code>${esc(location.origin)}</code> (including the port), and relaunch Chrome—or open from <b>http://localhost:3000/ble.html</b>.`;
  } else if (!navigator.bluetooth) {
    el.style.display = 'block';
    el.innerHTML = '<b>Web Bluetooth is not supported in this browser.</b> Use <b>Chrome or Edge</b> on desktop or Android (iOS browsers do not support Web Bluetooth), or use <b>Practice with simulated boards</b> below.';
  } else {
    el.style.display = 'none';
  }
}

function renderPipeline(carrying) {
  const sensor = boards.find((b) => b.role === 'sensor');
  const mailbox = boards.find((b) => b.role === 'mailbox');
  const sensorHasAlert = (sensor?.packets.length ?? 0) > 0 || (sensor?.mock && sensor.link.store.length > 0);
  const mailboxHasMsg = (mailbox?.packets.length ?? 0) > 0
    || (mailbox?.communityPackets.length ?? 0) > 0
    || (mailbox?.mock && (mailbox.link.store.length > 0 || (mailbox.link.communityStore?.length ?? 0) > 0));
  const relayedFromMailbox = notifs.some((n) => n.msg.hops >= 3);

  const stages = [
    {
      num: 'Step 1 · Detect',
      title: 'Sensor ESP32',
      sub: !sensor ? 'Not paired yet' : sensor.connected ? (sensorHasAlert ? 'In range · alert active' : 'In range · monitoring') : 'Out of range',
      cls: sensor?.connected ? 'active' : '',
    },
    {
      num: 'Step 2 · Carry',
      title: 'This Device',
      sub: carrying > 0 ? `Carrying ${carrying} item${carrying === 1 ? '' : 's'}` : 'Ready to pick up',
      cls: carrying > 0 ? 'carrying' : '',
    },
    {
      num: 'Step 3 · Drop off',
      title: 'Mailbox ESP32',
      sub: !mailbox ? 'Not paired yet' : mailbox.connected ? (mailboxHasMsg ? 'In range · stored!' : 'In range · waiting') : (droppedCount > 0 ? `Delivered (${droppedCount})` : 'Out of range'),
      cls: (mailbox?.connected || droppedCount > 0) ? 'active' : '',
    },
    {
      num: 'Step 4 · Relay',
      title: 'Other Devices',
      sub: relayedFromMailbox ? 'Picked up from mailbox!' : mailboxHasMsg ? 'Ready for 2nd device' : 'Awaiting drop-off',
      cls: relayedFromMailbox ? 'active' : '',
    },
  ];

  $('pipeline').innerHTML = stages.map((st) => `
    <div class="stage-card ${st.cls}">
      <div class="stage-num">${st.num}</div>
      <div class="stage-title">${st.title}</div>
      <div class="stage-sub">${st.sub}</div>
    </div>`).join('');
}

function renderPacketPills(b) {
  const pkts = b.mock ? b.link.store.map(decodePacket).filter(Boolean) : b.packets;
  const community = b.mock ? (b.link.communityStore ?? []) : b.communityPackets;

  if (!pkts.length && !community.length) {
    return `<div class="pkt-strip"><span class="chip">Holding <b>0</b> messages</span></div>`;
  }

  const hazardPills = pkts.map((p) => {
    const kindName = KIND_NAME[p.kind] || `KIND ${p.kind}`;
    const def = SENSOR_DEFS[kindName];
    const color = def?.color ?? '#ffb020';
    const val = (p.valueX10 / 10).toFixed(1);
    const unit = def?.unit ?? '';
    return `<span class="pkt-pill" style="border-color:${color}"><b style="color:${color}">${esc(kindName)}</b> · ${val} ${esc(unit)} · L${p.level} · hop ${p.hops}</span>`;
  });

  const communityPills = community.map((m) => {
    if (m.type === 'CHECKIN') {
      const who = m.payload?.name || 'Check-in';
      return `<span class="pkt-pill" style="border-color:#86efac"><b style="color:#86efac">💚 ${esc(who)} OK</b> · L${m.level} · hop ${m.hops}</span>`;
    }
    if (m.type === 'REPORT') {
      const cat = m.payload?.category || 'Report';
      return `<span class="pkt-pill" style="border-color:#c084fc"><b style="color:#c084fc">🩺 ${esc(cat)}</b> · L${m.level} · hop ${m.hops}</span>`;
    }
    const cat = m.payload?.category || 'Bulletin';
    return `<span class="pkt-pill" style="border-color:#38bdf8"><b style="color:#38bdf8">🤝 ${esc(cat)}</b> · L${m.level} · hop ${m.hops}</span>`;
  });

  return `<div class="pkt-strip">${[...hazardPills, ...communityPills].join('')}</div>`;
}

function render() {
  renderCompat();
  $('me').innerHTML = `Device <b>${esc(nodeId)}</b>`;
  const carrying = [...node.store.values()].filter((m) => m.ttl > 0).length;
  $('carry').innerHTML = `Carrying <b>${carrying}</b>`;
  $('practiceBtn').style.display = boards.some((b) => b.mock) ? 'none' : '';
  $('switchBtn').style.display = boards.some((b) => b.mock) ? '' : 'none';

  renderPipeline(carrying);

  $('boards').innerHTML = boards.length ? boards.map((b, i) => {
    const state = b.connected ? '<span class="chip ok"><b>connected · in range</b></span>'
      : b.connecting ? '<span class="chip"><b>looking…</b></span>' : '<span class="chip bad"><b>not in range</b></span>';
    const roleLabel = b.role === 'sensor' ? 'Sensor' : 'Mailbox';
    const mockCtl = b.mock ? `
      <div class="mock">
        <label><input type="checkbox" data-act="range" data-i="${i}" ${b.link.inRange ? 'checked' : ''}> In range</label>
        ${b.link.role === 'sensor' ? `
          <button data-act="raise-heat" data-i="${i}">Raise Heat (41.2 °C)</button>
          <button data-act="raise-flood" data-i="${i}">Raise Flood (45 cm)</button>
          <button data-act="clear" data-i="${i}">Clear</button>
        ` : ''}
      </div>` : '';
    return `
      <div class="board ${b.connected ? 'is-connected' : ''}">
        <div class="bhead">
          <div class="btitle"><b>${esc(b.name)}</b><span class="role-tag">${roleLabel}</span></div>
          ${state}
        </div>
        ${renderPacketPills(b)}
        ${mockCtl}
      </div>`;
  }).join('') : '<div class="empty">No boards paired yet. Stand near an ESP32, press <b>Pair a board</b>, and pick its <b>Hollow-</b> name.</div>';

  $('notifs').innerHTML = notifs.length ? notifs.map(({ t, msg }, i) => {
    const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    if (msg.type === 'CHECKIN') {
      const routeText = msg.hops > 0 ? `Relayed (${msg.hops} hop${msg.hops === 1 ? '' : 's'})` : 'Family check-in';
      return `
        <div class="notif${i === 0 ? ' flash' : ''}" style="border-color:#86efac">
          <div class="notif-top">
            <b style="color:#86efac">💚 ${esc(msg.payload.name)} is OK</b>
            <span class="hop-badge">${routeText}</span>
          </div>
          <div>Checked in safe from Level ${msg.level}.</div>
          <div class="notif-meta">
            <span>Level ${msg.level}</span>
            <span>·</span>
            <span>${time}</span>
          </div>
        </div>`;
    }
    if (msg.type === 'REPORT') {
      const routeText = msg.hops > 0 ? `Relayed (${msg.hops} hop${msg.hops === 1 ? '' : 's'})` : 'Symptom / Supply Report';
      return `
        <div class="notif${i === 0 ? ' flash' : ''}" style="border-color:#c084fc">
          <div class="notif-top">
            <b style="color:#c084fc">🩺 ${esc(msg.payload.title)}</b>
            <span class="hop-badge">${routeText}</span>
          </div>
          <div>${esc(msg.payload.note)}</div>
          <div class="notif-meta">
            <span>Level ${msg.level}</span>
            <span>·</span>
            <span>By ${esc(msg.sender)}</span>
            <span>·</span>
            <span>${time}</span>
          </div>
        </div>`;
    }
    if (msg.type === 'BULLETIN') {
      const routeText = msg.hops > 0 ? `Relayed (${msg.hops} hop${msg.hops === 1 ? '' : 's'})` : 'Resource Board';
      return `
        <div class="notif${i === 0 ? ' flash' : ''}" style="border-color:#38bdf8">
          <div class="notif-top">
            <b style="color:#38bdf8">🤝 ${esc(msg.payload.title)}</b>
            <span class="hop-badge">${routeText}</span>
          </div>
          <div>${esc(msg.payload.note)}</div>
          <div class="notif-meta">
            <span>Level ${msg.level}</span>
            <span>·</span>
            <span>Posted by ${esc(msg.sender)}</span>
            <span>·</span>
            <span>${time}</span>
          </div>
        </div>`;
    }
    const color = SENSOR_DEFS[msg.payload.kind]?.color ?? '#ffb020';
    const routeText = msg.hops <= 1 ? 'Direct from sensor' : `Relayed (${msg.hops} hops)`;
    return `
      <div class="notif${i === 0 ? ' flash' : ''}" style="border-color:${color}">
        <div class="notif-top">
          <b style="color:${color}">⚠ ${esc(msg.payload.title)}</b>
          <span class="hop-badge">${routeText}</span>
        </div>
        <div>${esc(msg.payload.advice)}</div>
        <div class="notif-meta">
          <span>Level ${msg.level}</span>
          <span>·</span>
          <span>Reading: <b>${msg.payload.value} ${esc(msg.payload.unit)}</b></span>
          <span>·</span>
          <span>Via ${esc(msg.sender)}</span>
          <span>·</span>
          <span>${time}</span>
        </div>
      </div>`;
  }).join('') : '<div class="empty">No alerts, reports, or bulletins yet. Walk near <b>Hollow-Sensor</b> or submit one above.</div>';

  $('log').innerHTML = events.length ? events.slice(0, 15).map((e) =>
    `<div class="logline ${e.kind}"><span>${e.t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span><div>${esc(e.text)}</div></div>`
  ).join('') : '<div class="logline"><span>--:--:--</span><div>Waiting for Bluetooth activity…</div></div>';
}

document.addEventListener('click', (e) => {
  const act = e.target.dataset?.act;
  if (!act) return;
  const b = boards[Number(e.target.dataset.i)];
  if (!b?.mock) return;
  if (act === 'raise-heat') { b.link.raiseAlert('HEAT', 12, 41.2); log('Practice sensor alarmed: Heat 41.2 °C', 'pickup'); }
  if (act === 'raise-flood') { b.link.raiseAlert('FLOOD', 7, 45.0); log('Practice sensor alarmed: Flood 45.0 cm', 'pickup'); }
  if (act === 'clear') { b.link.clearAlerts(); b.packets = []; render(); }
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
$('resetViewBtn').onclick = resetView;
$('checkinBtn').onclick = sendCheckin;
$('reportBtn').onclick = sendReport;
$('bulletinBtn').onclick = sendBulletin;

if (params.get('mock') === '1') startPractice();
connectBoardTelemetry();
render();

window.ble = { boards, get node() { return node; }, get notifs() { return notifs; } };