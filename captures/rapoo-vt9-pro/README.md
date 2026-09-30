# Rapoo VT9 Pro fixtures

Hardware reference material for `src/rapoo/` and `src/drivers/rapoo/`.

Captured from one Rapoo VT9 Pro (1st gen) on Windows on 2026-09-29, both on its
2.4 GHz receiver `0x24AE:0x1205` and on its cable `0x24AE:0x4405`. Both paths
enumerate as "Rapoo Gaming Device" and expose the same six collections:

| Usage page:usage | Reports (byte length as Windows reports it) |
|---|---|
| `0x000C:0x0001` | input 3 |
| `0x0001:0x0080` | input 2 |
| `0xFF00:0x000E` | input 32, output 32 - the `0xBA` configuration channel |
| `0xFF00:0x0002` | input 7, output 7 |
| `0xFF00:0x0002` | input 10, output 10 |
| `0xFF0B:0x0104` | input 61, output 61, feature 61 - the `0x2A` status block |

Those lengths are what `HidP_GetCaps` returns on Windows, and it counts the
report id byte. The report *data* is one byte shorter - 2 for the mouse
collection, 31 for the `0xBA` channel, 60 for the `0x2A` block - and 31 is the
number that matters to a transport: WebHID refuses 32 (`Failed to write the
report`), which is how the frame length was pinned down.

No personal data is included: nothing here carries a serial number, and the
logs are the tool's own output.

| File | What it is |
|---|---|
| `sweep-2026-09-29.txt` | The full transcript: the interface map, the read that first proved the channel works, the register sweep on the receiver and again on the cable, the connection-byte probe (five candidates, eight attempts each), the lossy-channel measurements, and an idempotent write of the bytes just read. |

The tests inline the verified blocks: `src/rapoo/index.test.ts` for the codec
and `src/drivers/rapoo/hid.test.ts` for the driver. See
`docs/rapoo-vt9-pro-testing.md` for the write-up, including the one rule that
matters most - never read feature report `0x2B`, which drops the link until the
cable is pulled.
