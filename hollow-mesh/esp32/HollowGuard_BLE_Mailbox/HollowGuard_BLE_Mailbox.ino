#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

#define SERVICE_UUID "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0000"
#define FEED_UUID    "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0001"
#define COMMUNITY_FEED_UUID  "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0003"
#define COMMUNITY_INBOX_UUID "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0004"
#define INBOX_UUID   "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0002"

struct __attribute__((packed)) HollowPacket {
  uint8_t magic[2];
  uint8_t kind;
  uint8_t level;
  int16_t valueX10;
  uint8_t ttl;
  uint8_t hops;
  uint16_t id;
};

static_assert(sizeof(HollowPacket) == 10, "Packet must be 10 bytes");

HollowPacket stored[4];
int storedCount = 0;
const unsigned long ALERT_LIFETIME = 10UL * 60UL * 1000UL;
unsigned long alertReceivedAt[4] = {0};

Preferences preferences;

void saveAlerts() {
  if (storedCount == 0) {
    preferences.remove("alerts");
  } else {
    preferences.putBytes(
      "alerts",
      stored,
      storedCount * sizeof(HollowPacket)
    );
  }
}

  void loadAlerts() {
  size_t bytes = preferences.getBytesLength("alerts");

  // Only load complete packets, up to our 4-packet limit
  if (bytes == 0 ||
      bytes > sizeof(stored) ||
      bytes % sizeof(HollowPacket) != 0) {
    storedCount = 0;
    return;
  }

  storedCount = bytes / sizeof(HollowPacket);

  preferences.getBytes("alerts", stored, bytes);
  for (int i = 0; i < storedCount; i++) {
  alertReceivedAt[i] = millis();
}

  Serial.print("Restored alerts: ");
  Serial.println(storedCount);
}
void updateFeed();
void removeExpiredAlerts() {
  int writeIndex = 0;
  bool changed = false;

  for (int i = 0; i < storedCount; i++) {
    if (millis() - alertReceivedAt[i] >= ALERT_LIFETIME) {
      changed = true;
      continue;
    }

    stored[writeIndex] = stored[i];
    alertReceivedAt[writeIndex] = alertReceivedAt[i];
    writeIndex++;
  }

  if (changed) {
    storedCount = writeIndex;
    saveAlerts();
    updateFeed();
    Serial.println("Expired alerts removed");
  }
}

BLECharacteristic* feedCharacteristic;

void updateFeed() {
  if (storedCount == 0) {
    feedCharacteristic->setValue((uint8_t*)nullptr, 0);
    return;
  }

  uint8_t bytes[40];

  memcpy(bytes, stored, storedCount * sizeof(HollowPacket));

  feedCharacteristic->setValue(
    bytes,
    storedCount * sizeof(HollowPacket)
  );
}

class InboxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String value = characteristic->getValue();
    Serial.print("BLE write received, bytes=");
Serial.println(value.length());

    if (value.length() != sizeof(HollowPacket)) return;

    HollowPacket packet;
    memcpy(&packet, value.c_str(), sizeof(packet));
    Serial.print("Incoming packet kind=");
Serial.print(packet.kind);
Serial.print(" id=");
Serial.println(packet.id);

    if (packet.magic[0] != 'H' || packet.magic[1] != 'M') return;
    if(packet.kind<1||packet.kind>7||packet.id==0)return;

    for (int i = 0; i < storedCount; i++) {
      if (stored[i].kind == packet.kind &&
          stored[i].id == packet.id) {
        return;
      }
    }

    if (storedCount == 4) {
  for (int i = 1; i < 4; i++) {
    stored[i - 1] = stored[i];
    alertReceivedAt[i - 1] = alertReceivedAt[i];
  }
  storedCount = 3;
}

stored[storedCount] = packet;
alertReceivedAt[storedCount] = millis();
storedCount++;

saveAlerts();
    updateFeed();

    feedCharacteristic->setValue(
      (uint8_t*)&packet,
      sizeof(packet)
    );
    feedCharacteristic->notify();

    // Restore full stored feed for future reads
    updateFeed();

    Serial.print("Stored alert kind=");
    Serial.print(packet.kind);
    Serial.print(" id=");
    Serial.println(packet.id);
  }
};

class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* server) override {
    Serial.println("Courier connected!");

    // Continue advertising for other couriers
    BLEDevice::startAdvertising();
  }

  void onDisconnect(BLEServer* server) override {
    Serial.println("Courier disconnected!");
    BLEDevice::startAdvertising();
  }
};

  void setup() {
  Serial.begin(115200);

  preferences.begin("hollow", false);
  loadAlerts();

  BLEDevice::init("Hollow-Mailbox");

  BLEServer* server = BLEDevice::createServer();
  server->setCallbacks(new ServerCallbacks());

  BLEService* service = server->createService(SERVICE_UUID);

  feedCharacteristic = service->createCharacteristic(
    FEED_UUID,
    BLECharacteristic::PROPERTY_READ |
    BLECharacteristic::PROPERTY_NOTIFY
  );

  feedCharacteristic->addDescriptor(new BLE2902());
  updateFeed();

  BLECharacteristic* inbox = service->createCharacteristic(
    INBOX_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );

  inbox->setCallbacks(new InboxCallbacks());

  service->start();

  BLEAdvertising* advertising = BLEDevice::getAdvertising();
  advertising->addServiceUUID(SERVICE_UUID);
  advertising->start();

  Serial.println("Hollow-Mailbox ready!");
}

void loop() {
  removeExpiredAlerts();
  delay(1000);
}