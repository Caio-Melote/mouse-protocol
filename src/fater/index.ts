/**
 * Fater MCR-9000B (`04d9:a09f`): a Holtek "E-Signal" OEM mouse.
 *
 * Framing comes from two independent decodes of the same OEM firmware
 * family, not from a capture of this mouse:
 *
 * - pbludov/hv-ms735-config (GPL-2.0), a working Linux/Windows driver for the
 *   HAVIT MS735 (`04d9:a100`): 8-byte unnumbered feature report, byte 0 is a
 *   command, bit 7 set turns a command into a GET, byte 7 is a checksum.
 * - The HP G360 (`12c9:1027`) vendor tool, decoded statically from its
 *   installer, which uses the identical frame and checksum.
 *
 * The MCR-9000B's vendor interface (usage page 0xFF00) declares exactly that
 * 8-byte feature report plus a 32-byte output report, so the frame fits.
 * Everything below is unverified on this mouse until a hardware test.
 *
 * Settings that need the 128-byte config pages (DPI table, buttons, lights)
 * arrive as raw interrupt-IN data with no input report declared, which WebHID
 * on Windows never delivers, so they stay out until a capture shows another
 * path.
 */

export const FATER_VENDOR_ID = 0x04d9; // Holtek Semiconductor
export const FATER_MCR_9000B_PRODUCT_ID = 0xa09f;
export const FATER_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [FATER_MCR_9000B_PRODUCT_ID, "Fater MCR-9000B"],
]);
export const FATER_PRODUCT_IDS: readonly number[] = [...FATER_PRODUCT_NAMES.keys()];

/** Vendor collection on USB interface 2 (reported by the MCR-9000B's owner). */
export const FATER_CONFIG_USAGE_PAGE = 0xff00;
export const FATER_CONFIG_USAGE = 0xff00;
/** The feature report is unnumbered. */
export const FATER_REPORT_ID = 0;
/** Payload bytes after the report id. */
export const FATER_COMMAND_SIZE = 8;

/** Command byte with this bit set reads the value instead of writing it. */
export const FATER_GET_FLAG = 0x80;
export const FATER_CMD = {
  /** Replies with its own command byte and nothing else; the liveness probe. */
  blink: 0x02,
  /** Polling divider: 1000 Hz divided by the byte at offset 2. */
  reportRateDivider: 0x03,
  /** Active onboard profile, 1-based, at offset 2. */
  profile: 0x04,
} as const;

export const FATER_PROFILE_COUNT = 8;
/** Dividers 1, 2, 4, 8 of the 1000 Hz base rate. */
export const FATER_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

/** Byte 7 is 0xFF minus the sum of bytes 0..6, modulo 256. */
export function faterChecksum(payload: Uint8Array): number {
  let sum = 0xff;
  for (let i = 0; i < FATER_COMMAND_SIZE - 1; i += 1) sum -= payload[i] ?? 0;
  return sum & 0xff;
}

/** 8-byte feature payload: command, up to six argument bytes, checksum. */
export function faterEncodeCommand(command: number, args: readonly number[] = []): Uint8Array<ArrayBuffer> {
  if (args.length > FATER_COMMAND_SIZE - 2) throw new RangeError("Fater commands carry at most six argument bytes.");
  const payload = new Uint8Array(FATER_COMMAND_SIZE);
  payload[0] = command & 0xff;
  args.forEach((value, i) => { payload[i + 1] = value & 0xff; });
  payload[FATER_COMMAND_SIZE - 1] = faterChecksum(payload);
  return payload;
}

export function faterEncodeGet(command: number): Uint8Array<ArrayBuffer> {
  return faterEncodeCommand(command | FATER_GET_FLAG);
}

/**
 * The 8-byte payload of a reply that echoes `command` in its first byte, or
 * null. Accepts the reply with or without a leading report-id byte, since
 * WebHID implementations differ on whether unnumbered reports carry one.
 */
export function faterDecodeReply(reply: Uint8Array, command: number): Uint8Array | null {
  const body = reply.length > FATER_COMMAND_SIZE && reply[0] === FATER_REPORT_ID ? reply.subarray(1) : reply;
  if (body.length < FATER_COMMAND_SIZE || body[0] !== (command & 0xff)) return null;
  return body.subarray(0, FATER_COMMAND_SIZE);
}

/** Polling rate in Hz for a divider byte; null for the 0 the firmware never sends. */
export function faterDividerToHz(divider: number): number | null {
  return divider > 0 ? Math.round(1000 / divider) : null;
}

export function faterHzToDivider(hz: number): number {
  const divider = 1000 / hz;
  if (!Number.isInteger(divider) || divider < 1 || divider > 0xff) throw new RangeError(`Fater mice cannot poll at ${hz} Hz.`);
  return divider;
}

/** Divider or profile replies carry the value at offset 2 (byte 1 is a zero pad). */
export function faterDecodeValue(reply: Uint8Array, command: number): number | null {
  const body = faterDecodeReply(reply, command | FATER_GET_FLAG);
  return body ? body[2]! : null;
}
