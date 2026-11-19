// board.js — the big-screen view for the live phone demo. Shows which phone is on
// which level and lights up every message hand-off as it happens.

import { LEVELS, SENSOR_DEFS } from '../shared/sim.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let roster = [];            // [{id, zone}]
const got = new Map();      // phone id -> color of the latest alert it received
let hops = 0;
const logLines = [];

const colorOf = (h) => (h.type === 'ALERT' ? (SENSOR_DEFS[h.kind]?.color ?? '#ffb020') : '#86efac');

function renderLevels() {
  $('levels').innerHTML = LEVELS.map((lv, i) => {
    const here = roster.filter((c) => c.zone === i);
    const chips = here.length
      ? here.map((c) => {
          const col = got.get(c.id);
          return `<div class="phone ${col ? 'got' : ''}" data-id="${esc(c.id)}" style="${col ? `border-color:${col}` : ''}">${esc(c.id)}</div>`;
        }).join('')
      : '<span class="none">no phones here</span>';
    return `<div class="level L${i}"><h2>Level ${lv.id}${lv.note ? ` · ${lv.note}` : ''}</h2><div class="chips">${chips}</div></div>`
      + (i < LEVELS.length - 1 ? '' : '');
  }).join('');
  $('sPhones').textContent = String(roster.length);
}

function renderLog() {
  $('log').innerHTML = logLines.slice(0, 14).map((l) =>
    `<div class="line" style="border-color:${l.color}"><span>${l.time}</span> ${esc(l.text)}</div>`).join('')
    || '<div class="line"><span>Waiting for phones…</span></div>';
}

function flash(id, color) {
  const el = document.querySelector(`.phone[data-id="${CSS.escape(id)}"]`);
  if (!el) return;
  el.style.setProperty('--c', color);
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

const es = new EventSource('/board-events');
es.addEventListener('roster', (e) => {
  roster = JSON.parse(e.data).clients.sort((a, b) => a.id.localeCompare(b.id));
  renderLevels();
});
es.addEventListener('hop', (e) => {
  const h = JSON.parse(e.data);
  const color = colorOf(h);
  hops++;
  $('sHops').textContent = String(hops);
  if (h.type === 'ALERT') got.set(h.to, color);
  renderLevels();
  flash(h.to, color);
  logLines.unshift({
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    text: `${h.from} → ${h.to}: ${h.title} (hop ${h.hops}, Level ${LEVELS[h.zone].id}, ${h.via === 'direct' ? 'direct' : 'via server'})`, color,
  });
  if (logLines.length > 40) logLines.pop();
  renderLog();
});

fetch('/info').then((r) => r.json()).then(({ urls }) => {
  $('join').innerHTML = urls.length
    ? `Phones join at <b>${esc(urls[0].replace('http://', ''))}/phone.html</b>`
    : 'Connect this computer to Wi-Fi or a hotspot so phones can join';
}).catch(() => {});

renderLevels();
