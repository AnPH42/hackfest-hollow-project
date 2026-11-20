
#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>

// Arduino Uno TX (D10) -> voltage divider -> GPIO16
#define ARDUINO_RX_PIN 16
#define LIGHT_SENSOR_PIN 4
#define BUZZER_PIN 5

#define LOW_POWER_DEMO 1

//  BLUETOOTH CONFIG 

#define BLE_SERVICE_UUID "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0000"
#define BLE_FEED_UUID    "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0001"
#define BLE_INBOX_UUID   "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0002"

BLECharacteristic* bleFeed = nullptr;
BLECharacteristic* bleInbox = nullptr;

const int BLACKOUT_THRESHOLD = 1000;
const unsigned long BLACKOUT_DELAY = 2000;

const unsigned long BUZZER_INTERVAL = 300;
unsigned long lastBuzzerToggle = 0;
bool buzzerState = false;

const uint8_t KIND_BLACKOUT = 1;
const uint8_t KIND_BLACKOUT_CLEAR = 8;
const uint8_t KIND_SENSOR_CLEAR = 9;
const uint8_t KIND_HEARTBEAT = 10;

const unsigned long HEARTBEAT_INTERVAL = 2000;
unsigned long lastHeartbeat = 0;

bool blackoutActive = false;
unsigned long darknessStart = 0;
unsigned long lastBlackoutSend = 0;
uint16_t blackoutAlertId = 0;

const uint8_t LEVEL_ID = 12;

const uint8_t KIND_FLOOD = 4;
const uint8_t KIND_HEAT = 5;
const uint8_t KIND_EARTHQUAKE = 6;
const uint8_t KIND_VIBRATION = 7;

typedef struct __attribute__((packed)) {
  uint8_t magic[2];
  uint8_t kind;
  uint8_t level;
  int16_t valueX10;
  uint8_t ttl;
  uint8_t hops;
  uint16_t id;
} HollowPacket;

// ---------------- BLE ALERT STORAGE ----------------

static_assert(sizeof(HollowPacket) == 10,
              "HollowPacket must be 10 bytes");

HollowPacket bleStored[4];
int bleStoredCount = 0;

void updateBLEFeed() {
  uint8_t data[40] = {};

  memcpy(data, bleStored,
         bleStoredCount * sizeof(HollowPacket));

  bleFeed->setValue(
    data,
    bleStoredCount * sizeof(HollowPacket)
  );
}

void addBLEAlert(const HollowPacket& packet) {
  // Ignore duplicate alerts
  for (int i = 0; i < bleStoredCount; i++) {
    if (bleStored[i].kind == packet.kind &&
        bleStored[i].id == packet.id) {
      return;
    }
  }

  // Maximum of 4 stored alerts
  if (bleStoredCount == 4) {
    for (int i = 1; i < 4; i++) {
      bleStored[i - 1] = bleStored[i];
    }
    bleStoredCount = 3;
  }

  bleStored[bleStoredCount++] = packet;

  if (bleFeed != nullptr) {
    updateBLEFeed();

    // Notify subscribers about this new packet
    bleFeed->setValue(
      (uint8_t*)&packet,
      sizeof(packet)
    );
    bleFeed->notify();

    // Restore full feed for future reads
    updateBLEFeed();
  }

  Serial.println("BLE alert stored");
}

void clearBLEAlert(uint8_t kind) {
  for (int i = 0; i < bleStoredCount; ) {
    if (bleStored[i].kind == kind) {
      for (int j = i; j < bleStoredCount - 1; j++) {
        bleStored[j] = bleStored[j + 1];
      }
      bleStoredCount--;
    } else {
      i++;
    }
  }

  if (bleFeed != nullptr) {
    updateBLEFeed();
  }
}


const uint8_t BROADCAST[6] = {
  0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF
};

String inputLine = "";

float temperature = NAN;
float humidity = NAN;
float distance = -1;
int vibration = 0;

String activeAlert = "NORMAL";
String previousAlert = "NORMAL";

uint16_t alertId = 0;

unsigned long lastSend = 0;
unsigned long lastArduinoData = 0;

// ---------------- BUZZER ----------------

void updateBuzzer() {
  bool emergencyActive =
    blackoutActive || activeAlert != "NORMAL";

  if (!emergencyActive) {
    buzzerState = false;
    digitalWrite(BUZZER_PIN, LOW);
    lastBuzzerToggle = millis();
    return;
  }

  unsigned long now = millis();

  if (now - lastBuzzerToggle >= BUZZER_INTERVAL) {
    lastBuzzerToggle = now;
    buzzerState = !buzzerState;

    digitalWrite(
      BUZZER_PIN,
      buzzerState ? HIGH : LOW
    );
  }
}

// ---------------- ESP-NOW ----------------

void sendAlert(uint8_t kind, float value) {
  HollowPacket p = {};

  p.magic[0] = 'H';
  p.magic[1] = 'M';
  p.kind = kind;
  p.level = LEVEL_ID;
  p.valueX10 = (int16_t)(value * 10.0f);
  p.ttl = 8;
  p.hops = 0;
  p.id = alertId;

    // Store supported emergency alerts for Bluetooth
 if (kind == KIND_BLACKOUT ||
    kind == KIND_FLOOD ||
    kind == KIND_HEAT ||
    kind == KIND_EARTHQUAKE ||
    kind == KIND_VIBRATION) {
  addBLEAlert(p);
}

  esp_err_t result = esp_now_send(
    BROADCAST,
    (const uint8_t *)&p,
    sizeof(p)
  );

  if (result != ESP_OK) {
    Serial.println("ESP-NOW send error");
  }
}

// ---------------- ARDUINO DATA ----------------

void processLine(String line) {
  line.trim();

  int separator = line.indexOf(':');
  if (separator < 0) return;

  String key = line.substring(0, separator);
  String value = line.substring(separator + 1);

  if (key == "TEMP") {
    temperature = value.toFloat();
  }
  else if (key == "HUMIDITY") {
    humidity = value.toFloat();
  }
  else if (key == "DISTANCE") {
    distance = value.toFloat();
  }
  else if (key == "VIBRATION") {
    vibration = value.toInt();
  }
  else if (key == "ALERT") {
    activeAlert = value;
    lastArduinoData = millis();

    if (activeAlert != previousAlert) {
      Serial.print("Alert changed: ");
      Serial.println(activeAlert);

      alertId = (uint16_t)random(1, 65535);
      previousAlert = activeAlert;

      if (activeAlert == "NORMAL") {
  clearBLEAlert(KIND_FLOOD);
  clearBLEAlert(KIND_HEAT);

  sendAlert(KIND_SENSOR_CLEAR, 0);
}
      else {
        // Send the new alert immediately
        lastSend = millis() - 1000;
      }
    }
  }
}

// ---------------- BLE SERVER ----------------

class SensorBLECallbacks : public BLEServerCallbacks {
  void onDisconnect(BLEServer* server) override {
    BLEDevice::startAdvertising();
    Serial.println("BLE advertising restarted");
  }
};

void setupBLE() {
  BLEDevice::init("Hollow-Sensor");

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new SensorBLECallbacks());

  BLEService* service = server->createService(
    BLE_SERVICE_UUID
  );

  // FEED: laptop reads stored alerts
  bleFeed = service->createCharacteristic(
    BLE_FEED_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_NOTIFY
  );

  bleFeed->addDescriptor(new BLE2902());
  updateBLEFeed();

  // INBOX: required by the Hollow Mesh protocol
  bleInbox = service->createCharacteristic(
    BLE_INBOX_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );

  // Sensor board intentionally ignores INBOX writes

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(BLE_SERVICE_UUID);
  advertising->start();

  Serial.println("Hollow-Sensor BLE ready!");
}

// ---------------- SETUP ----------------

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  analogReadResolution(12);
  analogSetPinAttenuation(LIGHT_SENSOR_PIN, ADC_11db);

  Serial1.begin(
    9600,
    SERIAL_8N1,
    ARDUINO_RX_PIN,
    -1
  );

  WiFi.mode(WIFI_STA);

  if (LOW_POWER_DEMO) {
    WiFi.setTxPower(WIFI_POWER_2dBm);
  }

  esp_wifi_set_channel(
    1,
    WIFI_SECOND_CHAN_NONE
  );

  if (esp_now_init() != ESP_OK) {
    Serial.println("ESP-NOW initialization failed");
    while (true) delay(1000);
  }

  esp_now_peer_info_t peer = {};
  memcpy(peer.peer_addr, BROADCAST, 6);
  peer.channel = 0;
  peer.encrypt = false;

  if (esp_now_add_peer(&peer) != ESP_OK) {
    Serial.println("Failed to add broadcast peer");
    while (true) delay(1000);
  }

  setupBLE();

Serial.println("HollowGuard bridge ready!");;
}

// ---------------- MAIN LOOP ----------------

void loop() {
  unsigned long now = millis();

  // Read complete lines from Arduino
  while (Serial1.available()) {
    char c = (char)Serial1.read();

    if (c == '\n') {
      processLine(inputLine);
      inputLine = "";
    }
    else if (c != '\r') {
      if (inputLine.length() < 100) {
        inputLine += c;
      }
      else {
        inputLine = "";
      }
    }
  }

  // Stop broadcasting if Arduino communication is lost
  if (now - lastArduinoData > 5000) {
  if (activeAlert != "NORMAL") {
    clearBLEAlert(KIND_FLOOD);
    clearBLEAlert(KIND_HEAT);
  }

  activeAlert = "NORMAL";
}

  // Broadcast active sensor alerts every second
  if (activeAlert != "NORMAL" &&
      now - lastSend >= 1000) {

    lastSend = now;

    if (activeAlert == "EARTHQUAKE") {
      sendAlert(KIND_EARTHQUAKE, vibration);
    }
    else if (activeAlert == "FLOOD") {
      sendAlert(KIND_FLOOD, distance);
    }
    else if (activeAlert == "HEAT") {
      sendAlert(KIND_HEAT, temperature);
    }
    else if (activeAlert == "MILD_SHAKING") {
      sendAlert(KIND_VIBRATION, vibration);
    }
  }

  // ---------------- BLACKOUT DETECTION ----------------

  int lightValue = analogRead(LIGHT_SENSOR_PIN);

  if (lightValue < BLACKOUT_THRESHOLD) {

    if (darknessStart == 0) {
      darknessStart = millis();
    }

    if (!blackoutActive &&
        millis() - darknessStart >= BLACKOUT_DELAY) {

      blackoutActive = true;
      blackoutAlertId = (uint16_t)random(1, 65535);

      Serial.println("BLACKOUT DETECTED!");
    }

  }
  else {

    darknessStart = 0;

    if (blackoutActive) {
  blackoutActive = false;
  Serial.println("POWER RESTORED!");

  clearBLEAlert(KIND_BLACKOUT);

  // Clear only the blackout alert
  sendAlert(KIND_BLACKOUT_CLEAR, 0);
}
  }

  // Broadcast blackout warning every second
  if (blackoutActive &&
      millis() - lastBlackoutSend >= 1000) {

    lastBlackoutSend = millis();

    uint16_t originalId = alertId;

    alertId = blackoutAlertId;
    sendAlert(KIND_BLACKOUT, 0);

    alertId = originalId;
  }

   // Update buzzer without blocking communication
  updateBuzzer();

  // Send heartbeat every 2 seconds
  if (now - lastHeartbeat >= HEARTBEAT_INTERVAL) {
    lastHeartbeat = now;
    sendAlert(KIND_HEARTBEAT, 0);
  }
}