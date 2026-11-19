// fake-esp32.js — pretends to be the ESP32 + sensor until the real board arrives.
//
// It prints ONE LINE PER READING to stdout, in exactly the format the real
// firmware will print over USB serial:
//
//     HEAT,24.3
//     <KIND>,<number>
//
// KIND is one of the keys in SENSOR_DEFS (sim.js): POWER, AIR, WATER, FLOOD, HEAT.
// Thresholds live in sim.js, so the board only has to report raw readings.
//
// Run it into the bridge:   node backend/fake-esp32.js | node backend/bridge.js
// (or just: npm run fake)
//
// Keys while it runs:  f = start the fault   r = go back to normal   q = quit

import { parseArgs } from 'node:util';
import readline from 'node:readline';
import { SENSOR_DEFS } from '../shared/sim.js';

const { values: opt } = parseArgs({
  options: {
    kind: { type: 'string', default: 'HEAT' },
    interval: { type: 'string', default: '1000' },        // ms between readings
    rate: { type: 'string', default: '0.15' },            // how fast the reading moves (per second)
    'fault-after': { type: 'string' },                    // auto-start the fault after N seconds
    'fault-for': { type: 'string' },                      // auto-end the fault after N more seconds
    help: { type: 'boolean', default: false },
  },
});

const kind = opt.kind.toUpperCase();
const def = SENSOR_DEFS[kind];
if (opt.help || !def) {
  console.error(`Usage: node fake-esp32.js [--kind ${Object.keys(SENSOR_DEFS).join('|')}] [--interval 1000] [--rate 0.15]`);
  console.error('                          [--fault-after SECONDS] [--fault-for SECONDS]');
  process.exit(opt.help ? 0 : 1);
}

const intervalMs = Number(opt.interval);
const rate = Number(opt.rate);
let value = def.baseline;
let fault = false;

const say = (s) => process.stderr.write(s + '\n'); // stderr, so it doesn't mix into the data pipe
function setFault(on) {
  if (fault === on) return;
  fault = on;
  say(on ? `>>> FAULT ON: ${def.label} will climb toward ${def.fault} ${def.unit} (alert threshold ${def.threshold})`
         : '>>> back to normal');
}

setInterval(() => {
  const dt = intervalMs / 1000;
  const target = fault ? def.fault : def.baseline;
  const noise = (Math.random() - 0.5) * Math.abs(def.fault - def.baseline) * 0.01;
  value += (target - value) * (1 - Math.exp(-rate * dt)) + noise;
  const out = value.toFixed(1);
  process.stdout.write(`${kind},${out}\n`);
  say(`fake ESP32 sent ${kind},${out} ${def.unit}${fault ? '   [fault on]' : ''}`);
}, intervalMs);

if (opt['fault-after'] !== undefined) {
  setTimeout(() => {
    setFault(true);
    if (opt['fault-for'] !== undefined) setTimeout(() => setFault(false), Number(opt['fault-for']) * 1000);
  }, Number(opt['fault-after']) * 1000);
}

if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'f') setFault(true);
    else if (key.name === 'r') setFault(false);
    else if (key.name === 'q' || (key.ctrl && key.name === 'c')) process.exit(0);
  });
  say(`Fake ${kind} sensor running.  f = fault   r = reset   q = quit\n`);
} else {
  say(`Fake ${kind} sensor running (no keyboard; use --fault-after SECONDS to trigger it).\n`);
}
