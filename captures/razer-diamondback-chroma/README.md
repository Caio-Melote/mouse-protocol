# Razer Diamondback Chroma (`1532:004c`) hardware report, 2026-09-30

Reporter's own mouse, firmware "Mouse 1.0", wired, Windows. Connected through
OpenMouse Bridge with an unmodified `RazerHidClient`; the Bridge listed seven
HID paths for the device and opened all of them.

- `hardware-test-2026-09-30.json`: the app's hardware test export. Identity,
  firmware, DPI (1800) and polling (500 Hz) read back; 800 DPI and 1000 Hz each
  wrote, read back and were restored. Verdict: pass.

What it does not settle:

- Polling was read back but not measured: the sampler averaged 305 Hz against
  the reported 500 Hz and flagged dropouts, so it skipped rather than failed.
- The DPI stage read (`0x04`/`0x86`) gave nothing usable, so no stage editor
  is offered on this model.
- No raw feature reports were captured in this session.
