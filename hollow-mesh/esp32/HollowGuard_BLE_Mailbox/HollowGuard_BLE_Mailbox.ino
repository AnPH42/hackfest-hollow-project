#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>

#define SERVICE_UUID         "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0000"
#define FEED_UUID            "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0001"
#define INBOX_UUID           "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0002"
#define COMMUNITY_FEED_UUID  "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0003"
#define COMMUNITY_INBOX_UUID "7e3b0001-6a21-4d5b-9c47-5b1d1a4e0004"

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

// ---------------- COMMUNITY MESSAGE STORAGE ----------------

#define MAX_COMMUNITY_MSGS 4
#define MAX_COMMUNITY_BYTES 512
#define COMMUNITY_CHUNK_BYTES 16

struct CommunityMsg {
  uint16_t len;
  uint8_t data[MAX_COMMUNITY_BYTES];
  char id[64];
};

CommunityMsg communityMsgs[MAX_COMMUNITY_MSGS];
int communityCount = 0;

uint8_t uploadBuf[MAX_COMMUNITY_BYTES];
uint16_t uploadExpectedLen = 0;
uint16_t uploadReceivedLen = 0;
uint8_t uploadNextSeq = 0;
bool uploadActive = false;

BLECharacteristic* feedCharacteristic;
BLECharacteristic* communityFeedCharacteristic;

void extractJsonId(const uint8_t* data, uint16_t len, char* out, size_t outSize) {
  out[0] = '\0';
  String s;
  s.reserve(len);
  for (uint16_t i = 0; i < len; i++) s += (char)data[i];
  int keyPos = s.indexOf("\"id\":\"");
  if (keyPos < 0) return;
  int start = keyPos + 6;
  int end = s.indexOf('"', start);
  if (end < 0) return;
  String idStr = s.substring(start, end);
  idStr.toCharArray(out, outSize);
}

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
    if (packet.kind < 1 || packet.kind > 7 || packet.id == 0) return;

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

class CommunityInboxCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* characteristic) override {
    String value = characteristic->getValue();
    size_t len = value.length();
    if (len == 0) return;

    const uint8_t* b = (const uint8_t*)value.c_str();
    uint8_t cmd = b[0];

    // 0x53 ('S'): Start upload [0x53, lenLow, lenHigh]
    if (cmd == 0x53 && len >= 3) {
      uint16_t total = (uint16_t)b[1] | ((uint16_t)b[2] << 8);
      if (total == 0 || total > MAX_COMMUNITY_BYTES) {
        uploadActive = false;
        return;
      }
      uploadExpectedLen = total;
      uploadReceivedLen = 0;
      uploadNextSeq = 0;
      uploadActive = true;
      return;
    }

    // 0x44 ('D'): Data chunk [0x44, seq, ...payload]
    if (cmd == 0x44 && len >= 3) {
      if (!uploadActive) return;
      uint8_t seq = b[1];
      if (seq != uploadNextSeq) {
        uploadActive = false;
        return;
      }
      size_t payloadLen = len - 2;
      if (uploadReceivedLen + payloadLen > uploadExpectedLen) {
        uploadActive = false;
        return;
      }
      memcpy(uploadBuf + uploadReceivedLen, b + 2, payloadLen);
      uploadReceivedLen += payloadLen;
      uploadNextSeq++;
      return;
    }

    // 0x45 ('E'): End upload [0x45]
    if (cmd == 0x45) {
      if (!uploadActive || uploadReceivedLen != uploadExpectedLen) {
        uploadActive = false;
        return;
      }
      uploadActive = false;

      char msgId[64];
      extractJsonId(uploadBuf, uploadReceivedLen, msgId, sizeof(msgId));

      if (msgId[0] != '\0') {
        for (int i = 0; i < communityCount; i++) {
          if (strcmp(communityMsgs[i].id, msgId) == 0) {
            return; // duplicate
          }
        }
      }

      if (communityCount == MAX_COMMUNITY_MSGS) {
        for (int i = 1; i < MAX_COMMUNITY_MSGS; i++) {
          communityMsgs[i - 1] = communityMsgs[i];
        }
        communityCount = MAX_COMMUNITY_MSGS - 1;
      }

      communityMsgs[communityCount].len = uploadReceivedLen;
      memcpy(communityMsgs[communityCount].data, uploadBuf, uploadReceivedLen);
      strncpy(communityMsgs[communityCount].id, msgId, sizeof(communityMsgs[communityCount].id) - 1);
      communityMsgs[communityCount].id[sizeof(communityMsgs[communityCount].id) - 1] = '\0';
      communityCount++;

      Serial.print("Stored community message, bytes=");
      Serial.print(uploadReceivedLen);
      Serial.print(" total=");
      Serial.println(communityCount);
      return;
    }

    // 0x4E ('N'): Request community message count -> [0x4E, count]
    if (cmd == 0x4E) {
      uint8_t resp[2] = { 0x4E, (uint8_t)communityCount };
      communityFeedCharacteristic->setValue(resp, 2);
      return;
    }

    // 0x52 ('R'): Request chunk [0x52, index, chunk] -> [0x46, index, totalChunks, chunk, ...data]
    if (cmd == 0x52 && len >= 3) {
      uint8_t index = b[1];
      uint8_t chunk = b[2];
      if (index >= communityCount) {
        uint8_t emptyResp[2] = { 0x4E, (uint8_t)communityCount };
        communityFeedCharacteristic->setValue(emptyResp, 2);
        return;
      }

      uint16_t msgLen = communityMsgs[index].len;
      uint8_t totalChunks = (uint8_t)((msgLen + COMMUNITY_CHUNK_BYTES - 1) / COMMUNITY_CHUNK_BYTES);
      if (chunk >= totalChunks) return;

      uint16_t offset = (uint16_t)chunk * COMMUNITY_CHUNK_BYTES;
      uint16_t chunkLen = msgLen - offset;
      if (chunkLen > COMMUNITY_CHUNK_BYTES) chunkLen = COMMUNITY_CHUNK_BYTES;

      uint8_t resp[4 + COMMUNITY_CHUNK_BYTES];
      resp[0] = 0x46; // 'F'
      resp[1] = index;
      resp[2] = totalChunks;
      resp[3] = chunk;
      memcpy(resp + 4, communityMsgs[index].data + offset, chunkLen);
      communityFeedCharacteristic->setValue(resp, 4 + chunkLen);
      return;
    }
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

  communityFeedCharacteristic = service->createCharacteristic(
    COMMUNITY_FEED_UUID,
    BLECharacteristic::PROPERTY_READ
  );
  uint8_t initCount[2] = { 0x4E, 0 };
  communityFeedCharacteristic->setValue(initCount, 2);

  BLECharacteristic* communityInbox = service->createCharacteristic(
    COMMUNITY_INBOX_UUID,
    BLECharacteristic::PROPERTY_WRITE
  );
  communityInbox->setCallbacks(new CommunityInboxCallbacks());

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
