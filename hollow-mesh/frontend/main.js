// main.js — draws the simulated Hollow and wires up the controls.
// All the world logic lives in sim.js; routing lives in mesh.js.

import { World, LEVELS, SHAFTS, SENSOR_DEFS, WORLD } from '../shared/sim.js';

const $ = (id) => document.getElementById(id);
const canvas = $('map');
const ctx = canvas.getContext('2d');
const DT = 0.1; // simulation step, in simulated seconds

const settings = {
  speed: 4, phonesPerLevel: 10, phoneRange: 70,
  mesh: true, relays: false, links: true, paused: false,
};

let world = null;
let flashes = [];   // brief lines when a message is handed over
let pulses = [];    // rings where a message just arrived
let demo = null;    // scripted demo state
let panelKey = '';
let lastPanel = 0;

const ALERT_FALLBACK = '#ffb020';
const CHECKIN_COLOR = '#86efac';

const colorOf = (msg) =>
  msg.type === 'ALERT' ? (SENSOR_DEFS[msg.payload.kind]?.color ?? ALERT_FALLBACK) : CHECKIN_COLOR;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const mmss = (t) => `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(Math.floor(t % 60)).padStart(2, '0')}`;

// ---------------------------------------------------------------- world setup

function build() {
  world = new World({
    seed: (Math.random() * 2 ** 31) | 0,
    phonesPerLevel: settings.phonesPerLevel,
    phoneRange: settings.phoneRange,
    onTransfers: addFlashes,
  });
  world.meshEnabled = settings.mesh;
  world.officialOnline = !$('officialToggle').checked;
  world.setRelays(settings.relays);
  flashes = []; pulses = []; panelKey = '';
  renderScenarioButtons();
}

function addFlashes(list) {
  const now = performance.now();
  for (const tr of list.slice(0, 80)) {
    const a = world.byId.get(tr.from), b = world.byId.get(tr.to);
    if (!a || !b) continue;
    const color = colorOf(tr.msg);
    flashes.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, color, born: now });
    pulses.push({ x: b.x, y: b.y, color, born: now });
  }
  if (flashes.length > 400) flashes = flashes.slice(-400);
  if (pulses.length > 400) pulses = pulses.slice(-400);
}

// -------------------------------------------------------------------- drawing

function fitCanvas() {
  const w = canvas.parentElement.clientWidth;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(w * (WORLD.height / WORLD.width) * dpr);
}

const lerp = (a, b, t) => a + (b - a) * t;
function levelColor(i) {
  const t = i / (LEVELS.length - 1);
  return `rgb(${Math.round(lerp(26, 78, t))},${Math.round(lerp(52, 30, t))},${Math.round(lerp(70, 22, t))})`;
}

function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function draw(now) {
  const s = canvas.width / WORLD.width;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.clearRect(0, 0, WORLD.width, WORLD.height);

  // background
  ctx.fillStyle = '#06080c';
  ctx.fillRect(0, 0, WORLD.width, WORLD.height);

  // surface
  ctx.fillStyle = '#10100f';
  ctx.fillRect(0, 0, WORLD.width, 62);
  ctx.fillStyle = '#2a2623';
  ctx.fillRect(0, 62, WORLD.width, 3);
  ctx.fillStyle = '#6f6a63';
  ctx.font = '600 11px system-ui, sans-serif';
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('THE SURFACE  ·  sealed', 24, 38);

  // level bands
  LEVELS.forEach((lv, i) => {
    ctx.fillStyle = levelColor(i);
    roundRect(20, lv.y - 32, WORLD.width - 40, 64, 14);
    ctx.fill();
  });

  // shafts (only the vertical parts between bands)
  for (const sh of SHAFTS) {
    for (let i = sh.from; i < sh.to; i++) {
      const y0 = LEVELS[i].y + 30, y1 = LEVELS[i + 1].y - 30;
      ctx.fillStyle = '#141a26';
      ctx.fillRect(sh.x - 13, y0, 26, y1 - y0);
      ctx.strokeStyle = '#3a4357';
      ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
      ctx.strokeRect(sh.x - 13, y0, 26, y1 - y0);
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#7e889d';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(sh.name.toUpperCase(), sh.x, LEVELS[sh.from].y - 38);
  }

  // blackout overlay on Level 12 while the grid alarm is active
  if (world.sensors.POWER.alarm) {
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(20, LEVELS[3].y - 32, WORLD.width - 40, 64, 14);
    ctx.fill();
  }

  // level labels
  ctx.textAlign = 'left';
  LEVELS.forEach((lv) => {
    ctx.fillStyle = '#9aa4b8';
    ctx.font = '700 11px system-ui, sans-serif';
    ctx.fillText(lv.name.toUpperCase() + (lv.note ? `  ·  ${lv.note}` : ''), 30, lv.y - 38);
  });

  // radio links
  if (settings.links && settings.mesh) {
    ctx.lineWidth = 1;
    const ag = world.agents;
    for (let i = 0; i < ag.length; i++) {
      for (let j = i + 1; j < ag.length; j++) {
        if (!world.inRange(ag[i], ag[j])) continue;
        const lora = ag[i].kind === 'relay' && ag[j].kind === 'relay';
        ctx.strokeStyle = lora ? 'rgba(251,191,36,0.35)' : 'rgba(170,190,215,0.13)';
        ctx.setLineDash(lora ? [6, 5] : []);
        ctx.beginPath(); ctx.moveTo(ag[i].x, ag[i].y); ctx.lineTo(ag[j].x, ag[j].y); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
  }

  // range ring around the selected phone
  const me = world.selected;
  if (me) {
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.setLineDash([3, 4]);
    ctx.beginPath(); ctx.arc(me.x, me.y, world.phoneRange, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([]);
  }

  // message hand-offs
  flashes = flashes.filter((f) => now - f.born < 450);
  for (const f of flashes) {
    ctx.globalAlpha = 1 - (now - f.born) / 450;
    ctx.strokeStyle = f.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(f.ax, f.ay); ctx.lineTo(f.bx, f.by); ctx.stroke();
  }
  pulses = pulses.filter((p) => now - p.born < 700);
  for (const p of pulses) {
    const k = (now - p.born) / 700;
    ctx.globalAlpha = 0.8 * (1 - k);
    ctx.strokeStyle = p.color; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 + k * 16, 0, Math.PI * 2); ctx.stroke();
  }
  ctx.globalAlpha = 1; ctx.lineWidth = 1;

  // relay boxes
  for (const r of world.relays) {
    ctx.fillStyle = '#fbbf24';
    ctx.save(); ctx.translate(r.x, r.y); ctx.rotate(Math.PI / 4);
    ctx.fillRect(-6, -6, 12, 12);
    ctx.restore();
  }

  // sensors
  for (const sn of Object.values(world.sensors)) {
    const d = sn.def;
    const alarm = sn.alarm;
    if (alarm) {
      const k = (now % 1000) / 1000;
      ctx.globalAlpha = 0.6 * (1 - k);
      ctx.strokeStyle = d.color; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(sn.x, sn.y, 12 + k * 20, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = alarm ? d.color : '#2dd4bf';
    roundRect(sn.x - 10, sn.y - 10, 20, 20, 4); ctx.fill();
    ctx.fillStyle = '#06201d';
    ctx.font = '800 11px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(d.glyph, sn.x, sn.y + 0.5);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = alarm ? d.color : '#9fb3b0';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.fillText(d.short, sn.x, sn.y + 25);
  }

  // phones
  for (const p of world.phones) {
    const got = p.alertKind ? SENSOR_DEFS[p.alertKind].color : null;
    ctx.fillStyle = got ?? '#9aa4b8';
    ctx.beginPath(); ctx.arc(p.x, p.y, got ? 5.5 : 4.5, 0, Math.PI * 2); ctx.fill();
  }

  // your phone
  if (me) {
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(me.x, me.y, 9, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('YOU', me.x, me.y - 14);
  }
}

// ----------------------------------------------------------------------- panels

function renderScenarioButtons() {
  const box = $('scenarios');
  box.innerHTML = '';
  for (const [kind, def] of Object.entries(SENSOR_DEFS)) {
    const b = document.createElement('button');
    b.dataset.kind = kind;
    b.innerHTML = `<span style="color:${def.color}">●</span> ${esc(def.button)}`;
    b.onclick = () => { world.trigger(kind); updateScenarioButtons(); };
    box.appendChild(b);
  }
  const c = document.createElement('button');
  c.innerHTML = `<span style="color:${CHECKIN_COLOR}">●</span> Family check-in → your phone`;
  c.onclick = () => world.sendCheckin();
  box.appendChild(c);
  updateScenarioButtons();
}

function updateScenarioButtons() {
  for (const b of $('scenarios').querySelectorAll('button[data-kind]')) {
    b.classList.toggle('active', !!world.triggered[b.dataset.kind]);
  }
}

// sensor sparklines (built once)
const sparkCanvases = {};
function buildSensorPanel() {
  const box = $('sensors');
  for (const [kind, def] of Object.entries(SENSOR_DEFS)) {
    const row = document.createElement('div');
    row.className = 'sensor';
    row.innerHTML = `<div><div class="name">${esc(def.label)} <span style="color:var(--muted)">· ${esc(def.short)}</span></div><div class="val" id="val-${kind}"></div></div>`;
    const c = document.createElement('canvas');
    c.width = 240; c.height = 68;
    row.appendChild(c);
    box.appendChild(row);
    sparkCanvases[kind] = c;
  }
}

function drawSpark(kind) {
  const sn = world.sensors[kind], d = sn.def, c = sparkCanvases[kind];
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.clearRect(0, 0, W, H);
  const lo = Math.min(d.baseline, d.fault), hi = Math.max(d.baseline, d.fault);
  const y = (v) => H - 4 - ((v - lo) / (hi - lo)) * (H - 8);
  g.strokeStyle = 'rgba(255,255,255,0.28)'; g.setLineDash([4, 4]); g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, y(d.threshold)); g.lineTo(W, y(d.threshold)); g.stroke();
  g.setLineDash([]);
  g.strokeStyle = sn.alarm ? d.color : '#2dd4bf'; g.lineWidth = 2;
  g.beginPath();
  sn.history.forEach((v, i) => {
    const x = (i / 99) * W;
    if (i === 0) g.moveTo(x, y(v)); else g.lineTo(x, y(v));
  });
  g.stroke();
  const val = $(`val-${kind}`);
  const txt = `${Math.round(sn.value)} ${d.unit}${sn.alarm ? '  · ALARM' : ''}`;
  if (val.textContent !== txt) { val.textContent = txt; val.style.color = sn.alarm ? d.color : ''; }
}

function renderPhoneCard() {
  const me = world.selected;
  if (!me) return;
  const peers = world.peersOf(me);
  $('stNet').innerHTML = world.officialOnline
    ? '<span class="ok">● Directorate network</span>' : '<span class="bad">● No service</span>';
  $('stMesh').textContent = settings.mesh ? `Mesh · ${peers} in range` : 'Mesh off';
  $('whoami').textContent = `${me.name} · ${me.id} · Level ${LEVELS[me.levelIdx].id}`;

  // merge mesh notifications with the Directorate's official notices
  const items = [
    ...me.notifs.map((n) => ({ t: n.t, msg: n.msg })),
    ...world.officialNotices.map((o) => ({ t: o.t, official: o })),
  ].sort((a, b) => b.t - a.t);

  const html = items.map((it) => {
    if (it.official) {
      return `<div class="notif" style="border-color:#6b7280"><b>${esc(it.official.title)}</b>${esc(it.official.text)}<small>Official network · T+${mmss(it.t)}</small></div>`;
    }
    const m = it.msg;
    const color = colorOf(m);
    if (m.type === 'ALERT') {
      return `<div class="notif" style="border-color:${color}"><b style="color:${color}">⚠ ${esc(m.payload.title)}</b>${esc(m.payload.advice)}<small>Via mesh · ${m.hops} hop${m.hops === 1 ? '' : 's'} · reading ${m.payload.value} ${esc(m.payload.unit)} · T+${mmss(it.t)}</small></div>`;
    }
    return `<div class="notif" style="border-color:${color}"><b>${esc(m.payload.name)} is OK</b>Checked in from Level ${m.level}.<small>Via mesh · ${m.hops} hop${m.hops === 1 ? '' : 's'} · T+${mmss(it.t)}</small></div>`;
  }).join('');
  $('notifs').innerHTML = html || '<div class="empty">No messages yet.<br/>Start a scenario and wait for it to reach this phone.</div>';
}

function renderAlerts() {
  const list = [...world.tracked].reverse().slice(0, 6);
  if (!list.length) {
    $('alerts').innerHTML = '<div class="none">Start a scenario to watch an alert travel through the crowd.</div>';
    return;
  }
  $('alerts').innerHTML = list.map((tr) => {
    const age = Math.round(world.t - tr.originAt);
    if (tr.to) {
      const status = tr.delivered
        ? `<span style="color:var(--ok)">Delivered after ${Math.round(tr.delivered.at)} s · ${tr.delivered.hops} hops</span>`
        : `In transit… ${age} s`;
      return `<div class="alert"><div class="head"><b style="color:${tr.color}">${esc(tr.title)}</b></div><div class="meta">${status}</div></div>`;
    }
    const r = world.reach(tr);
    const pct = Math.round((r.reached / r.total) * 100);
    const bars = r.byLevel.map((b, i) => {
      const w = b.total ? Math.round((b.reached / b.total) * 100) : 0;
      return `<div class="lv">L${LEVELS[i].id} · ${b.reached}/${b.total}<div class="bar"><i style="width:${w}%;background:${tr.color}"></i></div></div>`;
    }).join('');
    const t50 = tr.t50 !== null ? `50% in ${Math.round(tr.t50)} s` : '50% …';
    const t90 = tr.t90 !== null ? `90% in ${Math.round(tr.t90)} s` : '90% …';
    return `<div class="alert"><div class="head"><b style="color:${tr.color}">${esc(tr.title)}</b><span class="meta">+${age} s</span></div><div class="meta">Reached ${r.reached}/${r.total} phones (${pct}%) · ${t50} · ${t90}</div><div class="levels">${bars}</div></div>`;
  }).join('');
}

function renderLog() {
  $('log').innerHTML = [...world.log].reverse().slice(0, 12).map((e) =>
    `<div class="logline" style="border-color:${e.color}"><span>T+${mmss(e.t)}</span>${esc(e.text)}</div>`).join('')
    || '<div class="none">Nothing yet.</div>';
}

function renderChips() {
  $('chipTime').textContent = mmss(world.t);
  $('chipNodes').textContent = String(world.agents.length);
  const mesh = $('chipMesh'), off = $('chipOfficial');
  mesh.className = 'chip ' + (settings.mesh ? 'ok' : 'bad');
  mesh.innerHTML = `Mesh <b>${settings.mesh ? 'on' : 'off'}</b>`;
  off.className = 'chip ' + (world.officialOnline ? '' : 'bad');
  off.innerHTML = `Directorate network <b>${world.officialOnline ? 'online' : 'CUT'}</b>`;

  const banner = $('banner');
  if (!world.officialOnline) {
    banner.style.display = 'block';
    banner.textContent = settings.mesh
      ? 'DIRECTORATE NETWORK CUT — the mesh keeps carrying messages'
      : 'DIRECTORATE NETWORK CUT — and no mesh: nobody can warn anybody';
  } else banner.style.display = 'none';
}

function updatePanels(now) {
  if (now - lastPanel < 250) return;
  lastPanel = now;
  renderChips();
  renderPhoneCard();
  renderAlerts();
  renderLog();
  for (const k of Object.keys(sparkCanvases)) drawSpark(k);
}

// ------------------------------------------------------------------------- demo

function startDemo() {
  $('officialToggle').checked = false; // the demo starts with the Directorate network up
  build();
  const at = (t, caption, fn) => ({ t, caption, fn });
  demo = {
    i: 0,
    steps: [
      at(1, 'A quiet day in the Hollow. You are the highlighted phone on Level 4.', () => {}),
      at(6, 'The Level 12 power grid starts to fail. A sensor node raises an alert, and the Directorate says everything is fine.', () => world.trigger('POWER')),
      at(24, 'The Directorate cuts the network. Nobody can call anybody.', () => setOfficialCut(true)),
      at(34, 'Recycler 3 is contaminated. The sensor alerts nearby phones, and walkers carry the warning across levels.', () => world.trigger('WATER')),
      at(70, 'A family member on Level 12 sends an "I\'m OK" check-in to your phone, with no network at all.', () => world.sendCheckin()),
      at(150, 'Every warning travelled phone to phone. Turn on relay boxes to see how much faster it gets.', () => {}),
    ],
  };
  settings.speed = 4; $('speed').value = '4';
  settings.paused = false; $('pauseBtn').textContent = '⏸ Pause';
}

function runDemo() {
  if (!demo) return;
  while (demo.i < demo.steps.length && world.t >= demo.steps[demo.i].t) {
    const st = demo.steps[demo.i++];
    st.fn();
    updateScenarioButtons();
    const cap = $('caption');
    cap.textContent = st.caption;
    cap.style.display = 'block';
  }
  if (demo.i >= demo.steps.length && world.t > demo.steps[demo.steps.length - 1].t + 25) {
    $('caption').style.display = 'none';
    demo = null;
  }
}

function setOfficialCut(cut) {
  world.officialOnline = !cut;
  $('officialToggle').checked = cut;
}

// ---------------------------------------------------------------------- controls

function wireControls() {
  $('pauseBtn').onclick = () => {
    settings.paused = !settings.paused;
    $('pauseBtn').textContent = settings.paused ? '▶ Resume' : '⏸ Pause';
  };
  $('resetBtn').onclick = () => { demo = null; $('caption').style.display = 'none'; build(); };
  $('demoBtn').onclick = startDemo;
  $('speed').onchange = (e) => { settings.speed = Number(e.target.value); };

  $('density').oninput = (e) => { $('densityOut').textContent = e.target.value; };
  $('density').onchange = (e) => { settings.phonesPerLevel = Number(e.target.value); demo = null; build(); };
  $('range').oninput = (e) => {
    settings.phoneRange = Number(e.target.value);
    $('rangeOut').textContent = e.target.value;
    world.phoneRange = settings.phoneRange;
  };
  $('meshToggle').onchange = (e) => { settings.mesh = e.target.checked; world.meshEnabled = settings.mesh; };
  $('relayToggle').onchange = (e) => { settings.relays = e.target.checked; world.setRelays(settings.relays); };
  $('linkToggle').onchange = (e) => { settings.links = e.target.checked; };
  $('officialToggle').onchange = (e) => { world.officialOnline = !e.target.checked; };

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('pauseBtn').click(); }
  });

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * WORLD.width;
    const y = ((e.clientY - rect.top) / rect.height) * WORLD.height;
    let best = null, bestD = 18 * 18;
    for (const p of world.phones) {
      const d = (p.x - x) ** 2 + (p.y - y) ** 2;
      if (d < bestD) { best = p; bestD = d; }
    }
    if (best) { world.selectedId = best.id; lastPanel = 0; }
  });
}

// ------------------------------------------------------------------------- loop

let last = performance.now();
let acc = 0;
function frame(now) {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!settings.paused) {
    acc += realDt * settings.speed;
    while (acc >= DT) { world.step(DT); acc -= DT; }
    runDemo();
  }
  draw(now);
  updatePanels(now);
  requestAnimationFrame(frame);
}

buildSensorPanel();
build();
wireControls();
fitCanvas();
window.addEventListener('resize', fitCanvas);
requestAnimationFrame(frame);

// handy for poking around from the browser console
window.hollow = { get world() { return world; } };
