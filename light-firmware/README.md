# Gluer light controller (Waveshare ESP32-S3-Relay-6CH)

The firmware is already compiled and tested to build. Wi-Fi details are NOT typed into the code:

1. Load the program onto the board over USB-C (Claude can do this from the PC with arduino-cli:
   board `esp32:esp32:esp32s3:CDCOnBoot=cdc`, core esp32 2.0.17, libraries WebSockets + ArduinoJson).
2. Power the board. It opens its own Wi-Fi **GluerLight-Setup**. Join it from a phone, open `192.168.4.1`,
   type the Wi-Fi name, password and the light code (app: Settings -> Alert light), tap Save.
3. The board restarts and joins your 2.4 GHz Wi-Fi. To set it up again, hold **BOOT** while powering it on.

Board LED: purple blink = setup mode, blue = no Wi-Fi, yellow = Wi-Fi but no light service, green = connected.
