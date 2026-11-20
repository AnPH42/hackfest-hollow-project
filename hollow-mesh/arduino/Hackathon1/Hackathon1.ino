#include <SoftwareSerial.h>

SoftwareSerial espSerial(6, 10); // RX = D6, TX = D10
#include <LiquidCrystal.h>
#include <DHT.h>
#include <Wire.h>
#include <MPU6050.h>

#define DHTPIN 7
#define DHTTYPE DHT11

const int trigPin = 8;
const int echoPin = 9;

const float floodThreshold = 10.0;

// MPU6050 thresholds
const long mildThreshold = 4000;
const long strongThreshold = 10000;

DHT dht(DHTPIN, DHTTYPE);
LiquidCrystal lcd(12, 11, 5, 4, 3, 2);
MPU6050 mpu;

int16_t ax, ay, az;
int16_t prevX, prevY, prevZ;

float temp = NAN;
float humidity = NAN;
float distance = -1;

unsigned long lastMPURead = 0;
unsigned long lastDHTRead = 0;
unsigned long lastDistanceRead = 0;
unsigned long lastLCDUpdate = 0;
unsigned long lastStrongShake = 0;

bool strongAlertActive = false;
bool mpuReady = false;

int screenNumber = 0;
int vibrationLevel = 0;

void setup() {
  Serial.begin(115200);
  espSerial.begin(9600);

  dht.begin();
  Wire.begin();

  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);

  lcd.begin(16, 2);
  lcd.print("HOLLOWGUARD");

  mpu.initialize();
  mpuReady = mpu.testConnection();

  if (mpuReady) {
    mpu.getAcceleration(&prevX, &prevY, &prevZ);
    Serial.println("MPU6050 Connected!");
  } else {
    Serial.println("MPU6050 Failed!");
  }

  delay(2000);
  lcd.clear();
}

void loop() {
  unsigned long currentTime = millis();

  // 1. Check vibration every 50 ms
  if (mpuReady && currentTime - lastMPURead >= 50) {
    lastMPURead = currentTime;

    mpu.getAcceleration(&ax, &ay, &az);

    long changeX = abs((long)ax - prevX);
    long changeY = abs((long)ay - prevY);
    long changeZ = abs((long)az - prevZ);

    long totalChange = changeX + changeY + changeZ;

    if (totalChange > strongThreshold) {
      vibrationLevel = 2;
      lastStrongShake = currentTime;
      strongAlertActive = true;
    }
    else if (totalChange > mildThreshold) {
      vibrationLevel = 1;
    }
    else {
      vibrationLevel = 0;
    }

    prevX = ax;
    prevY = ay;
    prevZ = az;

    Serial.print("Vibration: ");
    Serial.println(totalChange);
  }

  // 2. Read DHT11 every 2 seconds
  if (currentTime - lastDHTRead >= 2000) {
    lastDHTRead = currentTime;

    temp = dht.readTemperature();
    humidity = dht.readHumidity();
  }

  // 3. Check flood distance every 200 ms
  if (currentTime - lastDistanceRead >= 200) {
    lastDistanceRead = currentTime;

    digitalWrite(trigPin, LOW);
    delayMicroseconds(2);

    digitalWrite(trigPin, HIGH);
    delayMicroseconds(10);
    digitalWrite(trigPin, LOW);

    long duration = pulseIn(echoPin, HIGH, 30000);

    distance = -1;

    if (duration > 0) {
      distance = duration * 0.0343 / 2.0;
    }
  }

  // 4. Keep strong shaking alert for 5 seconds
  if (strongAlertActive &&
      currentTime - lastStrongShake >= 5000) {
    strongAlertActive = false;
  }

  // 5. Update LCD every 200 ms
  if (currentTime - lastLCDUpdate >= 200) {
    lastLCDUpdate = currentTime;

    lcd.clear();

    // Highest priority: strong shaking
    if (strongAlertActive) {
      lcd.print("EARTHQUAKE ALERT");
      lcd.setCursor(0, 1);
      lcd.print("STRONG SHAKING!");
    }

    // Second priority: flood warning
    else if (distance > 0 &&
             distance <= floodThreshold) {
      lcd.print("FLOOD WARNING!");
      lcd.setCursor(0, 1);
      lcd.print("Dist: ");
      lcd.print(distance, 1);
      lcd.print(" cm");
    }

    // Third priority: mild shaking
    else if (vibrationLevel == 1) {
      lcd.print("VIBRATION ALERT");
      lcd.setCursor(0, 1);
      lcd.print("MILD SHAKING");
    }

    // Fourth priority: heat warning
else if (!isnan(temp) && temp >= 38.0) {
  lcd.print("!!! HEAT ALERT");
  lcd.setCursor(0, 1);
  lcd.print("Temp: ");
  lcd.print(temp, 1);
  lcd.print(" C");
}

    // Normal sensor screens
    else {
      if (currentTime / 3000 % 2 == 0) {
        // Temperature and humidity
        if (isnan(temp) || isnan(humidity)) {
          lcd.print("DHT Sensor Error");
        } else {
          lcd.print("Temp: ");
          lcd.print(temp, 1);
          lcd.print(" C");

          lcd.setCursor(0, 1);
          lcd.print("Humidity: ");
          lcd.print(humidity, 0);
          lcd.print("%");
        }
      }
      else {
        // Water distance
        if (distance < 0) {
          lcd.print("Distance Error");
        } else {
          lcd.print("Water Distance:");
          lcd.setCursor(0, 1);
          lcd.print(distance, 1);
          lcd.print(" cm");
        }
      }
    }
  }
  // Send a test message once every second
static unsigned long lastSend = 0;

if (millis() - lastSend >= 1000) {
  lastSend = millis();

  espSerial.print("TEMP:");
  espSerial.println(temp);

  espSerial.print("HUMIDITY:");
  espSerial.println(humidity);

  espSerial.print("DISTANCE:");
  espSerial.println(distance);

  espSerial.print("VIBRATION:");
  espSerial.println(vibrationLevel);

  espSerial.print("ALERT:");

  if (strongAlertActive) {
    espSerial.println("EARTHQUAKE");
  }
  else if (distance > 0 && distance <= floodThreshold) {
    espSerial.println("FLOOD");
  }
  else if (vibrationLevel == 1) {
    espSerial.println("MILD_SHAKING");
  }
  else if (!isnan(temp) && temp >= 38.0) {
    espSerial.println("HEAT");
  }
  else {
    espSerial.println("NORMAL");
  }
}
}
