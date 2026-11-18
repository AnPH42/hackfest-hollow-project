// phone.js — one real phone in the live demo.
//
// This phone runs a genuine MeshNode (mesh.js): dedup, TTL, store-and-forward.
//
// Links between phones:
//   * DIRECT (WebRTC data channels): the server only introduces phones to each
//     other. After that, messages and level changes travel phone-to-phone, and
//     keep working even if the server is shut down.
//   * FALLBACK: if a direct link can't be set up (some networks block it), the
//     server forwards the message instead.
//
// "Radio range" is simulated: two phones can hear each other only when they are
// on the same level. Walk to another level and you become a courier: whatever
// you are carrying is handed to the phones there.

import { MeshNode } from './mesh.js';
import { SENSOR_DEFS, LEVELS, SHAFTS } from './sim.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// storage can throw (private browsing), so never depend on it
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

const params = new URLSearchParams(location.search);
let id = params.get('id') || store.get('hollowId');
if (!id) {
  id = 'P-' + Math.random().toString(36).slice(2, 6).toUpperCase();
  store.set('hollowId', id);
}
let zone = params.get('zone') !== null && Number.isInteger(Number(params.get('zone'))) ? Number(params.get('zone')) : 0;

const HAS_RTC = typeof RTCPeerConnection !== 'undefined';
const RTC_CONFIG = { iceServers: [] };   // same-network only: no internet / STUN needed

const notifs = [];                 // {t, msg}
const peers = new Map();           // peer id -> { pc, dc, open, haveRemote, iceQueue }
const peerZone = new Map();        // peer id -> level index (from the server or from direct gossip)
const peerEpoch = new Map();       // peer id -> connection counter, to spot reloaded phones
const earlyIce = new Map();        // ICE candidates that arrived before their offer
let serverRoster = new Map();      // peer id -> {zone, rtc}   (only while the server is reachable)
let serverUp = false;
let neighbors = new Set();         // peers currently "in range" and reachable
const sentTo = new Map();          // neighbor id -> Set(message ids already handed over)

const node = new MeshNode(id, {
  onDeliver: (msg) => {
    notifs.unshift({ t: new Date(), msg });
    renderNotifs(true);
    try { if (navigator.userActivation?.hasBeenActive) navigator.vibrate?.(200); } catch { /* not supported on iOS */ }
  },
});

// ------------------------------------------------------- server connection

let es = null;
let retryMs = 1000;
function connect() {
  es?.close();
  es = new EventSource(`/events?id=${encodeURIComponent(id)}&zone=${zone}&rtc=${HAS_RTC ? 1 : 0}`);
  es.addEventListener('hello', () => { serverUp = true; retryMs = 1000; renderStatus(); });
  es.addEventListener('peers', (e) => onRoster(JSON.parse(e.data).peers));
  es.addEventListener('signal', (e) => { const { from, data } = JSON.parse(e.data); onSignal(from, data); });
  es.addEventListener('msg', (e) => { const { from, msg } = JSON.parse(e.data); receiveFrom(from, msg); });
  es.onerror = () => {
    serverUp = false;
    serverRoster = new Map();      // direct links keep working without the server
    recompute();
    es.close();
    setTimeout(connect, retryMs);  // reconnect using the CURRENT zone
    retryMs = Math.min(retryMs * 1.5, 5000);
  };
}

function onRoster(list) {
  serverRoster = new Map();
  for (const p of list) {
    if (p.id === id) continue;
    serverRoster.set(p.id, p);
    peerZone.set(p.id, p.zone);
    const prev = peerEpoch.get(p.id);
    if (prev !== undefined && prev !== p.epoch) closePeer(p.id);   // that phone reloaded: its old link is dead
    peerEpoch.set(p.id, p.epoch);
  }
  for (const pid of [...peers.keys()]) {                           // drop half-open links to phones that left
    if (!serverRoster.has(pid) && !peers.get(pid).open) closePeer(pid);
  }
  maintain();
  recompute();
}

const post = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

// ---------------------------------------------------------- WebRTC links

/** Open a link to every WebRTC-capable phone we don't have one with. The phone
 *  with the smaller id always makes the offer, so two phones never both do. */
function maintain() {
  if (!HAS_RTC || !serverUp) return;
  for (const p of serverRoster.values()) {
    if (p.rtc && !peers.has(p.id) && id < p.id) startPeer(p.id);
  }
}
setInterval(maintain, 5000);   // retries failed handshakes

function makePeer(pid) {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const peer = { pc, dc: null, open: false, haveRemote: false, iceQueue: earlyIce.get(pid) ?? [] };
  earlyIce.delete(pid);
  peers.set(pid, peer);
  pc.onicecandidate = (e) => { if (e.candidate) post('/signal', { from: id, to: pid, data: { candidate: e.candidate } }).catch(() => {}); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closePeer(pid, pc); };
  setTimeout(() => { if (peers.get(pid) === peer && !peer.open) closePeer(pid, pc); }, 8000); // handshake took too long
  return peer;
}

function wireChannel(pid, peer, dc) {
  peer.dc = dc;
  dc.onopen = () => {
    peer.open = true;
    dc.send(JSON.stringify({ t: 'zone', zone }));
    recompute();
  };
  dc.onclose = () => closePeer(pid, peer.pc);
  dc.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'zone') { peerZone.set(pid, m.zone); recompute(); }
    else if (m.t === 'msg') receiveFrom(pid, m.msg);
  };
}

async function startPeer(pid) {
  const peer = makePeer(pid);
  wireChannel(pid, peer, peer.pc.createDataChannel('mesh'));
  try {
    await peer.pc.setLocalDescription(await peer.pc.createOffer());
    post('/signal', { from: id, to: pid, data: { desc: peer.pc.localDescription } }).catch(() => {});
  } catch { closePeer(pid, peer.pc); }
}

async function onSignal(from, data) {
  if (!HAS_RTC) return;
  try {
    if (data.desc?.type === 'offer') {
      closePeer(from);                                  // a fresh offer replaces any stale link
      const peer = makePeer(from);
      peer.pc.ondatachannel = (e) => wireChannel(from, peer, e.channel);
      await peer.pc.setRemoteDescription(data.desc);
      peer.haveRemote = true;
      await flushIce(peer);
      await peer.pc.setLocalDescription(await peer.pc.createAnswer());
      post('/signal', { from: id, to: from, data: { desc: peer.pc.localDescription } }).catch(() => {});
    } else if (data.desc?.type === 'answer') {
      const peer = peers.get(from);
      if (!peer) return;
      await peer.pc.setRemoteDescription(data.desc);
      peer.haveRemote = true;
      await flushIce(peer);
    } else if (data.candidate) {
      const peer = peers.get(from);
      if (!peer) { earlyIce.set(from, [...(earlyIce.get(from) ?? []), data.candidate]); return; }
      if (peer.haveRemote) await peer.pc.addIceCandidate(data.candidate);
      else peer.iceQueue.push(data.candidate);
    }
  } catch { closePeer(from); }
}

async function flushIce(peer) {
  for (const c of peer.iceQueue.splice(0)) await peer.pc.addIceCandidate(c);
}

function closePeer(pid, onlyIfPc) {
  const peer = peers.get(pid);
  if (!peer || (onlyIfPc && peer.pc !== onlyIfPc)) return;
  peers.delete(pid);
  try { peer.pc.close(); } catch { /* already closed */ }
  recompute();
}

// ------------------------------------------------------ neighbors & routing

/** Who can we hear right now: same level, and reachable directly or via the server. */
function recompute() {
  const next = new Set();
  for (const [pid, z] of peerZone) {
    if (z !== zone) continue;
    if (peers.get(pid)?.open || (serverUp && serverRoster.has(pid))) next.add(pid);
  }
  neighbors = next;
  for (const k of [...sentTo.keys()]) if (!neighbors.has(k)) sentTo.delete(k); // left range: may need a resend later
  renderStatus();
  pump();
}

function receiveFrom(from, msg) {
  let s = sentTo.get(from);                // the sender already has it, so never echo it back
  if (!s) { s = new Set(); sentTo.set(from, s); }
  s.add(msg.id);
  if (node.receive(msg)) { renderStatus(); pump(); }
}

/** Hand every stored message to every neighbor that hasn't been given it yet. */
function pump() {
  for (const m of node.store.values()) {
    if (m.ttl <= 0) continue;
    const copy = { ...m, ttl: m.ttl - 1, hops: m.hops + 1 };   // one hop further, like MeshNode._forwardTo
    const viaServer = [];
    for (const nid of neighbors) {
      let s = sentTo.get(nid);
      if (!s) { s = new Set(); sentTo.set(nid, s); }
      if (s.has(m.id)) continue;
      s.add(m.id);
      const peer = peers.get(nid);
      if (peer?.open) {
        try {
          peer.dc.send(JSON.stringify({ t: 'msg', msg: copy }));
          if (serverUp) post('/telemetry', { from: id, to: nid, zone, msg: copy }).catch(() => {}); // board spectator feed
          continue;
        } catch { /* channel died: fall back to the server */ }
      }
      viaServer.push(nid);
    }
    if (viaServer.length) {
      post('/relay', { from: id, to: viaServer, msg: copy })
        .catch(() => { for (const t of viaServer) sentTo.get(t)?.delete(m.id); }); // retry on next pump
    }
  }
}
setInterval(pump, 2000);

function moveTo(z) {
  if (z === zone) return;
  zone = z;
  renderLevels();
  for (const p of peers.values()) {
    if (p.open) { try { p.dc.send(JSON.stringify({ t: 'zone', zone })); } catch { /* ignore */ } }
  }
  if (serverUp) post('/zone', { id, zone }).catch(() => {});
  recompute();
}

// ----------------------------------------------------------------- UI

const canWalk = (a, b) => SHAFTS.some((s) => a >= s.from && a <= s.to && b >= s.from && b <= s.to);

function renderLevels() {
  $('levels').innerHTML = LEVELS.map((lv, i) => {
    const here = i === zone;
    const ok = here || canWalk(zone, i);
    return `<button data-z="${i}" class="${here ? 'here' : ''}" ${ok ? '' : 'disabled'}>${here ? '📍 ' : ''}Level ${lv.id}</button>`;
  }).join('');
  for (const b of $('levels').querySelectorAll('button')) b.onclick = () => moveTo(Number(b.dataset.z));
}

function renderStatus() {
  $('myId').textContent = id;
  $('chipConn').innerHTML = `<b>Level ${LEVELS[zone].id}</b>`;
  $('chipPeers').innerHTML = `In range <b>${neighbors.size}</b>`;
  const carrying = [...node.store.values()].filter((m) => m.ttl > 0).length;
  $('chipCarry').innerHTML = `Carrying <b>${carrying}</b>`;
  const direct = [...peers.values()].filter((p) => p.open).length;
  $('chipDirect').innerHTML = HAS_RTC ? `Direct links <b>${direct}</b>` : 'Direct links <b>n/a</b>';
  const srv = $('chipServer');
  srv.className = 'chip ' + (serverUp ? 'ok' : 'bad');
  srv.innerHTML = serverUp ? 'Server <b>online</b>' : 'Server <b>offline</b>';
}

function renderNotifs(flashFirst = false) {
  if (!notifs.length) return;
  $('notifs').innerHTML = notifs.map(({ t, msg }, i) => {
    const time = t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const via = `Via mesh · ${msg.hops} hop${msg.hops === 1 ? '' : 's'} · ${time}`;
    const cls = flashFirst && i === 0 ? 'notif flash' : 'notif';
    if (msg.type === 'ALERT') {
      const color = SENSOR_DEFS[msg.payload.kind]?.color ?? '#ffb020';
      return `<div class="${cls}" style="border-color:${color}"><b style="color:${color}">⚠ ${esc(msg.payload.title)}</b>${esc(msg.payload.advice)}<small>From Level ${msg.level} · ${via}</small></div>`;
    }
    if (msg.type === 'CHECKIN') {
      return `<div class="${cls}" style="border-color:#86efac"><b>${esc(msg.payload.name)} is OK</b>Checked in from Level ${msg.level}.<small>${via}</small></div>`;
    }
    return `<div class="${cls}"><b>${esc(msg.type)}</b><small>${via}</small></div>`;
  }).join('');
}

function buildButtons() {
  $('alerts').innerHTML = Object.entries(SENSOR_DEFS)
    .map(([k, d]) => `<button data-k="${k}"><span style="color:${d.color}">●</span> ${esc(d.button)}</button>`).join('');
  for (const b of $('alerts').querySelectorAll('button')) {
    b.onclick = () => {
      const d = SENSOR_DEFS[b.dataset.k];
      node.originate({
        type: 'ALERT', level: LEVELS[d.level].id, location: d.location, ttl: 24,
        payload: { kind: b.dataset.k, title: d.title, advice: d.advice },
      });
      renderStatus(); pump();
    };
  }
  $('checkin').onclick = () => {
    node.originate({ type: 'CHECKIN', level: LEVELS[zone].id, ttl: 30, payload: { name: id, status: 'OK' } });
    renderStatus(); pump();
  };
}

buildButtons();
renderLevels();
renderStatus();
connect();
