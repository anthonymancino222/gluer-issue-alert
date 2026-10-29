/*
  Gluer Issue Alert - light controller
  Board: Waveshare ESP32-S3-Relay-6CH      Light: LUBAN LED tower (red / yellow / blue / green)

  What it does: connects to your Wi-Fi, then keeps ONE secure connection open to the Gluer light service.
  The tablet app tells the service what the light should do; the service passes it here; this sketch switches
  the relays. The app decides which relay runs which colour (Settings -> Alert light), so you never need to
  re-flash this to change colours.

  Messages from the service (JSON):
    {"t":"light","a":[1],"b":[],"m":"steady"}   steady : relays in "a" on
                                  "m":"flash"    flash  : relays in "a" blink
                                  "m":"alt"      alt    : relays in "a" and "b" take turns
    {"t":"relay","ch":3,"on":true,"ms":3000}     identify : switch relay 3 on for 3 seconds
*/
#include <WiFi.h>
#include <WebSocketsClient.h>   // library "WebSockets" by Markus Sattler
#include <ArduinoJson.h>        // library "ArduinoJson" by Benoit Blanchon (version 7)
#include <Preferences.h>
#include <WebServer.h>
#include <DNSServer.h>

// Wi-Fi name, Wi-Fi password and light code are NOT typed in here. On first start (or when BOOT is held while
// powering on) the board opens its own Wi-Fi "GluerLight-Setup" and a setup page where you type them from a phone.
String WIFI_SSID, WIFI_PASSWORD, LIGHT_CODE;
Preferences prefs;
WebServer web(80);
DNSServer dns;
const uint8_t BOOT_PIN = 0;

const char* HOST = "gluer-issue-sync.anthony-mancino2.workers.dev";

// Waveshare ESP32-S3-Relay-6CH: relay CH1..CH6 are these GPIOs, a relay turns ON when its pin is HIGH
const uint8_t RELAY_PIN[6] = {1, 2, 41, 42, 45, 46};
const uint8_t RGB_PIN = 38;                       // on-board status LED (WS2812)
const unsigned long BLINK_MS = 500;               // flash speed

WebSocketsClient ws;
uint8_t maskA = 0, maskB = 0;                     // bit n-1 = relay n
enum Mode { STEADY, FLASH, ALT } mode = STEADY;
bool phase = false;
unsigned long lastPhase = 0, lastHb = 0, lastState = 0;
bool connected = false;
uint8_t identifyMask = 0; unsigned long identifyUntil = 0;

uint8_t maskOf(JsonArrayConst arr) { uint8_t m = 0; for (JsonVariantConst v : arr) { int n = v.as<int>(); if (n >= 1 && n <= 6) m |= (1 << (n - 1)); } return m; }

void writeRelays(uint8_t m) { for (int i = 0; i < 6; i++) digitalWrite(RELAY_PIN[i], (m >> i) & 1 ? HIGH : LOW); }

void showStatus() {                                // board LED: blue = no Wi-Fi, yellow = Wi-Fi but no service, green = all good
  if (WiFi.status() != WL_CONNECTED) neopixelWrite(RGB_PIN, 0, 0, 40);
  else if (!connected) neopixelWrite(RGB_PIN, 40, 25, 0);
  else neopixelWrite(RGB_PIN, 0, 25, 0);
}

void applyRelays() {
  uint8_t out = 0;
  if (mode == STEADY) out = maskA;
  else if (mode == FLASH) out = phase ? maskA : 0;
  else out = phase ? maskA : maskB;                // alt: A, then B, then A ...
  if (identifyUntil && millis() < identifyUntil) out = identifyMask;   // identify test overrides for a moment
  writeRelays(out);
}

void onEvent(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) { connected = true; Serial.println("service connected"); showStatus(); }
  else if (type == WStype_DISCONNECTED) { connected = false; Serial.println("service disconnected"); showStatus(); }
  else if (type == WStype_TEXT) {
    JsonDocument doc;
    if (deserializeJson(doc, payload, length)) return;
    const char* t = doc["t"] | "";
    if (!strcmp(t, "light")) {
      maskA = maskOf(doc["a"].as<JsonArrayConst>()); maskB = maskOf(doc["b"].as<JsonArrayConst>());
      const char* m = doc["m"] | "steady";
      mode = !strcmp(m, "flash") ? FLASH : !strcmp(m, "alt") ? ALT : STEADY;
      phase = true; lastPhase = millis(); lastState = millis();
      Serial.printf("light: A=%02x B=%02x mode=%s\n", maskA, maskB, m);
      applyRelays();
    } else if (!strcmp(t, "relay")) {
      int ch = doc["ch"] | 0; unsigned long ms = doc["ms"] | 3000;
      if (ch >= 1 && ch <= 6 && (doc["on"] | true)) { identifyMask = 1 << (ch - 1); identifyUntil = millis() + ms; Serial.printf("identify relay %d\n", ch); applyRelays(); }
    }
  }
}

/* ---------- first-time setup page (phone) ---------- */
String pageHtml(const String& note) {
  String opts; int n = WiFi.scanNetworks();
  for (int i = 0; i < n && i < 20; i++) opts += "<option value='" + WiFi.SSID(i) + "'>";
  return String("<!doctype html><meta name=viewport content='width=device-width,initial-scale=1'><title>Gluer light setup</title>"
    "<body style='font-family:sans-serif;max-width:420px;margin:20px auto;padding:0 14px'>"
    "<h2>Gluer light setup</h2>") + note +
    "<form method=POST action=/save>"
    "<p>Wi-Fi name<br><input name=s list=n style='width:100%;font-size:18px;padding:8px' required></p><datalist id=n>" + opts + "</datalist>"
    "<p>Wi-Fi password<br><input name=p type=text style='width:100%;font-size:18px;padding:8px'></p>"
    "<p>Light code (from the app: Settings, Alert light)<br><input name=c style='width:100%;font-size:18px;padding:8px;text-transform:uppercase' required></p>"
    "<p><button style='font-size:20px;padding:12px 24px'>Save</button></p></form>"
    "<p style='color:#555'>2.4 GHz Wi-Fi only.</p></body>";
}
void runSetupPortal() {
  Serial.println("setup mode: join Wi-Fi GluerLight-Setup");
  WiFi.mode(WIFI_AP); WiFi.softAP("GluerLight-Setup");
  dns.start(53, "*", WiFi.softAPIP());
  web.on("/save", HTTP_POST, []() {
    String s = web.arg("s"), p = web.arg("p"), c = web.arg("c");
    c.trim(); c.toLowerCase(); String clean; for (char ch : c) if (isalnum(ch)) clean += ch;
    if (s.length() == 0 || clean.length() < 8) { web.send(200, "text/html", pageHtml("<p style='color:#b00'>Please fill in the Wi-Fi name and a light code of at least 8 letters/numbers.</p>")); return; }
    prefs.begin("gluer", false); prefs.putString("ssid", s); prefs.putString("pass", p); prefs.putString("code", clean); prefs.end();
    web.send(200, "text/html", "<meta name=viewport content='width=device-width,initial-scale=1'><body style='font-family:sans-serif;margin:30px'><h2>Saved</h2><p>The board is restarting and will join your Wi-Fi. You can close this page.</p></body>");
    delay(1500); ESP.restart();
  });
  web.onNotFound([]() { web.send(200, "text/html", pageHtml("")); });
  web.begin();
  while (true) { dns.processNextRequest(); web.handleClient(); neopixelWrite(RGB_PIN, 30, 0, (millis() / 500) % 2 ? 30 : 0); delay(5); }   // purple blink = setup mode
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 6; i++) { pinMode(RELAY_PIN[i], OUTPUT); digitalWrite(RELAY_PIN[i], LOW); }   // everything off until the service says otherwise
  pinMode(BOOT_PIN, INPUT_PULLUP);
  prefs.begin("gluer", true); WIFI_SSID = prefs.getString("ssid", ""); WIFI_PASSWORD = prefs.getString("pass", ""); LIGHT_CODE = prefs.getString("code", ""); prefs.end();
  bool wantSetup = WIFI_SSID.length() == 0 || LIGHT_CODE.length() == 0;
  if (!wantSetup) { unsigned long t = millis(); while (millis() - t < 2500) { if (digitalRead(BOOT_PIN) == HIGH) break; delay(20); } wantSetup = digitalRead(BOOT_PIN) == LOW; }   // hold BOOT while powering on = set up again
  if (wantSetup) runSetupPortal();
  WiFi.mode(WIFI_STA); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID.c_str(), WIFI_PASSWORD.c_str());
  Serial.print("Wi-Fi");
  while (WiFi.status() != WL_CONNECTED) { delay(400); Serial.print("."); neopixelWrite(RGB_PIN, 0, 0, (millis() / 400) % 2 ? 40 : 0); }
  Serial.println(" connected: " + WiFi.localIP().toString());
  String path = String("/light?d=1&code=") + LIGHT_CODE;
  ws.beginSSL(HOST, 443, path.c_str());            // secure connection (wss)
  ws.onEvent(onEvent);
  ws.setReconnectInterval(3000);
  ws.enableHeartbeat(20000, 5000, 2);              // detect a dead connection and reconnect
  showStatus();
}

void loop() {
  ws.loop();
  unsigned long now = millis();
  if (connected && now - lastHb > 15000) { lastHb = now; ws.sendTXT("{\"t\":\"hb\"}"); }   // "I'm alive" for the app's status line
  if ((mode != STEADY) && now - lastPhase >= BLINK_MS) { lastPhase = now; phase = !phase; applyRelays(); }
  if (identifyUntil && now >= identifyUntil) { identifyUntil = 0; applyRelays(); }
  static unsigned long lastShow = 0; if (now - lastShow > 1000) { lastShow = now; showStatus(); }
}
