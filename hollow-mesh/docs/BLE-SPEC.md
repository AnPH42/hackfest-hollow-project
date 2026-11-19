# Hollow Mesh: Bluetooth contract for the ESP32 boards

The laptop side is already built (`ble.html`, `ble.js`, `ble-link.js`). This page says exactly what the two boards must do so the laptop can talk to them. Anything not listed here is up to the firmware.

## The idea in one paragraph

Two boards, same GATT layout, two roles. The **sensor board** holds its own alert while the sensor is alarming. The **mailbox board** is a fixed drop-off point: a laptop writes an alert into it, and a different laptop reads it out later. Laptops carry alerts between boards. The boards never talk to each other.

## Advertising

- Advertise continuously, and restart advertising whenever a client disconnects.
- Device names: `Hollow-Sensor` and `Hollow-Mailbox`. **The name must start with `Hollow-`** and be in the advertisement or scan response, because the laptop's device picker filters on it.
- Allow at least 2 simultaneous connections (a laptop may be writing while another reads).
- Optional: lower the radio's transmit power so "close" means a few meters.

## GATT layout (identical on both boards)

| Item | UUID | Properties |
|---|---|---|
| Service | `7e3b0001-6a21-4d5b-9c47-5b1d1a4e0000` | |
| FEED characteristic | `7e3b0001-6a21-4d5b-9c47-5b1d1a4e0001` | read, notify |
| INBOX characteristic | `7e3b0001-6a21-4d5b-9c47-5b1d1a4e0002` | write (with response) |

- **FEED read** returns every stored packet, concatenated (0 to 4 packets = 0 to 40 bytes). This is longer than the default 20-byte read, so make sure long reads work and/or raise the MTU.
- **FEED notify**: whenever a packet is *added* to the store, notify subscribers with that one packet (10 bytes).
- **INBOX write**: exactly one 10-byte packet.

## The packet (10 bytes, little-endian)

| Bytes | Field | Notes |
|---|---|---|
| 0-1 | magic | `0x48 0x4D` ("HM") |
| 2 | kind | 1 POWER, 2 AIR, 3 WATER, 4 FLOOD, 5 HEAT |
| 3 | level | 4, 7, 9 or 12 |
| 4-5 | valueX10 | int16, reading × 10 (41.2 °C is 412) |
| 6 | ttl | hops remaining |
| 7 | hops | hops so far |
| 8-9 | id | uint16, random per alert, never 0 |

Same layout as `HollowPacket` in the ESP-NOW sketches. Example, HEAT 41.2 °C on Level 12, ttl 8, hops 0, id 0x1234:

```
48 4D 05 0C 9C 01 08 00 34 12
```

A packet's identity is the pair **(kind, id)**. Treat two packets with the same pair as the same alert.

## Sensor board behavior

- Same trigger logic as `sensor_node.ino`: after 3 readings in a row over the threshold (HEAT: 38 °C), create a packet `{kind 5, level 12, valueX10 = reading at trip time, ttl 8, hops 0, id = random}`, add it to the store, and notify subscribers.
- Keep it in the store while the alarm lasts. Remove it after 5 normal readings in a row.
- Ignore writes to INBOX (return success so the laptop doesn't error).

## Mailbox board behavior

- On an INBOX write: check the magic and kind. If the (kind, id) pair is already stored, ignore it. Otherwise append it, drop the oldest if there are more than 4, and notify subscribers.
- Optional: forget packets after about 10 minutes.

## Do not touch `ttl` or `hops`

Boards store and serve packets exactly as received. The laptop adds one hop each time it reads from a board or writes to one (sensor → laptop = 1, laptop → mailbox = 2, mailbox → second laptop = 3).

## Quick test without the laptop page

Use a phone app such as nRF Connect: connect to the board, read FEED (should show a multiple of 10 bytes), and for the mailbox write the example bytes above to INBOX. Reading FEED again should show the packet, and a connected subscriber should have been notified.

## Things Web Bluetooth is picky about

- The laptop page can only pair with a board that is advertising at that moment, and it must be opened from `http://localhost`.
- If the characteristic UUIDs or properties differ from the table, the laptop connects and then fails silently. Check these first when something doesn't work.
