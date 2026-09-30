# Rapoo VT9 Pro (1st gen) protocol

Two independent sources describe the same channel, and they agree byte for
byte:

- a capture of a real **VT9 Pro (1st gen)** on 2026-09-29, on its 2.4 GHz
  receiver (`0x24AE:0x1205`) and again on the cable (`0x24AE:0x4405`). The raw
  text is in `captures/rapoo-vt9-pro/sweep-2026-09-29.txt`;
- mousectl's `rapoo_vt3pro` driver, reverse engineered from Rapoo's own
  `RapooGameDevDriver` **1.6.29** - the same installer build the capture was
  taken with. It documents the same frame and the same offsets for the VT3 PRO.
  `rapoo-software-linux`'s `PROTOCOL.md`, taken from A HUB 1.0.19, describes a
  third Rapoo generation whose addresses line up with these after subtracting
  the profile-0 base of `0x600`.

Everything below is **measured** on that one mouse unless it says otherwise.

## Transport

The configuration channel is the `0xFF00:0x000E` collection: a 31-byte output
report `0xBA` in both directions (`HidP_GetCaps` calls it 32 because it counts
the report id; the report *data* is what the transport is handed, and that is
31). The answer does **not** arrive as an
interrupt-IN report - it is fetched with `GET_REPORT(Input)`, which is
`HidD_GetInputReport` on Windows, `HIDIOCGINPUT` on Linux hidraw, and
`receiveInputReport` in OpenMouse Bridge.

That single detail explains the earlier impression that this mouse had no
readable protocol: **WebHID has no `GET_REPORT(Input)`**, so from a browser
every frame is delivered, the answer is dropped by the browser, and the read
looks like a timeout. Nothing about the device is broken.

```
request  [0] connection byte   [1] command   [2] payload length
         [3..6] address, u32 little endian   [7..] data

answer   [0] status, 0x01 when answered   [1] 0 for a block, non-zero for battery
         [2] battery percentage on a battery answer   [4..] the block
```

Windows strips the report id from the buffer it returns and Linux hidraw keeps
it, so every consumer has to accept both - mousectl does, and so does this
repository.

Commands: `0xA4` read, `0xA5` write, `0xAA` battery. The connection byte is
*not* validated: `0xFF` and `0xA5` both answered, as did `0x00`, `0x01` and
`0x5A` (8 attempts each, 2-4 answered). A dropped frame therefore never means
"wrong connection type".

## Register map

Profile 0's base of `0x600` plus the offsets the vendor driver reads. The two
links returned identical bytes.

| Address | Bytes | Meaning |
|---|---|---|
| `0x880` | `82 00 82 ff` | polling rate: `[0]` on 2.4 GHz, `[2]` on the cable, both `0x82` = 4000 Hz |
| `0x884` | `01 01 01 00` | `[0]` lift-off selector = 1, `[1]` motion sync = on |
| `0x888` | `90 01 20 03 b0 04 40 06 80 0c 00 19 90 65 02 00` | seven little-endian DPI stages = 400/800/1200/1600/3200/6400/26000, `[14]` = 2 |
| `0x898` | `01 00 02 01` | active stage index 1 (0 based) |
| `0x8C0` | `04 04 78 03` | press/release debounce index 4 = 16 ms, sleep 120 min, flags `0x03` |
| `0x8C4` | `00 00 01 00` | sensor angle 0 degrees |
| `0x8C8` | same as `0x888` | DPI Y, byte-identical to X in both runs |

Polling-rate codes, from the vendor driver's own switch table and confirmed
against `0x880`: `0x08` 125, `0x04` 250, `0x02` 500, `0x01` 1000, `0x84` 2000,
`0x82` 4000, `0x81` 8000. The VT3 PRO profile has `support8k = false`, and the
highest rate this mouse was seen offering is 4000 Hz.

Debounce is stored as an index into `[1, 2, 4, 8, 16, 24, 32]` ms. The flag
byte at `0x8C0[3]` holds *disable* flags: bit 0 set means angle snap is off,
bit 1 set means ripple control is off.

## Battery

Two independent readings, both confirmed at 98% on a fully charged mouse:

- the `0xAA` answer, `01 01 62 ...` - byte 1 is the charge marker (1
  discharging, 2 charging, per the vendor driver's table) and byte 2 the
  percentage. It does not follow the busy -> OK handshake, because the value is
  already sitting in the device's input buffer;
- the `0x2A` **feature** report on `0xFF0B:0x0104`, `2a 01 00 00 04 21 50 00 00 62`
  on the cable and `2a 01 00 00 04 11 20 00 00 62` on the receiver - the two
  links differ at byte 5, and byte 9 of the report data is the percentage. This
  one is readable from a browser, because `receiveFeatureReport` does exist in
  WebHID.

The mouse also pushes input report `0xBB` unprompted about every 3 seconds:
`b0 51 20 03 01 62`. Byte 4 was `0x01` on the receiver in every observation and
byte 5 tracks the percentage (`62` at 98%, `64` at 100%). The report stopped
entirely while the mouse was idle and resumed when it was moved.

## What the link is like

Three properties were measured rather than assumed, and each one had already
misled a reading taken without it:

- **the channel is lossy.** Roughly 40% of frames are dropped without the
  device ever going busy. Five back-to-back reads of one register returned 1/5
  and 0/5 in two runs, and the sweep immediately after read every address.
  "No answer" is not "no such register";
- **an OK only counts after a busy.** The input buffer holds the previous
  command's answer until the receiver picks the new frame up, so an OK that was
  not preceded by a busy is stale data. The handshake is: status other than
  `0x01` (busy) first, then `0x01` with fresh bytes, and a frame that produced
  no busy within 120 ms was dropped and is sent again. Four rounds of four
  sends, with 120 ms between rounds, read the whole map on four of four runs;
- **an idle mouse stops answering `0xBA` entirely**, while the `0x2A` feature
  read keeps returning the status block. Move the mouse and the channel comes
  back.

Reading feature report **`0x2B` disconnects the mouse** until the cable is
pulled and re-inserted. It is never read by this driver, and anything built on
this protocol should keep it that way.

With the cable in, Windows keeps *both* devices present - twelve HID
collections, six for each product id, with an identical layout - and the cable
takes the channel over: once it is attached, the receiver stops answering
`0xBA`.

## Not established

- the scale the lift-off selector indexes. The vendor bundle carries both a
  1.0-2.0 mm and a 0.7-1.7 mm ladder, so this repository reads the code and
  makes no Low/Medium/High claim;
- whether any Rapoo in this family offers 8000 Hz. The code decodes `0x81`, but
  nothing offers it as a choice;
- the DPI floor and ceiling as the vendor tool enforces them - only the seven
  values this mouse stores were read;
- the meaning of `0x880[1]` and `[3]`, `0x884[2..3]`, `0x8C4[1..3]`,
  `0x898[1..3]`, the `0x888[15]` byte that follows the stage count, the `0x2A`
  block beyond its battery byte, and `0xBB` bytes 2 and 3. All of them are
  preserved untouched by the codec rather than interpreted;
- whether a write survives unplugging the mouse. Writes work - an idempotent
  write of the bytes just read was accepted with the same busy -> OK handshake
  and read back unchanged - but no setting has been changed and re-read across
  a power cycle.

## What this repository implements

`src/rapoo/` is the transport-independent codec: frame encoding, answer and
block decoding, and the register tables above. `src/drivers/rapoo/hid.ts` is
read-only, and has two shapes on purpose:

- in a plain browser it reports the battery from the `0x2A` feature block and
  says plainly that the rest needs a native transport;
- with `receiveInputReport` available it walks the register map and reports
  DPI, polling rate, motion sync, debounce, sleep and the sensor flags as
  verified values.

Nothing writes yet. This is a block read-modify-write protocol with no partial
update, so a setter has to read a block, edit the decoded object, write it back
and read it again - which needs the same `receiveInputReport` the reads need.

## Re-verifying

On Windows, `HidD_GetInputReport` on the `0xFF00:0x000E` handle; on Linux,
`HIDIOCGINPUT` on the hidraw node, for example with mousectl's own driver,
which speaks the same protocol to the VT3 PRO. Send
`A5 A4 04 80 08 00 00` + 24 zero bytes as output report `0xBA`, poll the input
report for a status other than `0x01` followed by `0x01`, and expect
`82 00 82 ff` from byte 4 on. The capture in `captures/rapoo-vt9-pro/` is the
full transcript of that, on both links, including the register sweep and the
idempotent write.
