// bridge.js — turns sensor readings into mesh alerts.
//
//   readings (lines on stdin)  ->  bridge  ->  an ALERT sent into the live mesh
//
// stdin lines look like  HEAT,24.3  and come from fake-esp32.js today and from
// the real ESP32 later (see the notes at the bottom for the real thing).
//
// The bridge joins the relay server (server.js) as an ordinary peer, so it shows
// up on the board as a node on its level, runs the real MeshNode from mesh.js,
// and also relays other phones' messages like any other node.
//
//   node backend/fake-esp32.js | node backend/bridge.js
//   node backend/bridge.js --server http://192.168.1.20:3000 --zone 3

import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { MeshNode } from '../shared/mesh.js';
import { SENSOR_DEFS, LEVELS } from '../shared/sim.js';

const { values: opt } = parseArgs({
  options: {
    server: { type: 'string', default: 'http://localhost:3000' },
    zone: { type: 'string' },   // level index 0-3 (default: the level the sensor belongs to)
    id: { type: 'string' },     // default ESP32-<KIND>
  },
});

const TRIP = 3;    // consecutive over-threshold readings before we raise the alert
const REARM = 5;   // consecutive normal readings before we are ready to alert again

const log = (s) => console.log(`[bridge ${new Date().toLocaleTimeString()}] ${s}`);

let node = null;
let id = null;
let zone = null;
let neighbors = new Set();
const sentTo = new Map();
const state = {};     // kind -> { bad, good, alerted }

// ---------------------------------------------------------------- readings

function onReading(kind, value) {
  const def = SENSOR_DEFS[kind];
  if (!def) { log(`ignoring unknown sensor kind "${kind}"`); return; }
  if (!node) start(kind, def);

  const s = (state[kind] ??= { bad: 0, good: 0, alerted: false, n: 0 });
  const alarm = def.dir === 'above' ? value > def.threshold : value < def.threshold;
  s.n++;
  if (alarm) { s.bad++; s.good = 0; } else { s.good++; s.bad = 0; }

  if (alarm && !s.alerted && s.bad >= TRIP) {
    s.alerted = true;
    node.originate({
      type: 'ALERT', level: LEVELS[def.level].id, location: def.location, ttl: 24,
      payload: { kind, title: def.title, advice: def.advice, value: Math.round(value * 10) / 10, unit: def.unit },
    });
    log(`ALERT raised: ${def.title} (${value} ${def.unit} > ${def.threshold})  → handing to ${neighbors.size} neighbor(s)`);
    pump();
  } else if (!alarm && s.alerted && s.good >= REARM) {
    s.alerted = false;
    log(`${kind} back to normal; ready to alert again`);
  } else if (s.n % 10 === 1) {
    log(`${kind} ${value} ${def.unit}  ${alarm ? 'over threshold' : 'normal'}  | neighbors ${neighbors.size}`);
  }
}

// --------------------------------------------------------------- mesh peer

function start(kind, def) {
  id = opt.id ?? `ESP32-${kind}`;
  zone = opt.zone !== undefined ? Number(opt.zone) : def.level;
  node = new MeshNode(id, {});
  log(`joining ${opt.server} as ${id} on Level ${LEVELS[zone].id}`);
  connect();
  setInterval(pump, 2000);
}

async function connect() {
  for (;;) {
    try {
      const res = await fetch(`${opt.server}/events?id=${encodeURIComponent(id)}&zone=${zone}`);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) { handleEvent(buf.slice(0, i)); buf = buf.slice(i + 2); }
      }
    } catch (e) {
      log(`relay not reachable (${e.cause?.code ?? e.message}); retrying…`);
    }
    neighbors = new Set();
    await new Promise((r) => setTimeout(r, 1000));
  }
}

function handleEvent(block) {
  let event = 'message', data = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) data += line.slice(5).trim();
  }
  if (!data) return;
  const d = JSON.parse(data);
  if (event === 'hello') log(`connected to the relay`);
  if (event === 'neighbors') {
    neighbors = new Set(d.ids);
    for (const k of [...sentTo.keys()]) if (!neighbors.has(k)) sentTo.delete(k);
    pump();
  }
  if (event === 'msg') {
    let s = sentTo.get(d.from);
    if (!s) { s = new Set(); sentTo.set(d.from, s); }
    s.add(d.msg.id);
    if (node.receive(d.msg)) pump();
  }
}

function pump() {
  if (!node) return;
  for (const m of node.store.values()) {
    if (m.ttl <= 0) continue;
    const targets = [];
    for (const nid of neighbors) {
      let s = sentTo.get(nid);
      if (!s) { s = new Set(); sentTo.set(nid, s); }
      if (!s.has(m.id)) { s.add(m.id); targets.push(nid); }
    }
    if (!targets.length) continue;
    const copy = { ...m, ttl: m.ttl - 1, hops: m.hops + 1 };
    fetch(`${opt.server}/relay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: id, to: targets, msg: copy }),
    }).catch(() => { for (const t of targets) sentTo.get(t)?.delete(m.id); });
  }
}

// ------------------------------------------------------------------- input

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const m = /^\s*([A-Za-z]+)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(line);
  if (!m) { if (line.trim()) log(`ignoring line: ${line.trim()}`); return; }
  onReading(m[1].toUpperCase(), Number(m[2]));
});
rl.on('close', () => log('input ended; still relaying (Ctrl-C to quit)'));

log(`waiting for sensor lines on stdin (e.g. "HEAT,24.3")…`);

// -------------------------------------------------------------------------
// WHEN THE REAL ESP32 ARRIVES
// The firmware only has to print one line per reading over USB serial, e.g.:
//     Serial.print("HEAT,"); Serial.println(temperature);
// To feed this bridge from a real serial port, pipe it in with any serial tool:
//   macOS/Linux:  stty -f /dev/cu.usbserial-XXXX 115200 && cat /dev/cu.usbserial-XXXX | node bridge.js
//   Windows:      use the Arduino IDE's port name with a tool like `plink -serial COM3 -sercfg 115200`
// (or ask me for a version that reads the port directly).
