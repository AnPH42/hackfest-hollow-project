# Hollow Mesh

A delay-tolerant mesh network for the Hollow: alerts travel phone to phone, with nothing for the Directorate to switch off.

## Folders

```
hollow-mesh/
├── shared/      Used by both sides
│   ├── mesh.js      The routing brain: message format, dedup, TTL, store-and-forward
│   └── sim.js       The simulated Hollow: levels, shafts, sensor definitions
│
├── frontend/    Runs in the browser
│   ├── index.html + main.js     Screen simulator
│   ├── phone.html + phone.js    Live phone/laptop demo (WebRTC)
│   ├── board.html + board.js    Big-screen view of the live demo
│   └── ble.html + ble.js + ble-link.js    Bluetooth courier laptop page
│
├── backend/     Runs in Node (your computer)
│   ├── server.js        Serves the pages, introduces phones to each other, fallback relay
│   ├── bridge.js        Turns sensor readings (HEAT,24.3) into mesh alerts
│   └── fake-esp32.js    Pretend sensor board for testing
│
├── esp32/       Arduino sketches for the real boards
├── docs/        BLE-SPEC.md: the Bluetooth contract for the board firmware
└── test/        Unit tests
```

## Run it

Everything starts from the project folder (needs Node 18+).

| Command | What it does |
|---|---|
| `npm test` | Runs the unit tests |
| `npm run relay` | Starts the server. Open `http://localhost:3000/index.html` (simulator) or `/board.html`. Phones open the address it prints, ending in `/phone.html`. |
| `npm run fake` | Fake ESP32 sensor into the bridge (needs `npm run relay` running). Press `f` for a fault, `r` to reset. |

The Bluetooth page needs `http://localhost:3000/ble.html` (Chrome or Edge, on the same computer that runs the server). Add `?mock=1` to practice with simulated boards.
