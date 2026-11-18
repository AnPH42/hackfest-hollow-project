// sim.js — the simulated Hollow. No DOM code in here, so it also runs in Node
// (see calibrate checks) and can be reused by the phone-relay demo later.
//
// The world is a side view: horizontal tunnels (levels) stacked vertically,
// joined by a few vertical shafts. Phones wander along levels; "commuters"
// also ride shafts between levels, which is how messages cross gaps
// (store-and-forward). Sensors are fixed nodes that publish alerts.

import { MeshNode, stepEncounters } from './mesh.js';

export const WORLD = { width: 1000, height: 640 };

export const LEVELS = [
  { id: 4,  y: 150, name: 'Level 4',  note: 'upper'  },
  { id: 7,  y: 270, name: 'Level 7',  note: ''       },
  { id: 9,  y: 390, name: 'Level 9',  note: ''       },
  { id: 12, y: 510, name: 'Level 12', note: 'deep'   },
];

// from/to are level INDEXES (into LEVELS) that the shaft connects.
// Level 12 is only reachable through Shaft C, so it is nearly cut off.
export const SHAFTS = [
  { name: 'Shaft A', x: 180, from: 0, to: 2 },
  { name: 'Shaft B', x: 620, from: 0, to: 1 },
  { name: 'Shaft C', x: 820, from: 2, to: 3 },
];

export const SENSOR_DEFS = {
  POWER: {
    button: 'Blackout — Level 12',
    short: 'Grid', glyph: 'P', level: 3, x: 860,
    label: 'Grid voltage', unit: '%', location: 'Geothermal feed, Level 12',
    baseline: 98, fault: 15, threshold: 60, dir: 'below', color: '#ffb020',
    title: 'Blackout imminent — Level 12',
    advice: 'Grid voltage is collapsing. Expect power loss within minutes. Charge devices, store water, move to a lit common area.',
    official: 'Power supply to all levels is stable. No outages are planned.',
  },
  AIR: {
    button: 'CO₂ leak — Level 12',
    short: 'CO₂', glyph: 'C', level: 3, x: 330,
    label: 'CO₂', unit: 'ppm', location: 'West tunnel, Level 12',
    baseline: 800, fault: 5200, threshold: 2500, dir: 'above', color: '#c084fc',
    title: 'CO₂ rising — Level 12',
    advice: 'Air is turning unsafe in the low tunnels. Move to a ventilated area or go up to Level 9.',
    official: 'Air quality is within safe limits on all levels.',
  },
  WATER: {
    button: 'Bad water — Recycler 3',
    short: 'Recycler 3', glyph: 'W', level: 2, x: 470,
    label: 'Water TDS', unit: 'ppm', location: 'Recycler 3, Level 9',
    baseline: 180, fault: 1100, threshold: 500, dir: 'above', color: '#38bdf8',
    title: 'Water contaminated — Recycler 3',
    advice: 'Do not drink from taps fed by Recycler 3 (Level 9). Use stored water and tell your neighbors.',
    official: 'Water supply is safe. Recycler 3 is operating normally.',
  },
  FLOOD: {
    button: 'Flooded tunnel — Level 7',
    short: 'W. tunnel', glyph: 'F', level: 1, x: 240,
    label: 'Tunnel water', unit: 'cm', location: 'West tunnel, Level 7',
    baseline: 1, fault: 45, threshold: 15, dir: 'above', color: '#34d399',
    title: 'Tunnel flooding — Level 7 west',
    advice: 'The west tunnel on Level 7 is filling with sewage water. Section is impassable. Reroute east.',
    official: 'Tunnel conditions are normal. No closures are in effect.',
  },
  // The first real hardware sensor will most likely be a DHT22 temperature sensor.
  HEAT: {
    button: 'Heat spike — Level 12',
    short: 'Heat', glyph: 'H', level: 3, x: 600,
    label: 'Temperature', unit: '°C', location: 'Cooling fan bank, Level 12',
    baseline: 24, fault: 48, threshold: 38, dir: 'above', color: '#fb7185',
    title: 'Dangerous heat — Level 12',
    advice: 'Temperatures are above safe limits. Drink water, avoid exertion, and move up a level if you can.',
    official: 'Cooling systems are operating within normal parameters.',
  },
};

const NAMES = ['Maya', 'Idris', 'Lena', 'Tomas', 'Anya', 'Kofi', 'Rae', 'Sami',
  'Noor', 'Jun', 'Ines', 'Dax', 'Wren', 'Omar', 'Pia', 'Luca'];

const HOP_INTERVAL = 0.5;   // simulated seconds between mesh hops
const SHAFT_SPEED = 55;     // px / simulated second
const ALERT_TTL = 24;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class World {
  constructor({
    seed = 1, phonesPerLevel = 10, phoneRange = 70, relayRange = 460,
    commuterShare = 0.3, onTransfers = null,
  } = {}) {
    this.rng = mulberry32(seed);
    this.phonesPerLevel = phonesPerLevel;
    this.phoneRange = phoneRange;
    this.relayRange = relayRange;
    this.commuterShare = commuterShare;
    this.onTransfers = onTransfers;

    this.t = 0;                 // simulated seconds
    this.hopAcc = 0;
    this.meshEnabled = true;
    this.officialOnline = true; // the Directorate's network

    this.phones = [];
    this.sensors = {};
    this.relays = [];
    this.tracked = [];          // messages we report progress on
    this.log = [];
    this.officialNotices = [];
    this.triggered = {};

    this._clock = () => this.t * 1000;
    this._build();
  }

  // ---- construction -------------------------------------------------------

  _build() {
    let n = 0;
    for (let lv = 0; lv < LEVELS.length; lv++) {
      for (let k = 0; k < this.phonesPerLevel; k++) this.phones.push(this._makePhone(n++, lv));
    }
    for (const [kind, def] of Object.entries(SENSOR_DEFS)) {
      const mesh = new MeshNode(`sensor-${kind}`, { clock: this._clock, maxStore: 50 });
      const s = {
        kind: 'sensor', sensorKind: kind, def, id: mesh.id, mesh,
        x: def.x, y: LEVELS[def.level].y,
        value: def.baseline, history: [def.baseline], histAcc: 0,
        fault: false, alarm: false, alerted: false,
      };
      mesh.agent = s;
      this.sensors[kind] = s;
    }
    this._rebuildNodeList();
    // The user's own phone starts on an upper level.
    this.selectedId = this.phones.find((p) => p.levelIdx === 0).id;
  }

  _makePhone(i, levelIdx) {
    const id = `R-${1000 + i}`;
    const mesh = new MeshNode(id, {
      clock: this._clock, maxStore: 100,
      onDeliver: (msg) => this._onDeliver(phone, msg),
    });
    const lane = (this.rng() - 0.5) * 32;
    const commuter = this.rng() < this.commuterShare;
    const phone = {
      kind: 'phone', id, name: NAMES[i % NAMES.length], mesh,
      levelIdx, x: 40 + this.rng() * (WORLD.width - 80), lane,
      y: LEVELS[levelIdx].y + lane,
      dir: this.rng() < 0.5 ? -1 : 1, speed: 18 + this.rng() * 14,
      state: 'walk', pause: 0, commuter,
      commuteIn: 10 + this.rng() * 35, trip: null,
      alertKind: null, notifs: [],
    };
    mesh.agent = phone;
    return phone;
  }

  setRelays(on) {
    this.relays = [];
    if (on) {
      for (const sh of SHAFTS) {
        for (let lv = sh.from; lv <= sh.to; lv++) {
          const mesh = new MeshNode(`relay-${sh.name.slice(-1)}${LEVELS[lv].id}`, { clock: this._clock, maxStore: 100 });
          const r = { kind: 'relay', id: mesh.id, mesh, x: sh.x, y: LEVELS[lv].y };
          mesh.agent = r;
          this.relays.push(r);
        }
      }
    }
    this._rebuildNodeList();
  }

  _rebuildNodeList() {
    this.agents = [...this.phones, ...Object.values(this.sensors), ...this.relays];
    this.nodes = this.agents.map((a) => a.mesh);
    this.byId = new Map(this.agents.map((a) => [a.id, a]));
  }

  get selected() { return this.byId.get(this.selectedId); }

  // ---- radio model --------------------------------------------------------

  /** Phones, sensors and relay<->phone links use phone range; relay<->relay
   *  links use the long-range (LoRa) radio. */
  inRange(a, b) {
    const r = a.kind === 'relay' && b.kind === 'relay' ? this.relayRange : this.phoneRange;
    const dx = a.x - b.x, dy = a.y - b.y;
    return dx * dx + dy * dy <= r * r;
  }

  peersOf(agent) {
    let n = 0;
    for (const o of this.agents) if (o !== agent && this.inRange(agent, o)) n++;
    return n;
  }

  // ---- simulation step ----------------------------------------------------

  step(dt) {
    this.t += dt;
    for (const p of this.phones) this._movePhone(p, dt);
    for (const s of Object.values(this.sensors)) this._updateSensor(s, dt);

    this.hopAcc += dt;
    while (this.hopAcc >= HOP_INTERVAL) {
      this.hopAcc -= HOP_INTERVAL;
      this._hop();
    }
  }

  _hop() {
    let transfers = [];
    if (this.meshEnabled) {
      transfers = stepEncounters(this.nodes, (a, b) => this.inRange(a.agent, b.agent));
    }
    if (transfers.length && this.onTransfers) this.onTransfers(transfers);
    this._updateTracking();
  }

  _movePhone(p, dt) {
    switch (p.state) {
      case 'pause':
        p.pause -= dt;
        if (p.pause <= 0) p.state = 'walk';
        break;

      case 'walk': {
        p.x += p.dir * p.speed * dt;
        if (p.x < 30) { p.x = 30; p.dir = 1; }
        else if (p.x > WORLD.width - 30) { p.x = WORLD.width - 30; p.dir = -1; }
        if (this.rng() < 0.06 * dt) { p.state = 'pause'; p.pause = 3 + this.rng() * 5; }
        else if (this.rng() < 0.03 * dt) p.dir *= -1;
        if (p.commuter) {
          p.commuteIn -= dt;
          if (p.commuteIn <= 0) this._startTrip(p);
        }
        break;
      }

      case 'toShaft': {
        const dx = p.trip.shaft.x - p.x;
        const step = p.speed * 1.4 * dt;
        if (Math.abs(dx) <= step) { p.x = p.trip.shaft.x; p.state = 'inShaft'; }
        else p.x += Math.sign(dx) * step;
        break;
      }

      case 'inShaft': {
        const targetY = LEVELS[p.trip.target].y + p.lane;
        const dy = targetY - p.y;
        const step = SHAFT_SPEED * dt;
        if (Math.abs(dy) <= step) {
          p.y = targetY; p.levelIdx = p.trip.target; p.trip = null;
          p.state = 'walk'; p.dir = this.rng() < 0.5 ? -1 : 1;
          p.commuteIn = 20 + this.rng() * 30;
        } else p.y += Math.sign(dy) * step;
        break;
      }
    }
  }

  _startTrip(p) {
    const options = SHAFTS.filter((s) => p.levelIdx >= s.from && p.levelIdx <= s.to);
    if (!options.length) { p.commuteIn = 20; return; }
    const shaft = options[Math.floor(this.rng() * options.length)];
    const targets = [];
    for (let l = shaft.from; l <= shaft.to; l++) if (l !== p.levelIdx) targets.push(l);
    p.trip = { shaft, target: targets[Math.floor(this.rng() * targets.length)] };
    p.state = 'toShaft';
  }

  _updateSensor(s, dt) {
    const d = s.def;
    const target = s.fault ? d.fault : d.baseline;
    const noise = (this.rng() - 0.5) * Math.abs(d.baseline - d.fault) * 0.012;
    s.value += (target - s.value) * (1 - Math.exp(-0.08 * dt)) + noise;

    s.histAcc += dt;
    if (s.histAcc >= 0.5) {
      s.histAcc = 0;
      s.history.push(s.value);
      if (s.history.length > 100) s.history.shift();
    }

    s.alarm = d.dir === 'above' ? s.value > d.threshold : s.value < d.threshold;
    if (s.alarm && !s.alerted) { s.alerted = true; this._originateAlert(s); }
    if (!s.alarm && s.alerted && !s.fault) s.alerted = false;
  }

  _originateAlert(s) {
    const d = s.def;
    const msg = s.mesh.originate({
      type: 'ALERT', level: LEVELS[d.level].id, location: d.location, ttl: ALERT_TTL,
      payload: { kind: s.sensorKind, value: Math.round(s.value), unit: d.unit, title: d.title, advice: d.advice },
    });
    this.tracked.push({
      id: msg.id, kind: 'ALERT', title: d.title, color: d.color, originAt: this.t,
      to: null, t50: null, t90: null, firstByLevel: {}, delivered: null,
    });
    this._log(`Sensor alert: ${d.title}`, d.color);
  }

  // ---- scenarios ----------------------------------------------------------

  trigger(kind) {
    const s = this.sensors[kind];
    if (!s) return;
    s.fault = true;
    if (!this.triggered[kind]) {
      this.triggered[kind] = true;
      this._log(`Scenario started: ${s.def.button}`, '#8a93a8');
      if (this.officialOnline) {
        this.officialNotices.push({ t: this.t, title: 'Directorate Notice', text: s.def.official });
      }
    }
  }

  /** Check-in from the farthest-away level to the selected ("your") phone. */
  sendCheckin() {
    const me = this.selected;
    if (!me) return;
    const dist = (p) => Math.abs(p.levelIdx - me.levelIdx);
    const maxD = Math.max(...this.phones.map(dist));
    const pool = this.phones.filter((p) => p !== me && dist(p) === maxD);
    const sender = pool[Math.floor(this.rng() * pool.length)];
    const msg = sender.mesh.originate({
      type: 'CHECKIN', to: me.id, level: LEVELS[sender.levelIdx].id, ttl: 30,
      payload: { name: sender.name, status: 'OK' },
    });
    const title = `${sender.name} (Level ${LEVELS[sender.levelIdx].id}) → you`;
    this.tracked.push({
      id: msg.id, kind: 'CHECKIN', title, color: '#86efac', originAt: this.t,
      to: me.id, delivered: null, t50: null, t90: null, firstByLevel: {},
    });
    this._log(`Check-in sent: ${title}`, '#86efac');
  }

  // ---- bookkeeping --------------------------------------------------------

  _onDeliver(phone, msg) {
    if (msg.type === 'ALERT') phone.alertKind = msg.payload.kind;
    phone.notifs.push({ t: this.t, msg });
    const tr = this.tracked.find((x) => x.id === msg.id);
    if (!tr) return;
    const elapsed = this.t - tr.originAt;
    if (tr.to) {
      tr.delivered = { at: elapsed, hops: msg.hops };
      this._log(`Check-in delivered after ${Math.round(elapsed)} s (${msg.hops} hops)`, tr.color);
    } else {
      const lv = LEVELS[phone.levelIdx].id;
      if (tr.firstByLevel[lv] === undefined) {
        tr.firstByLevel[lv] = elapsed;
        this._log(`"${tr.title}" reached Level ${lv} after ${Math.round(elapsed)} s`, tr.color);
      }
    }
  }

  /** How far a broadcast message has spread, overall and per level. */
  reach(tr) {
    const byLevel = LEVELS.map(() => ({ total: 0, reached: 0 }));
    let total = 0, reached = 0;
    for (const p of this.phones) {
      total++; byLevel[p.levelIdx].total++;
      if (p.mesh.seen.has(tr.id)) { reached++; byLevel[p.levelIdx].reached++; }
    }
    return { total, reached, byLevel };
  }

  _updateTracking() {
    for (const tr of this.tracked) {
      if (tr.to) continue;
      const r = this.reach(tr);
      const el = this.t - tr.originAt;
      if (tr.t50 === null && r.reached >= 0.5 * r.total) tr.t50 = el;
      if (tr.t90 === null && r.reached >= 0.9 * r.total) tr.t90 = el;
    }
  }

  _log(text, color = '#8a93a8') {
    this.log.push({ t: this.t, text, color });
    if (this.log.length > 60) this.log.shift();
  }
}
