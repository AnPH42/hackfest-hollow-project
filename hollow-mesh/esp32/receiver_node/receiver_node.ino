
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

#define LED_PIN 2
#define LOW_POWER_DEMO 1
#define NEAR_RSSI -90

const uint8_t MY_LEVEL = 9;

const uint8_t KIND_BLACKOUT = 1;
const uint8_t KIND_BLACKOUT_CLEAR = 8;
const uint8_t KIND_SENSOR_CLEAR = 9;
const uint8_t KIND_HEARTBEAT = 10;

const unsigned long HEARTBEAT_TIMEOUT = 6000;
unsigned long lastContact = 0;
bool transmitterConnected = false;
bool connectionLost = false;

const unsigned long HEARTBEAT_INTERVAL = 2000;
unsigned long lastHeartbeat = 0;

const unsigned long ALERT_TIMEOUT = 8000;

typedef struct __attribute__((packed)) {
  uint8_t magic[2];
  uint8_t kind;
  uint8_t level;
  int16_t valueX10;
  uint8_t ttl;
  uint8_t hops;
  uint16_t id;
} HollowPacket;

const char *KIND_TITLE[] = {
  "?",
  "BLACKOUT DETECTED",
  "CO2 rising",
  "Water contaminated",
  "Tunnel flooding",
  "Dangerous heat",
  "EARTHQUAKE ALERT",
  "MILD VIBRATION"
};

const char *KIND_UNIT[] = {
  "", "%", "ppm", "ppm", "cm", "C", "", ""
};

// ESP-NOW received packet
volatile bool gotPacket = false;
volatile int gotRssi = 0;
HollowPacket gotPkt;

// Independent alert states
bool blackoutActive = false;
bool sensorActive = false;

uint16_t lastBlackoutId = 0;
uint16_t lastSensorId = 0;

uint8_t currentSensorKind = 0;

unsigned long lastBlackoutHeard = 0;
unsigned long lastSensorHeard = 0;

// ---------------- LED ----------------

void updateLED() {
  digitalWrite(
    LED_PIN,
    (blackoutActive || sensorActive) ? HIGH : LOW
  );
}

// ---------------- STATUS ----------------

void showStatus() {
  updateLED();

  if (blackoutActive && sensorActive) {
    Serial.println("STATUS: BLACKOUT + SENSOR ALERT");
  }
  else if (blackoutActive) {
    Serial.println("STATUS: BLACKOUT DETECTED");
  }
  else if (sensorActive) {
    Serial.print("STATUS: ");
    Serial.println(KIND_TITLE[currentSensorKind]);
  }
  else {
    Serial.println("ALERT CLEARED - Back to normal");
    Serial.println("Waiting for alerts...");
  }
}

// ---------------- ESP-NOW CALLBACK ----------------

#if ESP_ARDUINO_VERSION_MAJOR >= 3

void onReceive(
  const esp_now_recv_info_t *info,
  const uint8_t *data,
  int len
) {
  gotRssi = info->rx_ctrl->rssi;

#else

void onReceive(
  const uint8_t *mac,
  const uint8_t *data,
  int len
) {
  gotRssi = 0;

#endif

  if (len != (int)sizeof(HollowPacket)) return;

  memcpy((void *)&gotPkt, data, sizeof(HollowPacket));
  gotPacket = true;
}

// ---------------- SETUP ----------------

void setup() {
  Serial.begin(115200);

  pinMode(LED_PIN, OUTPUT);
  digitalWrite(LED_PIN, LOW);

  WiFi.mode(WIFI_STA);

  if (LOW_POWER_DEMO) {
    WiFi.setTxPower(WIFI_POWER_2dBm);
  }

  esp_wifi_set_channel(
    1,
    WIFI_SECOND_CHAN_NONE
  );

  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR,esp-now init failed");
    while (true) delay(1000);
  }

  esp_now_register_recv_cb(onReceive);

  Serial.println("Waiting for alerts...");
  Serial.println("Receiver ready.");
}

// ---------------- MAIN LOOP ----------------

void loop() {

  if (gotPacket) {
    HollowPacket p;
    int rssi;

    noInterrupts();
    memcpy(&p, (const void *)&gotPkt, sizeof(p));
    rssi = gotRssi;
    gotPacket = false;
    interrupts();

    bool ours =
      p.magic[0] == 'H' &&
      p.magic[1] == 'M' &&
      p.kind <= 10;

    bool near = true;

#if ESP_ARDUINO_VERSION_MAJOR >= 3
    near = rssi >= NEAR_RSSI;
#endif

    Serial.print("RECV kind=");
    Serial.print(p.kind);
    Serial.print(" value=");
    Serial.print(p.valueX10 / 10.0, 1);
    Serial.print(" rssi=");
    Serial.print(rssi);

    Serial.println(
      ours
        ? (near ? "" : "  (too far, ignored)")
        : "  (not a Hollow packet)"
    );

    if (ours && near) {
      // Track communication with transmitter
lastContact = millis();

if (!transmitterConnected) {
  transmitterConnected = true;
  Serial.println("TRANSMITTER CONNECTED!");
}

if (connectionLost) {
  connectionLost = false;
  Serial.println("CONNECTION RESTORED!");
}

// Heartbeat received
if (p.kind == KIND_HEARTBEAT) {
  // Transmitter is alive; no emergency action needed
}

      // Legacy command: clear everything
      if (p.kind == 0) {
        blackoutActive = false;
        sensorActive = false;
        showStatus();
      }

      // Clear blackout only
      else if (p.kind == KIND_BLACKOUT_CLEAR) {
        blackoutActive = false;
        Serial.println("POWER RESTORED!");
        showStatus();
      }

      // Clear Arduino sensor alert only
      else if (p.kind == KIND_SENSOR_CLEAR) {
        sensorActive = false;
        Serial.println("SENSOR ALERT CLEARED!");
        showStatus();
      }

      // Blackout warning
      else if (p.kind == KIND_BLACKOUT) {
        lastBlackoutHeard = millis();

        if (!blackoutActive ||
            p.id != lastBlackoutId) {

          blackoutActive = true;
          lastBlackoutId = p.id;

          Serial.println("ALERT RECEIVED!");
          Serial.println("Type: BLACKOUT DETECTED");

          showStatus();
        }
      }

      // Arduino sensor warnings
      else if (p.kind >= 2 && p.kind <= 7) {
        lastSensorHeard = millis();

        if (!sensorActive ||
            p.id != lastSensorId ||
            p.kind != currentSensorKind) {

          sensorActive = true;
          lastSensorId = p.id;
          currentSensorKind = p.kind;

          Serial.println("ALERT RECEIVED!");
          Serial.print("Type: ");
          Serial.println(KIND_TITLE[p.kind]);

          Serial.print("Value: ");
          Serial.print(p.valueX10 / 10.0, 1);
          Serial.print(" ");
          Serial.println(KIND_UNIT[p.kind]);

          showStatus();
        }
      }
    }
  }

  // ---------------- TIMEOUTS ----------------

  // Blackout timeout
  if (blackoutActive &&
      millis() - lastBlackoutHeard > ALERT_TIMEOUT) {

    blackoutActive = false;

    Serial.println("BLACKOUT ALERT TIMED OUT");
    showStatus();
  }

  // Arduino sensor timeout
  if (sensorActive &&
      millis() - lastSensorHeard > ALERT_TIMEOUT) {

    sensorActive = false;

    Serial.println("SENSOR ALERT TIMED OUT");
    showStatus();
  }
  // Detect transmitter communication failure
if (transmitterConnected &&
    !connectionLost &&
    millis() - lastContact > HEARTBEAT_TIMEOUT) {

  connectionLost = true;

  Serial.println("WARNING: CONNECTION LOST!");
  Serial.println("Transmitter status UNKNOWN!");
}
}
