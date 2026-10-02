/**
 * Cooler Master HID protocol codec.
 *
 * Reverse-engineered from Cooler Master MasterPlus+ v1.9.6 (CMUOT.dll/pdb,
 * MM711PerformanceWid.dll/pdb, CfgFile.dll/pdb) and verified against a physical
 * Cooler Master MM711 wired gaming mouse (VID 0x2516, PID 0x0101, MI_01).
 *
 * All control traffic uses raw 64-byte HID output/input reports on report ID 0x00
 * (total 65 bytes on the wire including Report ID 0x00).
 *
 * Reference captures and ground truth fixtures:
 * `captures/coolermaster-mm711/`
 */

export const COOLERMASTER_VENDOR_ID = 0x2516;
export const COOLERMASTER_MM711_PRODUCT_ID = 0x0101;

export const COOLERMASTER_USAGE_PAGE = 0xff00;
export const COOLERMASTER_USAGE = 0x0001;
export const COOLERMASTER_REPORT_ID = 0x00;
export const COOLERMASTER_PAYLOAD_SIZE = 64;
export const COOLERMASTER_REPORT_SIZE = 65;

export const COOLERMASTER_PRODUCT_IDS = [
  COOLERMASTER_MM711_PRODUCT_ID,
] as const;

export const COOLERMASTER_PRODUCT_NAMES: ReadonlyMap<number, string> = new Map([
  [COOLERMASTER_MM711_PRODUCT_ID, "Cooler Master MM711"],
]);

export const COOLERMASTER_POLLING_RATES: readonly number[] = [125, 250, 500, 1000];

export const COOLERMASTER_DPI_MIN = 100;
export const COOLERMASTER_DPI_MAX = 16000;
export const COOLERMASTER_DPI_STEP = 100;
export const COOLERMASTER_DPI_STAGE_COUNT = 7;
export const COOLERMASTER_DPI_OPTIONS: readonly number[] = Array.from(
  { length: 160 },
  (_, i) => (i + 1) * 100,
);

// Protocol command bytes
export const COOLERMASTER_CMD_HANDSHAKE_1 = 0x41;
export const COOLERMASTER_CMD_HANDSHAKE_2 = 0x80;
export const COOLERMASTER_CMD_READ = 0x52;
export const COOLERMASTER_CMD_WRITE = 0x51;

export const COOLERMASTER_SUB_PERFORMANCE = 0x40;
export const COOLERMASTER_SUB_DPI_LEVEL = 0x9b;
export const COOLERMASTER_SUB_POLLING = 0xf0;
export const COOLERMASTER_SUB_DEBOUNCE = 0x10;

/** Polling rate code mapping (matches CMUOT toInnerPollingRate / bInterval ms). */
export const COOLERMASTER_POLLING_RATE_MAP: Readonly<Record<number, number>> = {
  1000: 1, // 1 ms
  500: 2,  // 2 ms
  250: 4,  // 4 ms
  125: 8,  // 8 ms
};

export const COOLERMASTER_POLLING_CODE_MAP: Readonly<Record<number, number>> = {
  1: 1000,
  2: 500,
  4: 250,
  8: 125,
};

export function coolermasterEncodePollingCode(hz: number): number {
  const code = COOLERMASTER_POLLING_RATE_MAP[hz];
  if (code === undefined) {
    throw new RangeError(`Unsupported Cooler Master polling rate: ${hz} Hz`);
  }
  return code;
}

export function coolermasterDecodePollingRateCode(code: number): number {
  const hz = COOLERMASTER_POLLING_CODE_MAP[code];
  if (hz === undefined) {
    throw new RangeError(`Unknown Cooler Master polling rate code: 0x${code.toString(16)}`);
  }
  return hz;
}

/**
 * Encodes a DPI value into the raw hardware byte code:
 * formula from CMUOT: (raw_code + 1) * 100 = DPI => raw_code = Math.round(dpi / 100) - 1.
 */
export function coolermasterEncodeDpi(dpi: number): number {
  if (!Number.isFinite(dpi)) {
    throw new RangeError("DPI must be a finite number");
  }
  const clamped = Math.max(COOLERMASTER_DPI_MIN, Math.min(COOLERMASTER_DPI_MAX, dpi));
  const rounded = Math.round(clamped / COOLERMASTER_DPI_STEP) * COOLERMASTER_DPI_STEP;
  return (rounded / 100) - 1;
}

/**
 * Decodes a raw hardware byte code to DPI: (raw_code + 1) * 100.
 */
export function coolermasterDecodeDpi(code: number): number {
  return (code + 1) * 100;
}

function normalizePayload(source: Uint8Array | DataView): Uint8Array {
  const bytes = source instanceof Uint8Array
    ? source
    : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

  if (bytes.length === COOLERMASTER_REPORT_SIZE && bytes[0] === COOLERMASTER_REPORT_ID) {
    return bytes.subarray(1);
  }
  if (bytes.length === COOLERMASTER_PAYLOAD_SIZE) {
    return bytes;
  }
  throw new RangeError(
    `Invalid Cooler Master report length: expected 64 or 65 bytes, got ${bytes.length}`,
  );
}

/** Builds the 64-byte handshake request [0x41, 0x80, ...0x00]. */
export function coolermasterEncodeHandshake(): Uint8Array {
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  buf[0] = COOLERMASTER_CMD_HANDSHAKE_1;
  buf[1] = COOLERMASTER_CMD_HANDSHAKE_2;
  return buf;
}

/** Builds the 64-byte get polling rate request [0x52, 0xF0, ...0x00]. */
export function coolermasterEncodeGetPollingRate(): Uint8Array {
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  buf[0] = COOLERMASTER_CMD_READ;
  buf[1] = COOLERMASTER_SUB_POLLING;
  return buf;
}

/** Builds the 64-byte set polling rate command [0x51, 0xF0, 0x00, 0x00, code, ...0x00]. */
export function coolermasterEncodeSetPollingRate(hz: number): Uint8Array {
  const code = coolermasterEncodePollingCode(hz);
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  buf[0] = COOLERMASTER_CMD_WRITE;
  buf[1] = COOLERMASTER_SUB_POLLING;
  buf[2] = 0x00;
  buf[3] = 0x00;
  buf[4] = code;
  return buf;
}

/** Decodes the polling rate response [0x52, 0xF0, 0x00, 0x00, code, ...]. */
export function coolermasterDecodePollingRate(source: Uint8Array | DataView): number {
  const payload = normalizePayload(source);
  if (
    (payload[0] !== COOLERMASTER_CMD_READ && payload[0] !== COOLERMASTER_CMD_WRITE) ||
    payload[1] !== COOLERMASTER_SUB_POLLING
  ) {
    throw new Error(
      `Invalid Cooler Master polling reply: [0x${payload[0]?.toString(16)}, 0x${payload[1]?.toString(16)}]`,
    );
  }
  return coolermasterDecodePollingRateCode(payload[4]!);
}

/** Builds the 64-byte get DPI level request [0x52, 0x9B, ...0x00]. */
export function coolermasterEncodeGetDpiLevel(): Uint8Array {
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  buf[0] = COOLERMASTER_CMD_READ;
  buf[1] = COOLERMASTER_SUB_DPI_LEVEL;
  return buf;
}

export interface CoolerMasterDpiLevel {
  activeDpiStage: number;
  stageOrder: number[];
}

/** Decodes DPI level reply [0x52, 0x9B, 0x00, 0x00, 0x00, activeStage, ...order]. */
export function coolermasterDecodeDpiLevel(source: Uint8Array | DataView): CoolerMasterDpiLevel {
  const payload = normalizePayload(source);
  if (payload[0] !== COOLERMASTER_CMD_READ || payload[1] !== COOLERMASTER_SUB_DPI_LEVEL) {
    throw new Error("Invalid Cooler Master DPI level reply.");
  }
  const activeDpiStage = payload[5]!;
  const stageOrder: number[] = [];
  for (let i = 6; i < 13; i++) {
    stageOrder.push(payload[i]!);
  }
  return { activeDpiStage, stageOrder };
}

/** Builds the 64-byte get performance request [0x52, 0x40, ...0x00]. */
export function coolermasterEncodeGetPerformance(): Uint8Array {
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  buf[0] = COOLERMASTER_CMD_READ;
  buf[1] = COOLERMASTER_SUB_PERFORMANCE;
  return buf;
}

export interface CoolerMasterPerformance {
  activeDpiStage: number;
  stageCount: number;
  dpiStages: number[];
  dpiStagesY: number[];
  currentDpi: number;
  currentDpiY: number;
  angleTuning: number;
  angleSnapping: boolean;
  liftOffDistance: "Low" | "High";
  pixelThreshold: number;
  minSqRun: number;
  rawPayload: Uint8Array;
}

/**
 * Decodes the 64-byte performance block returned by 0x52 0x40.
 */
export function coolermasterDecodePerformance(source: Uint8Array | DataView): CoolerMasterPerformance {
  const payload = normalizePayload(source);
  if (
    (payload[0] !== COOLERMASTER_CMD_READ && payload[0] !== COOLERMASTER_CMD_WRITE) ||
    payload[1] !== COOLERMASTER_SUB_PERFORMANCE
  ) {
    throw new Error(
      `Invalid Cooler Master performance reply: [0x${payload[0]?.toString(16)}, 0x${payload[1]?.toString(16)}]`,
    );
  }

  const activeDpiStage = payload[4]!;
  const stageCount = payload[5]!;

  const dpiStages: number[] = [];
  for (let i = 0; i < COOLERMASTER_DPI_STAGE_COUNT; i++) {
    dpiStages.push(coolermasterDecodeDpi(payload[6 + i]!));
  }

  const dpiStagesY: number[] = [];
  for (let i = 0; i < COOLERMASTER_DPI_STAGE_COUNT; i++) {
    dpiStagesY.push(coolermasterDecodeDpi(payload[13 + i]!));
  }

  const currentDpi = dpiStages[activeDpiStage] ?? dpiStages[0]!;
  const currentDpiY = dpiStagesY[activeDpiStage] ?? dpiStagesY[0]!;

  // Angle tuning is signed int8 at offset 27 (-30 to +30 degrees)
  const rawAngleTune = payload[27]!;
  const angleTuning = (rawAngleTune << 24) >> 24;

  // Offset 28: bit 0 is angle snapping (0=off, 1=on)
  //            bits 1..2: if (byte & 6) == 6 => High LOD, else Low LOD
  const flags = payload[28]!;
  const angleSnapping = (flags & 0x01) === 0x01;
  const liftOffDistance: "Low" | "High" = (flags & 0x06) === 0x06 ? "High" : "Low";

  const pixelThreshold = payload[29]!;
  const minSqRun = payload[30]!;

  return {
    activeDpiStage,
    stageCount,
    dpiStages,
    dpiStagesY,
    currentDpi,
    currentDpiY,
    angleTuning,
    angleSnapping,
    liftOffDistance,
    pixelThreshold,
    minSqRun,
    rawPayload: new Uint8Array(payload),
  };
}

export interface CoolerMasterPerformanceUpdate {
  activeDpiStage?: number;
  stageCount?: number;
  dpiStages?: readonly number[];
  dpiStagesY?: readonly number[];
  angleTuning?: number;
  angleSnapping?: boolean;
  liftOffDistance?: "Low" | "High";
}

/**
 * Builds the 64-byte write performance packet (0x51 0x40 ...), preserving
 * existing values from baseFrame or defaults when not explicitly modified.
 */
export function coolermasterEncodeSetPerformance(
  update: CoolerMasterPerformanceUpdate,
  baseFrame?: Uint8Array,
): Uint8Array {
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  if (baseFrame) {
    const base = normalizePayload(baseFrame);
    buf.set(base);
  }

  buf[0] = COOLERMASTER_CMD_WRITE;
  buf[1] = COOLERMASTER_SUB_PERFORMANCE;

  if (update.activeDpiStage !== undefined) {
    if (update.activeDpiStage < 0 || update.activeDpiStage >= COOLERMASTER_DPI_STAGE_COUNT) {
      throw new RangeError(`Active DPI stage must be 0-${COOLERMASTER_DPI_STAGE_COUNT - 1}`);
    }
    buf[4] = update.activeDpiStage;
  }

  if (update.stageCount !== undefined) {
    buf[5] = update.stageCount;
  } else if (!baseFrame) {
    buf[5] = COOLERMASTER_DPI_STAGE_COUNT;
  }

  if (update.dpiStages) {
    for (let i = 0; i < update.dpiStages.length && i < COOLERMASTER_DPI_STAGE_COUNT; i++) {
      buf[6 + i] = coolermasterEncodeDpi(update.dpiStages[i]!);
    }
  }

  if (update.dpiStagesY) {
    for (let i = 0; i < update.dpiStagesY.length && i < COOLERMASTER_DPI_STAGE_COUNT; i++) {
      buf[13 + i] = coolermasterEncodeDpi(update.dpiStagesY[i]!);
    }
  } else if (update.dpiStages && !baseFrame) {
    for (let i = 0; i < update.dpiStages.length && i < COOLERMASTER_DPI_STAGE_COUNT; i++) {
      buf[13 + i] = coolermasterEncodeDpi(update.dpiStages[i]!);
    }
  }

  if (update.angleTuning !== undefined) {
    const clamped = Math.max(-30, Math.min(30, update.angleTuning));
    buf[27] = clamped & 0xff;
  }

  let currentFlags = buf[28]!;
  if (update.angleSnapping !== undefined) {
    currentFlags = update.angleSnapping ? (currentFlags | 0x01) : (currentFlags & ~0x01);
  }
  if (update.liftOffDistance !== undefined) {
    if (update.liftOffDistance === "High") {
      currentFlags = (currentFlags & ~0x06) | 0x06;
    } else {
      currentFlags = (currentFlags & ~0x06) | 0x02;
    }
  }
  buf[28] = currentFlags;

  if (!baseFrame) {
    buf[29] = 0x0a; // default pixel threshold 10
    buf[30] = 0x06; // default min_sq_run 6
  }

  return buf;
}

/** Builds the 64-byte get debounce request [0x52, 0x10, ...0x00]. */
export function coolermasterEncodeGetDebounce(): Uint8Array {
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  buf[0] = COOLERMASTER_CMD_READ;
  buf[1] = COOLERMASTER_SUB_DEBOUNCE;
  return buf;
}

/** Decodes debounce ms from [0x52, 0x10, ...]. Offset 12 carries debounce ms. */
export function coolermasterDecodeDebounce(source: Uint8Array | DataView): number {
  const payload = normalizePayload(source);
  if (
    (payload[0] !== COOLERMASTER_CMD_READ && payload[0] !== COOLERMASTER_CMD_WRITE) ||
    payload[1] !== COOLERMASTER_SUB_DEBOUNCE
  ) {
    throw new Error(
      `Invalid Cooler Master debounce reply: [0x${payload[0]?.toString(16)}, 0x${payload[1]?.toString(16)}]`,
    );
  }
  return payload[12]!;
}

/** Builds the 64-byte set debounce command [0x51, 0x10, ...]. */
export function coolermasterEncodeSetDebounce(debounceMs: number, baseFrame?: Uint8Array): Uint8Array {
  if (!Number.isInteger(debounceMs) || debounceMs < 1 || debounceMs > 32) {
    throw new RangeError("Cooler Master debounce time must be an integer between 1 and 32 ms.");
  }
  const buf = new Uint8Array(COOLERMASTER_PAYLOAD_SIZE);
  if (baseFrame) {
    buf.set(normalizePayload(baseFrame));
  }
  buf[0] = COOLERMASTER_CMD_WRITE;
  buf[1] = COOLERMASTER_SUB_DEBOUNCE;
  buf[12] = debounceMs;
  buf[16] = debounceMs;
  return buf;
}
