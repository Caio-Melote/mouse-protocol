/**
 * K-snake X11 configuration protocol, reverse-engineered from the vendor
 * WebHID panel shipped at https://x1a11.yjx2012.com/ (Next.js `app/page` chunk).
 *
 * Transport: WebHID output report (`sendReport(0, 64 bytes starting with
 * 0x55)`) with the reply arriving as a queued `inputreport` — not a feature
 * report. Control collection is usage page 0xFF01, usage 0x10; the vendor
 * picker requests:
 *   [{ vendorId: 0xA8A4, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 },
 *    { vendorId: 0xA8A5, productId: 0x2255, usagePage: 0xFF01, usage: 0x10 }]
 * 0xA8A4 reports "USB", 0xA8A5 is the 2.4 GHz dongle.
 *
 * This module is transport-independent: it only builds 64-byte report bodies
 * and decodes reply buffers. See `src/drivers/ksnake/hid.ts` for the WebHID
 * exchange queue.
 */

export const KSNAKE_USB_VENDOR_ID = 0xa8a4;
export const KSNAKE_DONGLE_VENDOR_ID = 0xa8a5;
export const KSNAKE_PRODUCT_ID = 0x2255;
export const KSNAKE_USAGE_PAGE = 0xff01;
export const KSNAKE_USAGE = 0x10;

/**
 * Noir's M2-NEX is an OEM rebrand of the same control protocol used by the
 * K-snake X11. The USB and 2.4 GHz transports keep the same PID, so the
 * product descriptor is the only safe way to give the UI the retail identity.
 */
export const NOIR_M2_NEX_BRAND = "Noir Gear" as const;
export const NOIR_M2_NEX_MODEL = "M2-NEX" as const;

export function isNoirM2NexDevice(device: { productName?: string | null }): boolean {
  const compactName = (device.productName ?? "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  return compactName === "m2nex";
}

export const KSNAKE_REPORT_ID = 0x00;
export const KSNAKE_MAGIC = 0x55;
export const KSNAKE_REPORT_SIZE = 64;

/** DPI range. Vendor panel slider allows 200–12000 (step 100); the manual's
 *  factory steps are 800–12000 and 600 was observed in stage 0 on retail
 *  hardware (user-customized via the vendor panel). */
export const KSNAKE_DPI_MIN = 200;
export const KSNAKE_DPI_MAX = 12000;

export function ksnakeIsValidDpi(dpi: number): boolean {
  return Number.isInteger(dpi) && dpi >= KSNAKE_DPI_MIN && dpi <= KSNAKE_DPI_MAX;
}

export interface KsnakeProduct {
  model: string;
  wireless: boolean;
  /** Not yet exercised on hardware through this driver. */
  verified: false;
}

export const KSNAKE_PRODUCTS: ReadonlyMap<number, KsnakeProduct> = new Map([
  [KSNAKE_PRODUCT_ID, { model: "X11", wireless: true, verified: false }],
]);

const CMD = {
  GET_VERSION: 0x03,
  GET_KEYS: 0x08,
  SET_KEYS: 0x09,
  GET_CONFIG: 0x0e,
  SET_CONFIG: 0x0f,
  SET_LIGHT: 0x21,
  GET_BATTERY: 0x30,
} as const;

/** The vendor stores two 2 KiB macro profiles in one 4096-byte address space. */
export const KSNAKE_MACRO_REPORT_ID = 0x06;
export const KSNAKE_MACRO_SLOT_COUNT = 32;
export const KSNAKE_MACRO_BYTES = 4096;
export const KSNAKE_MACRO_CHUNK_BYTES = 56;
export const KSNAKE_MACRO_POINTER_BYTES = KSNAKE_MACRO_SLOT_COUNT * 2;
/** Pointer table (64 bytes) plus the vendor's four-byte profile marker. */
export const KSNAKE_MACRO_HEADER_BYTES = KSNAKE_MACRO_POINTER_BYTES + 4;

const GET_CONFIG_TAIL = [0xa5, 0x0b, 0x2f, 0x01, 0x01, 0x00, 0x00, 0x00] as const;
const SET_CONFIG_HEAD = [0xae, 0x0a, 0x2f, 0x01, 0x01, 0x00, 0x00] as const;
const GET_BATTERY_TAIL = [0xa5, 0x0b, 0x2e, 0x01, 0x01, 0x00, 0x00, 0x00] as const;

/**
 * Polling-rate index ↔ Hz.
 * Endpoints confirmed by the X11 user manual: 1000 Hz in 2.4G/wired,
 * 125 Hz in BT. Middle steps (250/500) come from the vendor panel screenshot
 * + PAW3311 spec — keep until a hardware capture says otherwise.
 * Default index 3 = 1000 Hz.
 */
export const KSNAKE_POLLING_RATES = [125, 250, 500, 1000] as const;

/** Auto-sleep choices exposed by the M2-NEX vendor panel, in seconds. */
export const KSNAKE_SLEEP_OPTIONS = [60, 180, 300, 600, 1200, 1800, 3600] as const;

/** Lighting effects exposed by the M2-NEX vendor panel (value -> label). */
export const KSNAKE_LIGHT_MODE_LABELS = [
  "Off",
  "Wave",
  "Neon",
  "Cycling Flash",
  "YOYO Ball",
  "Single Flash",
  "Breathing Loop",
] as const;
export type KsnakeLightMode = typeof KSNAKE_LIGHT_MODE_LABELS[number];

export function ksnakeDecodeLightMode(value: number): KsnakeLightMode | null {
  return Number.isInteger(value) && value >= 0 && value < KSNAKE_LIGHT_MODE_LABELS.length
    ? KSNAKE_LIGHT_MODE_LABELS[value]
    : null;
}

export function ksnakeEncodeLightMode(mode: string): number | null {
  const value = KSNAKE_LIGHT_MODE_LABELS.indexOf(mode as KsnakeLightMode);
  return value < 0 ? null : value;
}

export function ksnakeEncodePollingRate(hz: number): number | null {
  const index = (KSNAKE_POLLING_RATES as readonly number[]).indexOf(hz);
  return index === -1 ? null : index;
}

export function ksnakeDecodePollingRate(index: number): number | null {
  return index >= 0 && index < KSNAKE_POLLING_RATES.length ? KSNAKE_POLLING_RATES[index] : null;
}

/**
 * Lift-off mapping. The vendor panel offers two stops (lod_value 1/2,
 * default 1, likely 1mm/2mm on the PAW3311); they map to the Low/High stops.
 * Medium is not offered by the hardware.
 */
export function ksnakeDecodeLiftOff(value: number): "Low" | "High" | null {
  if (value === 1) return "Low";
  if (value === 2) return "High";
  return null;
}

export function ksnakeEncodeLiftOff(level: string): number | null {
  if (level === "Low") return 1;
  if (level === "High") return 2;
  return null;
}

export const KSNAKE_DEFAULT_CONFIG = {
  lightMode: 2,
  reportRate: 3,
  dpiIndex: 2,
  // Hardware reports 6 (retail 2.4 GHz dongle, FW 2.1.7).
  dpiCount: 6,
  stages: [800, 1200, 1600, 3200, 5000, 12000],
  scrollFlag: 0,
  lodValue: 1,
  sensorFlag: 53,
  keyRespond: 2,
  sleepLight: 10,
  highspeedMode: 0,
  wakeupFlag: 1,
  moveLightFlag: 1,
} as const;

export interface KsnakeConfig {
  lightMode: number;
  /** 0-based index into KSNAKE_POLLING_RATES */
  reportRate: number;
  /** 0-based active DPI stage */
  dpiIndex: number;
  /** number of enabled DPI stages */
  dpiCount: number;
  /** up to 6 LE uint16 DPI stages */
  stages: number[];
  scrollFlag: number;
  lodValue: number;
  sensorFlag: number;
  keyRespond: number;
  sleepLight: number;
  highspeedMode: number;
  wakeupFlag: number;
  moveLightFlag: number;
}

function le16(lo: number, hi: number): number {
  return ((hi & 0xff) << 8) | (lo & 0xff);
}

/** 64-byte output-report body (without the reportId prefix). */
export function ksnakeGetVersionRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_VERSION;
  return buf;
}

/** Vendor reply bytes [23..25] hold ASCII "x.y.z" when present. */
export function ksnakeDecodeVersion(reply: Uint8Array): string | null {
  if (reply.length < 26) return null;
  const digit = (b: number): string | null => (b >= 48 && b <= 57 ? String.fromCharCode(b) : null);
  const major = digit(reply[23]);
  const minor = digit(reply[24]);
  const patch = digit(reply[25]);
  if (major === null || minor === null || patch === null) return null;
  return `${major}.${minor}.${patch}`;
}

export function ksnakeGetBatteryRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_BATTERY;
  GET_BATTERY_TAIL.forEach((b, i) => {
    buf[2 + i] = b;
  });
  return buf;
}

/** Immediate lighting-effect command used by the vendor panel. */
export function ksnakeEncodeSetLightMode(mode: number): Uint8Array {
  if (!Number.isInteger(mode) || mode < 0 || mode >= KSNAKE_LIGHT_MODE_LABELS.length) {
    throw new RangeError(`Lighting mode must be between 0 and ${KSNAKE_LIGHT_MODE_LABELS.length - 1}.`);
  }
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  // The vendor request includes report id 0 before this body. After WebHID
  // strips it, the mode lands at body[10] (vendor array index 11).
  buf.set([KSNAKE_MAGIC, CMD.SET_LIGHT, 0, 0, 3, 0, 0, 0, 0, 0, mode], 0);
  return buf;
}

export function ksnakeDecodeBattery(reply: Uint8Array): { percent: number; charging: number } | null {
  if (reply.length < 10) return null;
  return { percent: reply[8] & 0xff, charging: reply[9] & 0xff };
}

export function ksnakeGetConfigRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_CONFIG;
  GET_CONFIG_TAIL.forEach((b, i) => {
    buf[2 + i] = b;
  });
  return buf;
}

/** Decode a getConfig reply, mirroring the vendor `getMouseConfigInfo()`. */
export function ksnakeDecodeConfig(reply: Uint8Array): KsnakeConfig | null {
  if (reply.length < 56) return null;
  const blank = reply[13] === 0 && reply[14] === 0 && reply[15] === 0;
  const erased = reply[13] === 255 && reply[14] === 255 && reply[15] === 255;
  if (blank || erased) {
    return { ...KSNAKE_DEFAULT_CONFIG, stages: [...KSNAKE_DEFAULT_CONFIG.stages] };
  }
  return {
    lightMode: reply[9],
    reportRate: reply[10] - 1,
    dpiIndex: reply[12] - 1,
    dpiCount: reply[11],
    stages: [
      le16(reply[13], reply[14]),
      le16(reply[15], reply[16]),
      le16(reply[17], reply[18]),
      le16(reply[19], reply[20]),
      le16(reply[21], reply[22]),
      le16(reply[23], reply[24]),
    ],
    scrollFlag: reply[48],
    lodValue: reply[49],
    sensorFlag: reply[50],
    keyRespond: reply[51],
    sleepLight: reply[52],
    highspeedMode: reply[53],
    // NOTE: the vendor panel itself is asymmetric here — its decode reads
    // wakeup from the LOW nibble (`15 & t[55]`) but its encode writes
    // `wakeup << 4 | move`. This codec mirrors the vendor byte-for-byte, so
    // states round-trip exactly like the vendor panel does.
    wakeupFlag: reply[55] & 15,
    moveLightFlag: (reply[55] >> 4) & 15,
  };
}

/** Encode a setConfig request, mirroring vendor `setMouseConfigData()`. */
export function ksnakeEncodeSetConfig(config: KsnakeConfig): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.SET_CONFIG;
  SET_CONFIG_HEAD.forEach((b, i) => {
    buf[2 + i] = b;
  });
  buf[9] = config.lightMode & 0xff;
  buf[10] = (config.reportRate + 1) & 0xff;
  buf[11] = config.dpiCount & 0xff;
  buf[12] = (config.dpiIndex + 1) & 0xff;
  const stages = [...config.stages];
  while (stages.length < 6) stages.push(0);
  for (let i = 0; i < 6; i++) {
    buf[13 + i * 2] = stages[i] & 0xff;
    buf[14 + i * 2] = (stages[i] >> 8) & 0xff;
  }
  buf[48] = config.scrollFlag & 0xff;
  buf[49] = config.lodValue & 0xff;
  buf[50] = config.sensorFlag & 0xff;
  buf[51] = config.keyRespond & 0xff;
  buf[52] = config.sleepLight & 0xff;
  buf[53] = config.highspeedMode & 0xff;
  buf[54] = ((config.wakeupFlag << 4) | (config.moveLightFlag & 15)) & 0xff;
  return buf;
}

/**
 * User-visible physical controls in the order used by the shared OpenMouse
 * button card. The DPI button is intentionally absent: the vendor firmware
 * exposes it as a fixed slot between Forward/Backward and the wheel actions.
 */
export const KSNAKE_BUTTON_NAMES = ["Left", "Right", "Middle", "Forward", "Backward", "Scroll up", "Scroll down"] as const;

/** Wire slots for the user-visible controls. Slot 5 is the fixed DPI button. */
export const KSNAKE_BUTTON_WIRE_INDICES = [0, 1, 2, 4, 3, 6, 7] as const;

const KSNAKE_FIXED_DPI_BINDING = { type: 33, code1: 85, code2: 0, code3: 0 } as const;

/** Button function types from the vendor key catalog. */
export const KSNAKE_KEY_TYPE = {
  keyboard: 16,
  mouse: 32,
  special: 33,
  media: 48,
  macro: 112,
  control: 240,
} as const;

/** One button slot: type 32 = mouse button (code1 = HID bitmask, 0 = disabled),
 *  16 = keyboard usage (code1 = modifier bits, code2 = HID usage), 33 =
 * special (DPI loop [85,0,0], scroll [56,1/255]), 48 = consumer/media
 * (code1 = consumer usage), 112 = a macro slot (code1 = 0..31), and 240 = the
 * vendor's DPI/report-rate controls. */
export interface KsnakeKeyBinding {
  type: number;
  code1: number;
  code2: number;
  code3: number;
}

export function ksnakeIsKnownKeyType(type: number): boolean {
  return type === KSNAKE_KEY_TYPE.keyboard || type === KSNAKE_KEY_TYPE.mouse || type === KSNAKE_KEY_TYPE.special || type === KSNAKE_KEY_TYPE.media || type === KSNAKE_KEY_TYPE.macro || type === KSNAKE_KEY_TYPE.control;
}

/** Remappable actions from the vendor key catalog (display label + bytes). */
export const KSNAKE_BUTTON_ACTIONS: ReadonlyArray<{
  label: string;
  type: number;
  code1: number;
  code2: number;
  code3: number;
}> = [
  // Keyboard usages follow the vendor catalog's type-16 encoding. The
  // modifier byte is zero for these single-key actions; custom combinations
  // remain lossless when they are read back as opaque bindings.
  { label: "Escape", type: 16, code1: 0, code2: 41, code3: 0 },
  { label: "Tab", type: 16, code1: 0, code2: 43, code3: 0 },
  { label: "Caps Lock", type: 16, code1: 0, code2: 57, code3: 0 },
  { label: "Enter", type: 16, code1: 0, code2: 40, code3: 0 },
  { label: "Space", type: 16, code1: 0, code2: 44, code3: 0 },
  { label: "Backspace", type: 16, code1: 0, code2: 42, code3: 0 },
  { label: "Insert", type: 16, code1: 0, code2: 73, code3: 0 },
  { label: "Delete", type: 16, code1: 0, code2: 76, code3: 0 },
  { label: "Home", type: 16, code1: 0, code2: 74, code3: 0 },
  { label: "End", type: 16, code1: 0, code2: 77, code3: 0 },
  { label: "Page Up", type: 16, code1: 0, code2: 75, code3: 0 },
  { label: "Page Down", type: 16, code1: 0, code2: 78, code3: 0 },
  { label: "Left Arrow", type: 16, code1: 0, code2: 80, code3: 0 },
  { label: "Right Arrow", type: 16, code1: 0, code2: 79, code3: 0 },
  { label: "Up Arrow", type: 16, code1: 0, code2: 82, code3: 0 },
  { label: "Down Arrow", type: 16, code1: 0, code2: 81, code3: 0 },
  { label: "F1", type: 16, code1: 0, code2: 58, code3: 0 },
  { label: "F2", type: 16, code1: 0, code2: 59, code3: 0 },
  { label: "F3", type: 16, code1: 0, code2: 60, code3: 0 },
  { label: "F4", type: 16, code1: 0, code2: 61, code3: 0 },
  { label: "F5", type: 16, code1: 0, code2: 62, code3: 0 },
  { label: "F6", type: 16, code1: 0, code2: 63, code3: 0 },
  { label: "F7", type: 16, code1: 0, code2: 64, code3: 0 },
  { label: "F8", type: 16, code1: 0, code2: 65, code3: 0 },
  { label: "F9", type: 16, code1: 0, code2: 66, code3: 0 },
  { label: "F10", type: 16, code1: 0, code2: 67, code3: 0 },
  { label: "F11", type: 16, code1: 0, code2: 68, code3: 0 },
  { label: "F12", type: 16, code1: 0, code2: 69, code3: 0 },
  { label: "Left click", type: 32, code1: 1, code2: 0, code3: 0 },
  { label: "Right click", type: 32, code1: 2, code2: 0, code3: 0 },
  { label: "Middle click", type: 32, code1: 4, code2: 0, code3: 0 },
  { label: "Backward", type: 32, code1: 8, code2: 0, code3: 0 },
  { label: "Forward", type: 32, code1: 16, code2: 0, code3: 0 },
  { label: "Disabled", type: 32, code1: 0, code2: 0, code3: 0 },
  { label: "DPI loop", type: 33, code1: 85, code2: 0, code3: 0 },
  // These vendor-control bindings were captured from the installed M2-NEX
  // application and read back from the live 2.4 GHz receiver.
  { label: "DPI +", type: 240, code1: 1, code2: 1, code3: 0 },
  { label: "DPI -", type: 240, code1: 1, code2: 2, code3: 0 },
  { label: "Report Rate +", type: 240, code1: 2, code2: 1, code3: 0 },
  { label: "Scroll up", type: 33, code1: 56, code2: 1, code3: 0 },
  { label: "Scroll down", type: 33, code1: 56, code2: 255, code3: 0 },
  { label: "Volume +", type: 48, code1: 233, code2: 0, code3: 0 },
  { label: "Volume −", type: 48, code1: 234, code2: 0, code3: 0 },
  { label: "Mute", type: 48, code1: 226, code2: 0, code3: 0 },
  { label: "Play/Pause", type: 48, code1: 205, code2: 0, code3: 0 },
  { label: "Stop", type: 48, code1: 183, code2: 0, code3: 0 },
  { label: "Prev track", type: 48, code1: 182, code2: 0, code3: 0 },
  { label: "Next track", type: 48, code1: 181, code2: 0, code3: 0 },
  { label: "Multimedia", type: 48, code1: 131, code2: 1, code3: 0 },
  { label: "Homepage", type: 48, code1: 35, code2: 2, code3: 0 },
  { label: "Web refresh", type: 48, code1: 39, code2: 2, code3: 0 },
  { label: "Web stop", type: 48, code1: 38, code2: 2, code3: 0 },
  { label: "Web forward", type: 48, code1: 37, code2: 2, code3: 0 },
  { label: "Web backward", type: 48, code1: 36, code2: 2, code3: 0 },
  { label: "Web favorites", type: 48, code1: 42, code2: 2, code3: 0 },
  { label: "Web search", type: 48, code1: 33, code2: 2, code3: 0 },
  { label: "Calculator", type: 48, code1: 146, code2: 1, code3: 0 },
  { label: "My Computer", type: 48, code1: 148, code2: 1, code3: 0 },
  { label: "Mail", type: 48, code1: 138, code2: 1, code3: 0 },
  // Macro contents live in a separate 4096-byte store. These assignments are
  // safe to expose independently: selecting one only changes the pointer on
  // the button and leaves the macro buffer untouched.
  ...Array.from({ length: KSNAKE_MACRO_SLOT_COUNT }, (_, slot) => ({
    label: `Macro ${slot + 1}`,
    type: KSNAKE_KEY_TYPE.macro,
    code1: slot,
    code2: 0,
    code3: 0,
  })),
];

/** Display label for a binding, or null when the catalog cannot name it. */
export function ksnakeBindingLabel(binding: KsnakeKeyBinding): string | null {
  if (
    binding.type === KSNAKE_KEY_TYPE.macro
    && Number.isInteger(binding.code1)
    && binding.code1 >= 0
    && binding.code1 < KSNAKE_MACRO_SLOT_COUNT
  ) {
    return `Macro ${binding.code1 + 1}`;
  }
  return KSNAKE_BUTTON_ACTIONS.find(
    (action) =>
      action.type === binding.type &&
      action.code1 === binding.code1 &&
      action.code2 === binding.code2 &&
      action.code3 === binding.code3,
  )?.label ?? null;
}

/** Catalog binding for a display label, or null for unknown labels. */
export function ksnakeFindButtonAction(label: string): KsnakeKeyBinding | null {
  const action = KSNAKE_BUTTON_ACTIONS.find((entry) => entry.label === label);
  return action ? { type: action.type, code1: action.code1, code2: action.code2, code3: action.code3 } : null;
}

export interface KsnakeMacroChunkRequest {
  reportId: number;
  body: Uint8Array;
}

export interface KsnakeMacroStep {
  /** Vendor macro type: 1 = keyboard modifier, 2 = keyboard, 3 = mouse. */
  type: 1 | 2 | 3;
  /** Vendor action: 1 = press, 2 = release. */
  action: 1 | 2;
  delayMs: number;
  code: number;
}

export interface KsnakeMacroProfile {
  steps: readonly KsnakeMacroStep[];
}

function assertMacroOffset(offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset >= KSNAKE_MACRO_BYTES) {
    throw new RangeError(`Macro offset must be between 0 and ${KSNAKE_MACRO_BYTES - 1} (got ${offset}).`);
  }
}

function assertMacroChunk(offset: number, length: number): void {
  assertMacroOffset(offset);
  if (!Number.isInteger(length) || length < 1 || length > KSNAKE_MACRO_CHUNK_BYTES) {
    throw new RangeError(`Macro chunks must contain 1-${KSNAKE_MACRO_CHUNK_BYTES} bytes (got ${length}).`);
  }
  if (offset + length > KSNAKE_MACRO_BYTES) {
    throw new RangeError(`Macro chunk ends beyond ${KSNAKE_MACRO_BYTES} bytes.`);
  }
}

function writeLe16(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >> 8) & 0xff;
}

/** Build the vendor report-6 read request for one macro-memory chunk. */
export function ksnakeGetMacroChunkRequest(offset: number, length: number): KsnakeMacroChunkRequest {
  assertMacroChunk(offset, length);
  const body = new Uint8Array(KSNAKE_REPORT_SIZE);
  body[0] = 0x0c;
  body[1] = length;
  writeLe16(body, 2, offset);
  return { reportId: KSNAKE_MACRO_REPORT_ID, body };
}

/** Decode the 8-byte vendor macro-read header and return the requested data. */
export function ksnakeDecodeMacroChunk(reply: Uint8Array, length: number): Uint8Array | null {
  if (!Number.isInteger(length) || length < 1 || length > KSNAKE_MACRO_CHUNK_BYTES) return null;
  if (reply.length < 8 + length) return null;
  return reply.slice(8, 8 + length);
}

/** Build one report-0 macro-memory write chunk. */
export function ksnakeEncodeMacroChunk(offset: number, data: Uint8Array): Uint8Array {
  assertMacroChunk(offset, data.length);
  const body = new Uint8Array(KSNAKE_REPORT_SIZE);
  body.set([KSNAKE_MAGIC, 0x0d, 0x00, 0x00, data.length], 0);
  writeLe16(body, 5, offset);
  body[7] = 0;
  body.set(data, 8);
  return body;
}

/** Final report-0 command that commits the previously written macro chunks. */
export function ksnakeEncodeMacroCommit(): Uint8Array {
  const body = new Uint8Array(KSNAKE_REPORT_SIZE);
  body.set([KSNAKE_MAGIC, 0x10, 0xa5, 0x22, 0x00, 0x00, 0x00, 0x00, 0x05], 0);
  return body;
}

/** Vendor report-6 command for clearing the macro memory. */
export function ksnakeResetMacroRequest(): KsnakeMacroChunkRequest {
  const body = new Uint8Array(KSNAKE_REPORT_SIZE);
  body.set([0x0f, 0x04], 0);
  return { reportId: KSNAKE_MACRO_REPORT_ID, body };
}

function macroStepFlags(step: KsnakeMacroStep, last: boolean): number {
  if (![1, 2, 3].includes(step.type)) throw new RangeError(`Unsupported macro step type ${step.type}.`);
  if (![1, 2].includes(step.action)) throw new RangeError(`Unsupported macro action ${step.action}.`);
  if (!Number.isInteger(step.delayMs) || step.delayMs < 0 || step.delayMs > 0xffff) {
    throw new RangeError(`Macro delay must be an integer between 0 and 65535 ms (got ${step.delayMs}).`);
  }
  if (!Number.isInteger(step.code) || step.code < 0 || step.code > 0xff) {
    throw new RangeError(`Macro code must be an integer between 0 and 255 (got ${step.code}).`);
  }
  let flags = step.action === 1 ? 0x40 : 0;
  // The official configurator uses modifier=1, keyboard=2, mouse=3 in the
  // low three bits of every four-byte action record.
  flags |= step.type;
  if (last) flags |= 0x80;
  return flags;
}

/**
 * Encode the vendor's pointer table plus macro action records. Empty slots are
 * omitted exactly like the official app; the result is ready to upload in
 * 56-byte chunks with `ksnakeEncodeMacroChunk`.
 */
export function ksnakeEncodeMacroData(profiles: readonly KsnakeMacroProfile[]): Uint8Array {
  if (profiles.length > KSNAKE_MACRO_SLOT_COUNT) {
    throw new RangeError(`The mouse has only ${KSNAKE_MACRO_SLOT_COUNT} macro slots.`);
  }
  const data = new Uint8Array(KSNAKE_MACRO_BYTES);
  let cursor = KSNAKE_MACRO_HEADER_BYTES;
  // The official M2-NEX configurator writes 0x0040 for an empty slot and a
  // four-byte marker immediately after the pointer table. Without these
  // bytes the firmware accepts the packet but ignores the macro table.
  for (let slot = 0; slot < KSNAKE_MACRO_SLOT_COUNT; slot++) {
    writeLe16(data, slot * 2, KSNAKE_MACRO_POINTER_BYTES);
  }
  data.set([0x00, 0x00, 0x80, 0x00], KSNAKE_MACRO_POINTER_BYTES);
  profiles.forEach((profile, slot) => {
    if (profile.steps.length === 0) return;
    if (profile.steps.length > Math.floor((KSNAKE_MACRO_BYTES - cursor) / 4)) {
      throw new RangeError(`Macro ${slot + 1} is too long for the device memory.`);
    }
    writeLe16(data, slot * 2, cursor);
    profile.steps.forEach((step, index) => {
      const record = cursor + index * 4;
      // Firmware treats a zero delay as an invalid/empty record. The vendor
      // configurator normalizes an editor value of 0 ms to its minimum 2 ms.
      writeLe16(data, record, step.delayMs === 0 ? 2 : step.delayMs);
      data[record + 2] = macroStepFlags(step, index === profile.steps.length - 1);
      data[record + 3] = step.code;
    });
    cursor += profile.steps.length * 4;
  });
  return data.slice(0, cursor);
}

/** Decode known vendor macro records from a complete macro-memory image. */
export function ksnakeDecodeMacroData(data: Uint8Array): KsnakeMacroProfile[] | null {
  if (data.length < KSNAKE_MACRO_HEADER_BYTES || data.length > KSNAKE_MACRO_BYTES) return null;
  const profiles: KsnakeMacroProfile[] = Array.from({ length: KSNAKE_MACRO_SLOT_COUNT }, () => ({ steps: [] }));
  for (let slot = 0; slot < KSNAKE_MACRO_SLOT_COUNT; slot++) {
    const start = le16(data[slot * 2], data[slot * 2 + 1]);
    // 0 is accepted for old captures; the M2-NEX configurator uses the
    // pointer-table end (0x0040) for an empty slot.
    if (start === 0 || start === KSNAKE_MACRO_POINTER_BYTES) continue;
    if (start < KSNAKE_MACRO_HEADER_BYTES || start + 4 > data.length) return null;
    const steps: KsnakeMacroStep[] = [];
    let cursor = start;
    let terminated = false;
    while (cursor + 4 <= data.length) {
      const flags = data[cursor + 2];
      const wireType = flags & 0x07;
      const type = wireType === 0x01 ? 1 : wireType === 0x02 ? 2 : wireType === 0x03 ? 3 : null;
      if (type === null) return null;
      const action = (flags & 0x40) !== 0 ? 1 : 2;
      steps.push({
        type,
        action,
        delayMs: le16(data[cursor], data[cursor + 1]),
        code: data[cursor + 3],
      });
      cursor += 4;
      if ((flags & 0x80) !== 0) {
        terminated = true;
        break;
      }
    }
    if (!terminated) return null;
    profiles[slot] = { steps };
  }
  return profiles;
}

/**
 * Plausibility gate for decoded key maps. `exchange()` resolves with the next
 * input report, so a stray report from another command can land here; those
 * decode to zeroed/garbage slot types. Real maps always carry nonzero,
 * non-0xff types (32/33/48/240 catalog, plus opaque refs like macro 112).
 * Some M2-NEX firmware paths answer with an all-0xff sentinel instead of a
 * readable map; that must not become a fake remap UI.
 */
export function ksnakeKeysLookPlausible(keys: readonly KsnakeKeyBinding[]): boolean {
  return keys.length === 8 && keys.every((key) => key.type !== 0 && key.type !== 0xff);
}

/** GET_KEYS request tail observed in vendor JS: [0x55, 0x08, 0xA5, 0x0B, 0x20]. */
export function ksnakeGetKeysRequest(): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.GET_KEYS;
  buf[2] = 0xa5;
  buf[3] = 0x0b;
  buf[4] = 0x20;
  return buf;
}

/**
 * Decode a getKeys reply: 8 slots of 4 bytes at reply[8..39] (the vendor
 * slices 8). Slot 5 is the fixed DPI button; slots 0-4, 6 and 7 are the
 * user-visible controls. Verified against the installed M2-NEX application
 * and its live 2.4 GHz receiver.
 */
export function ksnakeDecodeKeys(reply: Uint8Array): KsnakeKeyBinding[] | null {
  if (reply.length < 40) return null;
  const bindings: KsnakeKeyBinding[] = [];
  for (let i = 0; i < 8; i++) {
    bindings.push({
      type: reply[8 + i * 4],
      code1: reply[9 + i * 4],
      code2: reply[10 + i * 4],
      code3: reply[11 + i * 4],
    });
  }
  return bindings;
}

/**
 * Encode a setKeys request, mirroring vendor `setMouseKeys()`: head
 * [0x55, 0x09, 0xA5, 0x22, 0x20], followed by all eight four-byte slots at
 * body[8..39]. For compatibility, a seven-entry logical map is also accepted
 * and placed into the seven user-visible wire slots while retaining the fixed
 * DPI binding in slot 5.
 */
export function ksnakeEncodeSetKeys(keys: readonly KsnakeKeyBinding[]): Uint8Array {
  const buf = new Uint8Array(KSNAKE_REPORT_SIZE);
  buf[0] = KSNAKE_MAGIC;
  buf[1] = CMD.SET_KEYS;
  buf[2] = 0xa5;
  buf[3] = 0x22;
  buf[4] = 0x20;
  let slots: KsnakeKeyBinding[];
  if (keys.length >= 8) {
    slots = [...keys].slice(0, 8).map((key) => ({ ...key }));
  } else if (keys.length === 7) {
    slots = Array.from({ length: 8 }, () => ({ type: 32, code1: 0, code2: 0, code3: 0 }));
    slots[5] = { ...KSNAKE_FIXED_DPI_BINDING };
    keys.forEach((key, index) => {
      slots[KSNAKE_BUTTON_WIRE_INDICES[index]] = { ...key };
    });
  } else {
    // Legacy callers supplied the first six raw slots; retain that encoding
    // while always restoring the two fixed wheel entries at the end.
    slots = [...keys].slice(0, 6).map((key) => ({ ...key }));
    while (slots.length < 6) slots.push({ type: 32, code1: 0, code2: 0, code3: 0 });
    slots.push({ type: 33, code1: 56, code2: 1, code3: 0 }, { type: 33, code1: 56, code2: 255, code3: 0 });
  }
  // Wire offsets, NOT vendor-JS t[] indices: t[0] is the report id, so the
  // request slots at t[9..40] land at data[8..39].
  slots.forEach((key, n) => {
    buf[8 + n * 4] = key.type & 0xff;
    buf[9 + n * 4] = key.code1 & 0xff;
    buf[10 + n * 4] = key.code2 & 0xff;
    buf[11 + n * 4] = key.code3 & 0xff;
  });
  return buf;
}
