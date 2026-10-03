# Fater MCR-9000B (Holtek 04d9:a09f)

Requested in OpenMouse-Project/openmouse#394. No capture of this mouse
exists yet; the driver is read-only until one does.

## What the owner reported

- VID `0x04d9` (Holtek), PID `0xa09f`, bcdDevice `0x0302`, manufacturer
  string "E-Signal", product string "USB Gaming Mouse".
- Interface 0: boot mouse. Interface 1: keyboard, consumer, system control.
- Interface 2: usage page `0xFF00`, usage `0xFF00`, a 33-byte output report
  (32 data bytes) and a 9-byte feature report (8 data bytes), descriptor 28
  bytes. Only the OUT endpoint was listed; no input report is declared.
- Vendor app: "Fater MCR-9000B Gaming Mouse.zip" from dl.faterco.ir
  (461 MB, not inspected). Manual lists DPI 1000 to 12400 in six steps,
  polling rate and response time settings, ARGB lighting, macros.

## Where the frame comes from

The 8-byte feature report plus 32-byte output report is the shape of the
Holtek OEM protocol that `pbludov/hv-ms735-config` drives on the HAVIT MS735
(`04d9:a100`) and that the HP G360 tool (`12c9:1027`) uses:

- byte 0 is the command, bit 7 set makes it a read, byte 7 is
  `0xFF - sum(bytes 0..6)`.
- A read is `SET_FEATURE` followed by `GET_FEATURE`; the reply echoes the
  command byte and carries the value at offset 2.
- `0x82` blink/ping, `0x83`/`0x03` polling divider (1000 Hz / n),
  `0x84`/`0x04` active profile (1 to 8).
- `0x8C`/`0x0C` control page and `0x8D`/`0x0D` button page are 128-byte
  blocks (DPI table at offsets 84 and 92, dpi = (byte + 1) * 100 on the
  MS735) read over interrupt IN and written as 32-byte output reports. The
  MCR-9000B declares no input report, so WebHID on Windows cannot read
  them; the vendor app may use a different read path.

The MS735 DPI encoding tops out at 12000, while the MCR-9000B advertises
12400, so even the page layout is likely to differ. Treat every command
above as a hypothesis for this mouse.

## To finish

1. Owner connects in Chrome and reports whether the status shows a polling
   rate (proves the frame and the GET echo).
2. Owner records a USBPcap capture per the app's `docs/usb-capture-guide.md`
   while changing polling rate, DPI, and one profile in the vendor app.
3. Add the writes (same frame without bit 7) and decode the DPI path from
   the capture.
