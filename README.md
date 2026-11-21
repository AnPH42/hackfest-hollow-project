# Hollow Mesh

A delay-tolerant mesh network for **the Hollow**: hazard alerts and check-ins travel device to device over Bluetooth or local links, with no central network required.

## Current Demo: ESP32 Bluetooth Proximity Courier

In this demo, a **sensor ESP32** (`Hollow-Sensor`) detects an abnormality (such as heat, flooding, or a blackout), hands the alert over Bluetooth (BLE) to a nearby **courier device** (laptop or Android phone running `ble.html`), which carries it out of range to a **mailbox ESP32** (`Hollow-Mailbox`), which then passes it on to other courier devices.

### Quick Start

1. **Start the local server** (requires Node 18+):
   ```bash
   npm run relay
   ```
   This prints all local and LAN URLs with a short description of what each page demos.
2. **Open the Bluetooth Courier page** in **Chrome or Edge** (desktop or Android; iOS Safari does not support Web Bluetooth):
   - On the server laptop: `http://localhost:3000/ble.html` (or `?mock=1` for practice mode without ESP32s).
   - On other courier devices over Wi-Fi: open `http://<your-ip>:3000/ble.html` after enabling `chrome://flags/#unsafely-treat-insecure-origin-as-secure` with `http://<your-ip>:3000` and relaunching Chrome.
3. **Open the Big-Screen Board (optional)** on the presenter laptop:
   - `http://localhost:3000/board.html`
   - When couriers are on Wi-Fi, pickups and drop-offs stream live to the board. If Wi-Fi is turned off during the demo, BLE transfers still work on the courier devices, and missed hops replay to the board once Wi-Fi reconnects.

### Files Used in This Demo

| File | Role |
|---|---|
| `esp32/sensor_node.ino` | Firmware for `Hollow-Sensor` (detects hazards, serves alerts over BLE) |
| `esp32/HollowGuard_BLE_Mailbox.ino` | Firmware for `Hollow-Mailbox` (stores up to 4 dropped-off alerts, serves over BLE) |
| `frontend/ble.html`, `frontend/ble.js` | Bluetooth courier UI (live 4-stage relay tracker, packet inspector, transfer log) |
| `frontend/ble-link.js` | Web Bluetooth GATT client, 10-byte `HollowPacket` codec, and `MockBoard` |
| `frontend/board.html`, `frontend/board.js` | Big-screen live board showing devices per level and real-time hops |
| `shared/mesh.js`, `shared/sim.js` | Core `MeshNode` routing (dedup, TTL, store-and-forward) and `SENSOR_DEFS` |
| `backend/server.js`, `package.json` | Serves static files and streams optional `/telemetry` to `board.html` |

---

## Other Files & Demos (Not Used in the BLE Proximity Demo)

Keep these files in the repository so teammates and tests continue to work, even though they aren't part of the physical ESP32 Bluetooth demo:

| File | What it does |
|---|---|
| `frontend/phone.html`, `frontend/phone.js` | **Wi-Fi / WebRTC phone demo:** Simulates radio range by tapping Level buttons (`4 / 7 / 9 / 12`) over Wi-Fi; does not use Bluetooth. |
| `frontend/index.html`, `frontend/main.js` | **2D Hollow simulator:** Virtual crowd, shafts, LoRa relay boxes, and Directorate network-cut simulation in the browser. |
| `backend/bridge.js`, `backend/fake-esp32.js` | **USB-serial / fake sensor bridge:** Reads `KIND,value` lines over stdin/serial and injects alerts into `server.js` for the Wi-Fi demo. |
| `esp32/receiver_node.ino` | **ESP-NOW receiver sketch:** Receives ESP-NOW broadcasts (not BLE) and logs alerts to Serial/LED. |
| `docs/BLE-SPEC.md` | **BLE protocol spec:** Reference contract for UUIDs, advertising, and the 10-byte packet format. |
| `test/test.js` | **Unit tests:** Run `npm test` to verify `MeshNode` routing and `HollowPacket` encoding/decoding. |
