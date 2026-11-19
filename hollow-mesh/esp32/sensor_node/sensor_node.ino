// sensor_node.ino — BOARD 1: the heat sensor node.
//
// What it does
//   * Reads a DHT22/DHT11 temperature sensor every 2 seconds.
//   * Prints one line per reading over USB serial:  HEAT,24.3
//     (the same format as fake-esp32.js, so bridge.js can use this board too).
//   * If the temperature stays above THRESHOLD_C for 3 readings, it raises an
//     alert: the LED turns on and the alert is broadcast over ESP-NOW (direct
//     board-to-board radio, no router) once per second until things cool down.
//
// Wiring (classic ESP32 DevKit)
//   DHT  VCC  -> 3V3        DHT  GND -> GND        DHT  DATA -> GPIO 4
//   (a bare 4-pin DHT22 needs a 10k resistor between DATA and 3V3; 3-pin modules already have one)
//
// Libraries to install (Arduino IDE -> Library Manager):
//   "DHT sensor library" by Adafruit   (also accept "Adafruit Unified Sensor")
// Board support: "esp32" by Espressif Systems (works with 2.x and 3.x).
//
// No hot sensor handy? HOLD THE "BOOT" BUTTON on the board: it adds 20 degrees to
// the reading, so you can trigger the alert on demand.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <DHT.h>

// ---- settings you may want to change --------------------------------------
#define DHT_PIN        4
#define DHT_TYPE       DHT22          // change to DHT11 if that is what you have
#define LED_PIN        2              // built-in LED on most ESP32 dev boards
#define FAKE_BTN_PIN   0              // the BOOT button
#define LOW_POWER_DEMO 1              // 1 = weak radio so "close" means a few meters
const float   THRESHOLD_C = 38.0;     // same threshold as the simulator's HEAT sensor
const uint8_t LEVEL_ID    = 12;       // which Hollow level this sensor sits on
// ---------------------------------------------------------------------------

const int TRIP  = 3;                  // readings over the limit before alerting
const int REARM = 5;                  // normal readings before the alert clears
const uint8_t KIND_HEAT = 5;          // 1 POWER, 2 AIR, 3 WATER, 4 FLOOD, 5 HEAT

// Message sent over the air. Both boards must use the exact same layout.
typedef struct __attribute__((packed)) {
  uint8_t  magic[2];   // 'H','M'
  uint8_t  kind;
  uint8_t  level;
  int16_t  valueX10;   // reading * 10
  uint8_t  ttl;
  uint8_t  hops;
  uint16_t id;         // random per alert; receivers use it to ignore repeats
} HollowPacket;

DHT dht(DHT_PIN, DHT_TYPE);
const uint8_t BROADCAST[6] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};

bool alarm = false;
uint16_t alertId = 0;
float lastValue = 0;
int badCount = 0, goodCount = 0;
unsigned long lastRead = 0, lastSend = 0;

void sendAlert() {
  HollowPacket p;
  p.magic[0] = 'H'; p.magic[1] = 'M';
  p.kind = KIND_HEAT;
  p.level = LEVEL_ID;
  p.valueX10 = (int16_t)(lastValue * 10.0f);
  p.ttl = 8;
  p.hops = 0;
  p.id = alertId;
  esp_now_send(BROADCAST, (const uint8_t *)&p, sizeof(p));
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  pinMode(FAKE_BTN_PIN, INPUT_PULLUP);
  dht.begin();

  WiFi.mode(WIFI_STA);
  if (LOW_POWER_DEMO) WiFi.setTxPower(WIFI_POWER_2dBm);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);   // both boards must share a channel

  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR,esp-now init failed");
    while (true) delay(1000);
  }
  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BROADCAST, 6);
  peer.channel = 0;
  peer.encrypt = false;
  esp_now_add_peer(&peer);

  Serial.println("Sensor node ready.");
}

void loop() {
  unsigned long now = millis();

  if (now - lastRead >= 2000) {
    lastRead = now;
    float t = dht.readTemperature();
    if (isnan(t)) {
      Serial.println("ERR,dht read failed (check wiring / DHT_TYPE)");
    } else {
      if (digitalRead(FAKE_BTN_PIN) == LOW) t += 20.0;      // BOOT button = pretend it's hot
      lastValue = t;
      Serial.print("HEAT,");
      Serial.println(t, 1);

      bool over = t > THRESHOLD_C;
      if (over) { badCount++; goodCount = 0; } else { goodCount++; badCount = 0; }

      if (!alarm && badCount >= TRIP) {
        alarm = true;
        alertId = (uint16_t)random(1, 65535);
        Serial.println("ALERT raised, broadcasting over ESP-NOW");
      } else if (alarm && goodCount >= REARM) {
        alarm = false;
        Serial.println("Back to normal.");
      }
      digitalWrite(LED_PIN, alarm ? HIGH : LOW);
    }
  }

  // While the alarm is on, keep repeating it so a board that arrives later still hears it.
  if (alarm && now - lastSend >= 1000) {
    lastSend = now;
    sendAlert();
  }
}
