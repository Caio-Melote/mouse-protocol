import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_LAUNCHER_MICE,
  type KeychronButtonId,
  type KeychronLauncherMouse,
} from "@openmouse/protocol/keychron";

/**
 * The parts of Keychron Launcher's "8k" and "1k" mouse protocols that are the
 * same in both: the first 18 bytes of the status report, the DPI, sensor and
 * debounce packets, and the button and lighting codes. Decoded from Launcher
 * (main.be11320b2a72b61b.js, webpack modules 20706, 75994 and 8596).
 */

export const KEYCHRON_DPI_STAGE_COUNT = 5;
/** Launcher's POLLING_RATE_VALUE_SCALE; polling tables hold indexes into it. */
export const KEYCHRON_POLLING_RATES = [125, 500, 1000, 2000, 4000, 8000] as const;
/** Ranges Launcher's descriptors give: debounce 0-20 ms, sleep 1-240 minutes. */
export const KEYCHRON_DEBOUNCE_MAX_MS = 20;
export const KEYCHRON_SLEEP_MINUTES = [1, 3, 5, 10, 15, 30, 60, 120, 240] as const;
export const KEYCHRON_DPI_STEP = 50;
/** The M6's range, for a mouse missing from the model table. */
export const KEYCHRON_DEFAULT_DPI: readonly [number, number] = [100, 26_000];

/** Command bytes the two protocols share; each sends them on its own reports. */
export const KEYCHRON_SET = {
  receiverState: 0x03,
  firmware: 0x04,
  dpi: 0x40,
  polling: 0x41,
  sensor: 0x42,
  debounce: 0x43,
  readButton: 0x62,
  writeButton: 0x52,
} as const;

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;

export function keychronLauncherMouse(productId: number | null | undefined): KeychronLauncherMouse | undefined {
  return KEYCHRON_LAUNCHER_MICE.find((mouse) => mouse.productId === productId);
}

/** Status bytes 1-17, laid out the same in the "8k" 0x06 and the "1k" 0x07 report. */
export type KeychronSettings = {
  /** Active onboard profile, zero-based. */
  profile: number;
  /** For USB, 2.4 GHz and Bluetooth: DPI stage in the low nibble, polling gear in the high nibble. */
  levels: number[];
  /** All five hardware slots; only the first `stageCount` are in use. */
  dpiStages: number[];
  stageCount: number;
  /** Bits 0-1 of byte 15: the lift-off code. */
  lod: number;
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  scrollReversed: boolean;
  debounceMs: number;
};

export function keychronDecodeSettings(bytes: Uint8Array): KeychronSettings {
  const flags = bytes[15] ?? 0;
  const stageCount = Math.min(bytes[16] || KEYCHRON_DPI_STAGE_COUNT, KEYCHRON_DPI_STAGE_COUNT);
  return {
    profile: bytes[1] ?? 0,
    levels: [bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0],
    dpiStages: Array.from({ length: KEYCHRON_DPI_STAGE_COUNT }, (_, stage) => readU16(bytes, 5 + stage * 2)),
    stageCount,
    lod: flags & 0x03,
    rippleControl: (flags & 0x04) !== 0,
    angleSnapping: (flags & 0x08) !== 0,
    motionSync: (flags & 0x10) !== 0,
    scrollReversed: (flags & 0x40) !== 0,
    debounceMs: bytes[17] ?? 0,
  };
}

/** The DPI stage of a connection (0 USB, 1 2.4 GHz, 2 Bluetooth), kept inside the stage count. */
export function keychronActiveStage(settings: KeychronSettings, workMode: number): number {
  return Math.min((settings.levels[Math.min(workMode, 2)] ?? 0) & 0x0f, settings.stageCount - 1);
}

/** The polling gear of a connection. */
export function keychronActiveGear(settings: KeychronSettings, workMode: number): number {
  return ((settings.levels[Math.min(workMode, 2)] ?? 0) >> 4) & 0x0f;
}

/**
 * 0x40: the DPI part of the status layout shifted down a byte. The stage goes
 * to all three connections, as Launcher sends it.
 */
export function keychronEncodeDpi(activeStage: number, dpiStages: readonly number[], stageCount: number): Uint8Array {
  const packet = new Uint8Array(20);
  packet[0] = KEYCHRON_SET.dpi;
  packet.fill(activeStage, 1, 4);
  dpiStages.slice(0, KEYCHRON_DPI_STAGE_COUNT).forEach((dpi, stage) => writeU16(packet, 4 + stage * 2, dpi));
  packet[14] = stageCount;
  return packet;
}

export type KeychronSensorWrite = {
  /** 2-bit lift-off code, or 0 to leave it (Launcher's choice when it writes the level byte). */
  lod: number;
  rippleControl: boolean;
  angleSnapping: boolean;
  motionSync: boolean;
  scrollReversed: boolean;
  /** "8k" only: the 20K FPS switch. */
  maxSpeed?: boolean;
  /** "8k" only: the lift-off level byte, on firmware that flags it. */
  lodLevel?: number;
};

/** 0x42: every sensor option at once. Toggles are 1 = on, 2 = off; 0 would leave one alone. */
export function keychronEncodeSensor(sensor: KeychronSensorWrite): Uint8Array {
  const packet = new Uint8Array(20);
  packet[0] = KEYCHRON_SET.sensor;
  packet[1] = sensor.lod;
  packet[2] = sensor.rippleControl ? 1 : 2;
  packet[3] = sensor.angleSnapping ? 1 : 2;
  packet[4] = sensor.motionSync ? 1 : 2;
  packet[6] = sensor.scrollReversed ? 2 : 1;
  if (sensor.maxSpeed !== undefined) packet[8] = sensor.maxSpeed ? 2 : 1;
  if (sensor.lodLevel !== undefined) packet[11] = sensor.lodLevel;
  return packet;
}

/** 0x42 in its angle form: byte 9 = 2 enables tuning, byte 10 is the signed angle. */
export function keychronEncodeAngle(degrees: number): Uint8Array {
  const packet = new Uint8Array(20);
  packet[0] = KEYCHRON_SET.sensor;
  packet[9] = 2;
  packet[10] = degrees & 0xff;
  return packet;
}

export function keychronEncodeDebounce(debounceMs: number): Uint8Array {
  const packet = new Uint8Array(20);
  packet[0] = KEYCHRON_SET.debounce;
  packet[1] = debounceMs;
  return packet;
}

/** Launcher's 0x03 answer: [1] count, then vendor ID, product ID (both little-endian) and state (1 = connected) per mouse. */
export function keychronDecodeConnectedMouse(bytes: Uint8Array): number | null {
  const count = Math.min(bytes[1] ?? 0, Math.floor((bytes.length - 2) / 5));
  for (let entry = 0; entry < count; entry += 1) {
    const offset = 2 + entry * 5;
    if (bytes[offset + 4] === 1) return readU16(bytes, offset + 2);
  }
  return null;
}

/** 0x04 answer: [1] is the length of the ASCII version that starts at [2]. */
export function keychronLauncherFirmware(bytes: Uint8Array): string | null {
  const length = Math.min(bytes[1] ?? 0, bytes.length - 2);
  const text = Array.from(bytes.slice(2, 2 + length))
    .filter((byte) => byte >= 0x20 && byte < 0x7f)
    .map((byte) => String.fromCharCode(byte))
    .join("")
    .trim();
  if (!text) return null;
  return text.startsWith("v") ? text : `v${text}`;
}

// Buttons ───────────────────────────────────────────────────────────────

/** Launcher's EFunKey: byte 3 of a button record. */
const BUTTON_TYPE = { default: 0, mouse: 1, media: 3, macro: 4, dpi: 5, disabled: 9 } as const;

/**
 * Launcher's EBasicKey, written as three bytes high to low. The "1k" enum
 * (module 8596) is the "8k" one (module 75994) with Back and Forward swapped.
 */
const MOUSE_CODE = {
  left: 0x010000,
  right: 0x020000,
  middle: 0x040000,
  back8k: 0x080000,
  forward8k: 0x100000,
  doubleClick: 0x800000,
  scrollUp: 0x000200,
  scrollDown: 0x00fe00,
  scrollLeft: 0x0000fe,
  scrollRight: 0x000002,
} as const;

export type KeychronProtocol = "8k" | "1k";

type ButtonAction = { label: string; type: number; value: number };

/** Every action the remapper offers, in display order. Media codes are HID consumer usages. */
function buttonActions(protocol: KeychronProtocol): ButtonAction[] {
  const [back, forward] = protocol === "8k"
    ? [MOUSE_CODE.back8k, MOUSE_CODE.forward8k]
    : [MOUSE_CODE.forward8k, MOUSE_CODE.back8k];
  return [
    { label: "Left Click", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.left },
    { label: "Right Click", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.right },
    { label: "Middle Click", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.middle },
    { label: "Back", type: BUTTON_TYPE.mouse, value: back },
    { label: "Forward", type: BUTTON_TYPE.mouse, value: forward },
    { label: "Double Click", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.doubleClick },
    { label: "Scroll Up", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.scrollUp },
    { label: "Scroll Down", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.scrollDown },
    { label: "Scroll Left", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.scrollLeft },
    { label: "Scroll Right", type: BUTTON_TYPE.mouse, value: MOUSE_CODE.scrollRight },
    { label: "DPI Loop", type: BUTTON_TYPE.dpi, value: 1 },
    { label: "DPI +", type: BUTTON_TYPE.dpi, value: 2 },
    { label: "DPI -", type: BUTTON_TYPE.dpi, value: 3 },
    { label: "Volume Up", type: BUTTON_TYPE.media, value: 0xe9 },
    { label: "Volume Down", type: BUTTON_TYPE.media, value: 0xea },
    { label: "Mute", type: BUTTON_TYPE.media, value: 0xe2 },
    { label: "Play/Pause", type: BUTTON_TYPE.media, value: 0xcd },
    { label: "Next Track", type: BUTTON_TYPE.media, value: 0xb5 },
    { label: "Previous Track", type: BUTTON_TYPE.media, value: 0xb6 },
    { label: "Disabled", type: BUTTON_TYPE.disabled, value: 0 },
    // Launcher's "restore": the firmware's own function for that button.
    { label: "Default", type: BUTTON_TYPE.default, value: 0 },
  ];
}

export function keychronButtonOptions(protocol: KeychronProtocol): string[] {
  return buttonActions(protocol).map(({ label }) => label);
}

/**
 * Bytes 3 onward of a 0x52 write: the type, then the data the way Launcher
 * packs it (mouse codes three bytes high to low, media codes low byte first,
 * the DPI key as one byte).
 */
export function keychronEncodeButton(label: string, protocol: KeychronProtocol): number[] | null {
  const action = buttonActions(protocol).find((entry) => entry.label === label);
  if (!action) return null;
  switch (action.type) {
    case BUTTON_TYPE.mouse:
      return [action.type, (action.value >> 16) & 0xff, (action.value >> 8) & 0xff, action.value & 0xff];
    case BUTTON_TYPE.media:
      return [action.type, action.value & 0xff, (action.value >> 8) & 0xff];
    case BUTTON_TYPE.dpi:
      return [action.type, action.value];
    default:
      return [action.type];
  }
}

/**
 * Reads a 0x62 answer from byte 3. Null means the button runs its default
 * function (type 0, which is all Launcher's own reads return until something
 * is remapped); "Macro" and "Custom" cover codes the remapper cannot offer.
 */
export function keychronDecodeButton(bytes: Uint8Array, protocol: KeychronProtocol): string | null {
  const type = bytes[3] ?? 0;
  if (type === BUTTON_TYPE.default) return null;
  if (type === BUTTON_TYPE.macro) return "Macro";
  const value = type === BUTTON_TYPE.mouse ? ((bytes[4] ?? 0) << 16) | ((bytes[5] ?? 0) << 8) | (bytes[6] ?? 0)
    : type === BUTTON_TYPE.media ? (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8)
      : type === BUTTON_TYPE.dpi ? (bytes[4] ?? 0)
        : 0;
  return buttonActions(protocol).find((action) => action.type === type && action.value === value)?.label ?? "Custom";
}

const BUTTON_NAME: Record<KeychronButtonId, string> = {
  left: "Left",
  right: "Right",
  middle: "Middle",
  backward: "Back",
  forward: "Forward",
  leftTilt: "Tilt Left",
  rightTilt: "Tilt Right",
  upScroll: "Scroll Up",
  downScroll: "Scroll Down",
  leftScroll: "Scroll Left",
  rightScroll: "Scroll Right",
  dpiLoop: "DPI",
  pageUp: "Page Up",
  pageDown: "Page Down",
  swichLight: "Lighting",
};

/** What a button does before it is remapped, as a remapper label. */
const DEFAULT_ACTION: Partial<Record<KeychronButtonId, string>> = {
  left: "Left Click",
  right: "Right Click",
  middle: "Middle Click",
  backward: "Back",
  forward: "Forward",
  upScroll: "Scroll Up",
  downScroll: "Scroll Down",
  leftScroll: "Scroll Left",
  rightScroll: "Scroll Right",
  dpiLoop: "DPI Loop",
};

export type KeychronButton = { name: string; index: number; defaultAction: string };

/** A model's buttons named after their default function; repeats get a number ("Forward 2"). */
export function keychronButtons(model: KeychronLauncherMouse | undefined): KeychronButton[] {
  const seen = new Map<string, number>();
  return (model?.buttons ?? []).map(([index, id]) => {
    const base = BUTTON_NAME[id];
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return { name: count > 1 ? `${base} ${count}` : base, index, defaultAction: DEFAULT_ACTION[id] ?? "Default" };
  });
}

// Lift-off ──────────────────────────────────────────────────────────────

/** Firmware codes on the PAW3950/3395 family: 1 = 1 mm, 2 = 2 mm, 3 = 0.7 mm. */
export const KEYCHRON_STANDARD_LOD: ReadonlyArray<readonly [number, number]> = [[3, 0.7], [1, 1], [2, 2]];

export type KeychronLiftOff = Pick<MouseStatus, "liftOffDistance" | "supportedLiftOffDistances" | "liftOffScale">
  & { note?: string };

/**
 * Up to three choices become the Low/Medium/High stops (two become Low and
 * High); more become the lift-off slider, whose labels assume even steps.
 */
export function keychronLiftOff(choices: ReadonlyArray<readonly [number, number]>, current: number): KeychronLiftOff {
  const sorted = [...choices].sort((a, b) => a[1] - b[1]);
  if (!sorted.length) return { liftOffDistance: null };
  if (sorted.length > 3) {
    const byLevel = [...choices].sort((a, b) => a[0] - b[0]);
    const first = byLevel[0]!;
    const last = byLevel[byLevel.length - 1]!;
    const value = choices.find(([code]) => code === current) ?? first;
    return {
      liftOffDistance: null,
      liftOffScale: {
        value: value[0],
        min: first[0],
        max: last[0],
        millimetres: value[1],
        minMillimetres: first[1],
        maxMillimetres: last[1],
      },
    };
  }
  const stops = keychronLiftOffStops(sorted);
  const level = stops.find(([, code]) => code === current)?.[0] ?? null;
  return {
    liftOffDistance: level,
    supportedLiftOffDistances: stops.map(([name]) => name),
    note: `Lift-off: ${stops.map(([name, , mm]) => `${name} is ${mm} mm`).join(", ")}.`,
  };
}

/** [stop, code, millimetres] for three or fewer choices, lowest first. */
export function keychronLiftOffStops(choices: ReadonlyArray<readonly [number, number]>): Array<[LiftOff, number, number]> {
  const sorted = [...choices].sort((a, b) => a[1] - b[1]);
  const names: LiftOff[] = sorted.length === 3 ? ["Low", "Medium", "High"] : sorted.length === 2 ? ["Low", "High"] : ["Medium"];
  return sorted.map(([code, mm], index) => [names[index]!, code, mm]);
}

// Lighting ──────────────────────────────────────────────────────────────

/** Launcher's light effects (json.light); 5 (one-colour flow) and 6 (flash) have no panel equivalent. */
const LIGHT_MODE: ReadonlyArray<readonly [number, MouseLightingMode]> = [
  [0, "Off"],
  [1, "Static"],
  [2, "Breathing single"],
  [3, "Spectrum"],
  [4, "Wave"],
];
const LIGHT_BRIGHTNESS = [25, 50, 75, 100] as const;
const LIGHT_SPEEDS = [1, 2, 3, 4, 5] as const;

export type KeychronLight = { mode: number; brightness: number; speed: number; rgb: [number, number, number] };

/** The panel's view of a light state; Launcher's sliders run 0-255 for brightness and speed. */
export function keychronLighting(light: KeychronLight, offered: readonly number[]): MouseLighting {
  const modes = LIGHT_MODE.filter(([code]) => code === 0 || offered.includes(code)).map(([, mode]) => mode);
  const mode = LIGHT_MODE.find(([code]) => code === light.mode)?.[1] ?? null;
  return {
    zone: "Mouse",
    modes,
    mode,
    color: `#${light.rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`,
    color2: null,
    colorModes: modes.filter((entry) => entry === "Static" || entry === "Breathing single"),
    dualColorModes: [],
    reactiveModes: modes.filter((entry) => entry !== "Off" && entry !== "Static"),
    speeds: [...LIGHT_SPEEDS],
    speed: Math.max(1, Math.round((light.speed * LIGHT_SPEEDS.length) / 255)),
    brightness: nearest(LIGHT_BRIGHTNESS, Math.round((light.brightness * 100) / 255)),
    brightnessLevels: [...LIGHT_BRIGHTNESS],
  };
}

/** The panel's lighting as the mouse's codes. */
export function keychronEncodeLighting(lighting: MouseLighting, offered: readonly number[]): KeychronLight {
  const mode = LIGHT_MODE.find(([code, name]) => name === lighting.mode && (code === 0 || offered.includes(code)))?.[0];
  if (mode === undefined) throw new Error(`This Keychron mouse has no ${lighting.mode ?? "unknown"} lighting effect.`);
  const hex = /^#([0-9a-f]{6})$/i.exec(lighting.color ?? "")?.[1] ?? "ffffff";
  return {
    mode,
    brightness: Math.round(((lighting.brightness ?? 100) * 255) / 100),
    speed: Math.round(((lighting.speed ?? LIGHT_SPEEDS.length) * 255) / LIGHT_SPEEDS.length),
    rgb: [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [number, number, number],
  };
}

function nearest(values: readonly number[], target: number): number {
  return values.reduce((best, value) => (Math.abs(value - target) < Math.abs(best - target) ? value : best), values[0]!);
}

export function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

export function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}
