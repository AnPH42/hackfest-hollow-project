// server.js — the "radio" for the live phone demo. Run with: node server.js
//
// No npm packages needed. It does three things:
//   1. Serves frontend/ (at /) and shared/ (at /shared/) over HTTP, so phones can open phone.html.
//   2. Keeps track of which level ("zone") each phone is on. Phones on the same
//      level are "in radio range" of each other; phones on different levels are not.
//   3. Introduces phones to each other so they can open DIRECT WebRTC links
//      (/signal). Messages then travel phone-to-phone, and keep working even if
//      this server is shut down.
//   4. Fallback: if a direct link can't be set up, forwards messages between
//      phones in range (/relay), and carries the ESP32 bridge's messages.
//
// The routing brain (dedup, TTL, store-and-forward) runs ON the phones, using
// mesh.js. The server never stores or routes messages itself: it only decides who
// can hear whom, exactly like radio range would.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FRONTEND = path.join(PROJECT, 'frontend');   // served at  /
const SHARED = path.join(PROJECT, 'shared');       // served at  /shared/

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

const clients = new Map();   // phone id -> { id, zone, res }
const viewers = new Set();   // big-screen board connections (res)

// ---------------------------------------------------------------- helpers

const sse = (res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write('retry: 1000\n\n');
};
const send = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

const neighborsOf = (c) => [...clients.values()].filter((o) => o.id !== c.id && o.zone === c.zone).map((o) => o.id);
const roster = () => [...clients.values()].map((c) => ({ id: c.id, zone: c.zone, rtc: c.rtc, epoch: c.epoch }));
let epochCounter = 0;   // bumps every time a client (re)connects, so peers can spot a reloaded phone

// Title shown on the board for a hand-off.
const hopTitle = (msg) => msg.payload?.title ?? (msg.type === 'CHECKIN' ? `${msg.payload?.name ?? 'Someone'} is OK` : msg.type);

function broadcastRoster(zones) {
  const all = roster();
  for (const c of clients.values()) {
    if (zones.has(c.zone)) send(c.res, 'neighbors', { ids: neighborsOf(c) }); // used by the ESP32 bridge
    send(c.res, 'peers', { peers: all });                                      // used by phones to set up direct links
  }
  for (const v of viewers) send(v, 'roster', { clients: all });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (d) => { body += d; if (body.length > 1e6) { req.destroy(); reject(new Error('too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function lanUrls() {
  const out = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) out.push(`http://${a.address}:${PORT}`);
  }
  return out;
}

// ----------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // A phone connects here to receive neighbor updates and messages.
  if (req.method === 'GET' && url.pathname === '/events') {
    const id = url.searchParams.get('id');
    const zone = Number(url.searchParams.get('zone'));
    if (!id || !Number.isInteger(zone)) { res.writeHead(400).end('bad request'); return; }
    sse(res);
    const prev = clients.get(id);
    if (prev && prev.res !== res) { try { prev.res.end(); } catch { /* already closed */ } }
    const c = { id, zone, res, rtc: url.searchParams.get('rtc') === '1', epoch: ++epochCounter };
    clients.set(id, c);
    send(res, 'hello', { id, zone });
    broadcastRoster(new Set([zone]));
    req.on('close', () => {
      if (clients.get(id)?.res === res) {
        clients.delete(id);
        broadcastRoster(new Set([zone, c.zone]));
      }
    });
    return;
  }

  // The big-screen board watches everything.
  if (req.method === 'GET' && url.pathname === '/board-events') {
    sse(res);
    viewers.add(res);
    send(res, 'roster', { clients: roster() });
    req.on('close', () => viewers.delete(res));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/info') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ urls: lanUrls(), port: PORT }));
    return;
  }

  // A phone changes level ("walks through a shaft").
  if (req.method === 'POST' && url.pathname === '/zone') {
    try {
      const { id, zone } = await readJson(req);
      const c = clients.get(id);
      if (!c || !Number.isInteger(zone)) { res.writeHead(404).end(); return; }
      const old = c.zone;
      c.zone = zone;
      broadcastRoster(new Set([old, zone]));
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
    return;
  }

  // WebRTC introductions: pass an offer / answer / ICE candidate to one specific phone.
  // This is ALL the server does for direct links; it never sees the messages themselves.
  if (req.method === 'POST' && url.pathname === '/signal') {
    try {
      const { from, to, data } = await readJson(req);
      const target = clients.get(to);
      if (target && from && data) send(target.res, 'signal', { from, data });
      res.writeHead(target ? 204 : 404).end();
    } catch { res.writeHead(400).end(); }
    return;
  }

  // Phones that hand a message over a DIRECT link tell the board about it (spectator feed only).
  if (req.method === 'POST' && url.pathname === '/telemetry') {
    try {
      const { from, to, zone, msg } = await readJson(req);
      if (from && to && msg) {
        for (const v of viewers) {
          send(v, 'hop', {
            from, to, zone, type: msg.type, kind: msg.payload?.kind ?? null,
            title: hopTitle(msg), hops: msg.hops, via: 'direct',
          });
        }
      }
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
    return;
  }

  // A phone hands a message to neighbors that are in range.
  if (req.method === 'POST' && url.pathname === '/relay') {
    try {
      const { from, to, msg } = await readJson(req);
      const sender = clients.get(from);
      if (!sender || !Array.isArray(to) || !msg) { res.writeHead(400).end(); return; }
      for (const tid of to) {
        const target = clients.get(tid);
        if (!target || target.zone !== sender.zone) continue; // out of range: dropped
        send(target.res, 'msg', { from, msg });
        for (const v of viewers) {
          send(v, 'hop', {
            from, to: tid, zone: sender.zone, type: msg.type, kind: msg.payload?.kind ?? null,
            title: hopTitle(msg), hops: msg.hops, via: 'server',
          });
        }
      }
      res.writeHead(204).end();
    } catch { res.writeHead(400).end(); }
    return;
  }

  // Everything else: static files.
  if (req.method === 'GET') {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    // /shared/... comes from the shared folder; everything else comes from the frontend folder
    const [base, sub] = rel.startsWith('/shared/') ? [SHARED, rel.slice('/shared'.length)] : [FRONTEND, rel];
    const file = path.normalize(path.join(base, sub));
    if (!file.startsWith(base + path.sep) || !MIME[path.extname(file)]) { res.writeHead(404).end('not found'); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)], 'Cache-Control': 'no-store' });
      res.end(data);
    });
    return;
  }

  res.writeHead(405).end();
});

// keep idle connections alive through proxies and phone Wi-Fi power saving
setInterval(() => {
  for (const c of clients.values()) c.res.write(': ping\n\n');
  for (const v of viewers) v.write(': ping\n\n');
}, 15000);

server.listen(PORT, '0.0.0.0', () => {
  console.log('\nHollow mesh relay is running.\n');
  console.log('  Big screen (laptop):  http://localhost:' + PORT + '/board.html');
  console.log('  Simulator:            http://localhost:' + PORT + '/index.html');
  const urls = lanUrls();
  if (urls.length) {
    console.log('\n  Open this on each phone (same Wi-Fi as this computer):');
    for (const u of urls) console.log('    ' + u + '/phone.html');
  } else {
    console.log('\n  No network address found. Connect this computer to Wi-Fi or a phone hotspot.');
  }
  console.log('');
});
