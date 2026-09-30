# Redragon Predator M612 (`04d9:fc61`) captures

- `rdcfg-startup-push.hex`: the 114 config frames RDCfg 1.0.58 sent when it
  started (usbmon, Wine), one `SET_FEATURE` payload per line, report id
  first. It writes the LED block, opens a session (`02 f5 00`), writes
  settings, then the five-profile DPI tables and button maps, the commit
  block (`02 f1 02 ..`), and closes (`02 f5 01`). The one 64-byte line is
  report 3.
- `openmouse-hardware-test.json`: OpenMouse's built-in hardware test on the
  same unit, using the local package build.

Decoding and verification notes: `docs/redragon-m612-testing.md`.
