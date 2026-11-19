// receiver_node.ino — BOARD 2: the "far device" with the screen.
//
// What it does
//   * Listens for Hollow alerts broadcast over ESP-NOW by the sensor node.
//   * Out of range (or too far away) it shows "Waiting for alerts".
//   * When you carry it close to the sensor node, the alert appears on the screen.
//   * Also prints everything over USB serial for debugging.
//
// Wiring: SSD1306 OLED (128x64, I2C), classic ESP32 DevKit
//   OLED VCC -> 3V3     GND -> GND     SDA -> GPIO 21     SCL -> GPIO 22
//   (other boards use other I2C pins: change them in Wire.begin below)
//
// Libraries to install (Arduino IDE -> Library Manager):
//   "Adafruit SSD1306" and "Adafruit GFX Library" by Adafruit
// Board support: "esp32" by Espressif Systems (works with 2.x and 3.x).
//
// "Close" means two things together:
//   1. LOW_POWER_DEMO makes the sensor's radio weak (set the same on both boards).
//   2. On board support 3.x, alerts weaker than NEAR_RSSI are ignored. Watch the
//      "rssi" numbers in the Serial Monitor at the distance you want, then set
//      NEAR_RSSI a little below them (closer to 0 means closer). On 2.x there is no
//      signal-strength reading, so only the weak radio limits the range.
//
// If the screen stays blank, the sketch still works; check the Serial Monitor.

#include <WiFi.h>
#include <esp_now.h>
#include <esp_wifi.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#ifndef ESP_ARDUINO_VERSION_MAJOR
#define ESP_ARDUINO_VERSION_MAJOR 2
#endif

// ---- settings you may want to change --------------------------------------
#define LED_PIN        2
#define LOW_POWER_DEMO 1
#define NEAR_RSSI      -60            // dBm; only used on esp32 board support 3.x
const uint8_t MY_LEVEL = 9;           // the level this "far device" is standing on
#define OLED_ADDR      0x3C           // try 0x3D if your screen is not found
// ---------------------------------------------------------------------------

typedef struct __attribute__((packed)) {
  uint8_t  magic[2];
  uint8_t  kind;
  uint8_t  level;
  int16_t  valueX10;
  uint8_t  ttl;
  uint8_t  hops;
  uint16_t id;
} HollowPacket;

const char *KIND_TITLE[] = {"?", "Blackout imminent", "CO2 rising", "Water contaminated", "Tunnel flooding", "Dangerous heat"};
const char *KIND_UNIT[]  = {"", "%", "ppm", "ppm", "cm", "C"};

Adafruit_SSD1306 display(128, 64, &Wire, -1);
bool haveScreen = false;

// filled by the radio callback, handled in loop()
volatile bool gotPacket = false;
volatile int  gotRssi = 0;
HollowPacket  gotPkt;

HollowPacket current;            // the alert we are showing
bool haveAlert = false;
uint16_t lastId = 0;
int      currentRssi = 0;
unsigned long lastHeard = 0;
bool showingAlert = false;

#if ESP_ARDUINO_VERSION_MAJOR >= 3
void onReceive(const esp_now_recv_info_t *info, const uint8_t *data, int len) {
  gotRssi = info->rx_ctrl->rssi;
#else
void onReceive(const uint8_t *mac, const uint8_t *data, int len) {
  gotRssi = 0;                   // not available on 2.x
#endif
  if (len != (int)sizeof(HollowPacket)) return;
  memcpy((void *)&gotPkt, data, sizeof(HollowPacket));
  gotPacket = true;
}

void showIdle() {
  if (!haveScreen) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(1);
  display.setCursor(0, 0);
  display.println("HOLLOW MESH");
  display.print("Level ");
  display.print(MY_LEVEL);
  display.println(" - receiver");
  display.println();
  display.println("Waiting for alerts...");
  if (haveAlert) {
    display.println();
    display.print("Last: ");
    display.print(KIND_TITLE[current.kind]);
  }
  display.display();
}

void showAlert() {
  if (!haveScreen) return;
  display.clearDisplay();
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 0);
  display.println("! ALERT !");
  display.setTextSize(1);
  display.println();
  display.println(KIND_TITLE[current.kind]);
  display.print("From Level ");
  display.print(current.level);
  display.print(": ");
  display.print(current.valueX10 / 10.0, 1);
  display.print(" ");
  display.println(KIND_UNIT[current.kind]);
  display.print("hops ");
  display.print(current.hops + 1);
  display.print("  rssi ");
  display.print(currentRssi);
  display.display();
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);

  Wire.begin(21, 22);
  haveScreen = display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  if (!haveScreen) Serial.println("OLED not found (check wiring, or try address 0x3D). Continuing without it.");

  WiFi.mode(WIFI_STA);
  if (LOW_POWER_DEMO) WiFi.setTxPower(WIFI_POWER_2dBm);
  esp_wifi_set_channel(1, WIFI_SECOND_CHAN_NONE);   // must match the sensor node

  if (esp_now_init() != ESP_OK) {
    Serial.println("ERR,esp-now init failed");
    while (true) delay(1000);
  }
  esp_now_register_recv_cb(onReceive);

  showIdle();
  Serial.println("Receiver ready.");
}

void loop() {
  if (gotPacket) {
    HollowPacket p;
    int rssi;
    noInterrupts();
    memcpy(&p, (const void *)&gotPkt, sizeof(p));
    rssi = gotRssi;
    gotPacket = false;
    interrupts();

    bool ours = p.magic[0] == 'H' && p.magic[1] == 'M' && p.kind >= 1 && p.kind <= 5;
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
    Serial.println(ours ? (near ? "" : "  (too far, ignored)") : "  (not a Hollow packet)");

    if (ours && near) {
      lastHeard = millis();
      currentRssi = rssi;
      if (!showingAlert || p.id != lastId) {
        lastId = p.id;
        current = p;
        haveAlert = true;
        showingAlert = true;
        digitalWrite(LED_PIN, HIGH);
        showAlert();
        Serial.println("ALERT shown on screen");
      } else {
        current = p;             // same alert, refresh the reading
        showAlert();
      }
    }
  }

  // the sensor stopped repeating (it cooled down, or we walked away)
  if (showingAlert && millis() - lastHeard > 8000) {
    showingAlert = false;
    digitalWrite(LED_PIN, LOW);
    showIdle();
  }
}
