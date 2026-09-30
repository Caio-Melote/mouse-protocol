# Noir Gear M2-NEX integration note

This note records the evidence and remaining checks for the M2-NEX support
implemented on top of the shared K-snake control protocol. It is intentionally
separate from the K-snake X11 entry because the transport is shared but the
retail identity and exposed feature set are not.

## Identity and connection paths

The M2-NEX reports the following WebHID control collection:

| Path | VID | PID | Usage page | Usage |
| --- | ---: | ---: | ---: | ---: |
| USB | `0xA8A4` | `0x2255` | `0xFF01` | `0x10` |
| 2.4 GHz receiver | `0xA8A5` | `0x2255` | `0xFF01` | `0x10` |

The product descriptor reports `M2-NEX`. The driver uses that descriptor to
label the device as `Noir Gear` while keeping the shared K-snake transport
matcher unchanged. If the descriptor is absent or reports another model, the
device remains identified as K-snake X11 rather than being guessed as M2-NEX.

Bluetooth is not claimed by this integration. Neither the vendor configurator
nor the observed M2-NEX control collection provides a verified Bluetooth path.

## Observed hardware evidence

The local integration session exercised an owned retail M2-NEX and its 2.4 GHz
receiver. The observed firmware string was `2.1.7`. Read-only status, battery,
configuration, DPI stages, active DPI stage, polling rate, and the button map
were decoded successfully. DPI and polling writes were followed by a read-back
check on the receiver path.

The vendor configuration layout observed on the device is:

- six fixed DPI stages: `800`, `1200`, `1600`, `3200`, `5000`, `12000`;
- polling rates: `125`, `250`, `500`, and `1000 Hz`;
- auto-sleep choices from one minute through one hour;
- forward/reverse scroll direction;
- seven user-facing button slots, with an additional fixed wire slot kept
  opaque by the driver;
- 32 macro slots backed by a 4096-byte macro area.

## Deliberate safety boundaries

- The device returned `0xFF` for the lift-off field during the M2-NEX capture.
  The driver treats that value as unknown and does not expose or write LOD.
- Some M2-NEX descriptors do not advertise the optional macro-read report.
  The application therefore starts with a blank local macro table and writes a
  complete table on save instead of pretending that an onboard read succeeded.
- Profiles in the OpenMouse application are browser-local configuration slots.
  They are not advertised as hardware profile banks and are applied explicitly
  by the user.
- The protocol can frame the vendor lighting modes, but the M2-NEX application
  surface currently hides lighting until the command is independently verified
  on the target hardware.

## Before opening the pull requests

A maintainer should repeat and record the following on both USB and 2.4 GHz:

1. connect, read status, and reconnect;
2. change one DPI stage and the active stage, then confirm after reconnect;
3. change polling rate, sleep timeout, and scroll direction, then confirm after
   reconnect;
4. remap one button and restore its default function;
5. record a short macro, save it, assign it to a button, and confirm the
   behavior after reconnect;
6. confirm that Bluetooth is correctly left unsupported.

Only the hardware-tested paths should be marked verified in the driver or in
the pull-request description. Do not add vendor binaries, firmware, captures
with identifiers, or the local vendor artwork to the protocol pull request.
