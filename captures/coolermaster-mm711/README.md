# Cooler Master MM711 captures

Hardware reference material for the Cooler Master MM711 wired gaming mouse in
`src/coolermaster/` and `src/drivers/coolermaster/`.

Captured directly from a physical Cooler Master MM711 on Windows (hidraw / Win32 HID handle)
on 2026-10-02:
- Vendor ID: `0x2516` (Cooler Master Technology Inc.)
- Product ID: `0x0101` (MasterMouse MM711)
- Interface: `MI_01` (Usage Page `0xFF00`, Usage `0x0001`)
- Report ID: `0x00`
- Report Length: 65 bytes (1 byte Report ID `0x00` + 64-byte payload)

## Files

| File | What it is |
|---|---|
| `handshake.hex` | Init / wakeup sequence `0x41 0x80` and the device's echo reply. |
| `get-dpi-level.hex` | Read active DPI stage mapping (`0x52 0x9B`), stage order and active slot. |
| `get-performance.hex` | Read performance block (`0x52 0x40`), returning 7 DPI presets for X and Y, angle snapping, lift-off distance, angle tuning, and sensor threshold parameters. |
| `get-polling.hex` | Read polling rate (`0x52 0xF0`), returning `0x01` (1000 Hz). |
| `get-debounce.hex` | Read button response / debounce time (`0x52 0x10`), returning `0x05` (5 ms). |
| `set-polling.hex` | Write polling rate command (`0x51 0xF0`) and read confirmation echo. |

## Protocol Summary

- **Handshake / Wakeup**: `0x41, 0x80`
- **Read Prefix**: `0x52` ('R')
  - `0x52, 0x40`: Performance / DPI table
  - `0x52, 0x9B`: Active DPI level
  - `0x52, 0xF0`: Polling rate
  - `0x52, 0x10`: Button response time (debounce)
- **Write Prefix**: `0x51` ('Q')
  - `0x51, 0x40`: Performance / DPI settings
  - `0x51, 0x9B`: Active DPI level table
  - `0x51, 0xF0`: Polling rate
  - `0x51, 0x10`: Button response time (debounce)
- **DPI Encoding**:
  - `DPI = (raw_byte + 1) * 100` (from 100 to 16,000 DPI in 100 DPI steps)
  - Raw value for 400 DPI = `0x03`, 800 DPI = `0x07`, 1200 DPI = `0x0B`, 1600 DPI = `0x0F`, 3200 DPI = `0x1F`, 6400 DPI = `0x3F`, 16000 DPI = `0x9F`
- **Polling Rate Codes**:
  - `1` = 1000 Hz (1 ms)
  - `2` = 500 Hz (2 ms)
  - `4` = 250 Hz (4 ms)
  - `8` = 125 Hz (8 ms)
- **Lift-off Distance (LOD)**:
  - `0` (bit mask `(byte & 6) != 6`) = Low LOD (~2 mm)
  - `1` (bit mask `(byte & 6) == 6`) = High LOD (~3 mm)
- **Angle Snapping**:
  - `0` = Disabled
  - `1` = Enabled
- **Angle Tuning**:
  - Signed byte in degrees (-30 to +30)
- **Debounce Time**:
  - Integer in milliseconds (e.g. 4 ms to 32 ms)
