import type { MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_4K_MICE as MICE,
  KEYCHRON_4K_USAGE as USAGE,
  KEYCHRON_4K_USAGE_PAGE as USAGE_PAGE,
  KEYCHRON_8K_NORDIC_PRODUCT_IDS,
  KEYCHRON_M6_USAGE_PAGE,
  KEYCHRON_VENDOR_ID,
} from "@openmouse/protocol/keychron";
import { orbitalFinishPacket } from "@openmouse/protocol/orbital";

const PACKET_LENGTH = 64;
const QUERY_TIMEOUT_MS = 1500;
const DPI_STAGE_COUNT = 5;
/** Every 4K model config (launcher.keychron.com/static/device/<vpid>/json/v3.json) says 100-26000. */
const DPI_MIN = 100;
const DPI_MAX = 26_000;
const DPI_STEP = 50;
/** The same configs list these five rates for every 4K model. */
const POLLING_RATES = [125, 500, 1000, 2000, 4000] as const;
/** Settings byte 43. The configs offer 1 = 1 mm and 2 = 2 mm, nothing else. */
const LOD_BY_LEVEL = { Low: 1, High: 2 } as const;
const DEBOUNCE_MAX_MS = 20;
const PROFILE_COUNT = 5;
/** Settings byte 4. Launcher writes only these bits back (bit 7 is wheel direction) and clears the rest. */
const FLAG = { angleSnapping: 0x01, rippleControl: 0x10, motionSync: 0x20 } as const;
const WRITABLE_FLAGS = 0xb1;

/** Bytes 0, 2 and 3 of each command; byte 2 is 0x80 | payload length. */
const CMD = {
  version: [0x00, 0x81, 0x00],
  power: [0x01, 0x81, 0x01],
  profile: [0x02, 0x82, 0x01],
  readSettings: [0x04, 0x81, 0x01],
  writeSettings: [0x04, 0xb5, 0x02],
  save: [0x0a, 0x81, 0x01],
} as const;
type Command = (typeof CMD)[keyof typeof CMD];

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;
type Flag = keyof typeof FLAG;

type Settings = {
  flags: number;
  pollingIndex: number;
  stageCount: number;
  activeDpiStage: number;
  dpiStages: number[];
  lod: number;
  sleepSeconds: number;
  debounceMs: number;
};

type Power = { state: number; percent: number; profile: number };
type Identity = { name: string; firmware: string | null };

/**
 * Keychron M4 4K, M6 4K, M3 4K, M3 Mini 4K and M2 4K on their 0xff0a
 * collection, wired or through the 4K receiver. Every packet is 64 bytes on
 * report 0 with the checksum in byte 63; replies echo bytes 0 and 3, with
 * 0x40 added to byte 0 when they come back through the receiver.
 *
 * Settings reply (0x04/0x81/0x01), the same block the 0x04/0xb5/0x02 write sends:
 *   [4]      flags: bit 0 angle snapping, 4 ripple control, 5 motion sync, 7 wheel direction
 *   [5]      polling: 0 = 125 Hz, otherwise index + 1 into POLLING_RATES
 *   [6]      enabled-stage mask (1, 3, 7, 15, 31); [7] active stage
 *   [8..27]  five stages of X then Y DPI, little-endian 16-bit
 *   [43]     lift-off code; [52..53] sleep in seconds; [54] debounce in ms
 * Power reply (0x01/0x81/0x01): [5] charge state, [6] battery percent, [7] profile.
 * Version reply (0x00/0x81/0x00): [4..5] model ID, [9] major, [8] minor and patch nibbles.
 * Writes are followed by a save (0x0a/0x81/0x01), as Launcher does.
 */
export class Keychron4kHidClient {
  readonly device: HIDDevice;
  /** Anything that is not a known wired mouse is taken to be the 4K receiver. */
  private readonly receiver: boolean;
  private listening = false;
  private identity: Identity | null = null;
  private waiter: {
    match: (bytes: Uint8Array) => boolean;
    resolve: (bytes: Uint8Array) => void;
    reject: (reason: Error) => void;
  } | null = null;

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (!this.waiter) return;
    const bytes = new Uint8Array(event.data.buffer.slice(
      event.data.byteOffset,
      event.data.byteOffset + event.data.byteLength,
    ));
    if (!this.waiter.match(bytes)) return;
    const waiter = this.waiter;
    this.waiter = null;
    waiter.resolve(bytes);
  };

  constructor(device: HIDDevice) {
    this.device = device;
    this.receiver = !MICE.some((mouse) => mouse.productId === device.productId);
  }

  /**
   * Launcher prefers the M6's 0xffc1 protocol when a device offers both, so
   * this does too. The 8K Nordic mice and receivers share the collection and
   * go to their own driver.
   */
  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KEYCHRON_VENDOR_ID
      && !KEYCHRON_8K_NORDIC_PRODUCT_IDS.includes(device.productId)
      && device.collections.some((collection) => collection.usagePage === USAGE_PAGE && collection.usage === USAGE)
      && !device.collections.some((collection) => collection.usagePage === KEYCHRON_M6_USAGE_PAGE);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.listening) {
      this.device.addEventListener("inputreport", this.onInputReport);
      this.listening = true;
    }
  }

  async close(): Promise<void> {
    if (this.listening) {
      this.device.removeEventListener("inputreport", this.onInputReport);
      this.listening = false;
    }
    this.waiter?.reject(new Error(`The ${this.label} was closed.`));
    this.waiter = null;
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    return Array.from({ length: (DPI_MAX - DPI_MIN) / DPI_STEP + 1 }, (_, index) => DPI_MIN + index * DPI_STEP);
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const identity = await this.readIdentity();
    const settings = await this.readSettings();
    const power = await this.readPower();
    const liftOffDistance = (Object.keys(LOD_BY_LEVEL) as LiftOff[])
      .find((level) => LOD_BY_LEVEL[level as keyof typeof LOD_BY_LEVEL] === settings.lod) ?? null;
    return {
      brand: "Keychron",
      name: identity.name,
      ui: {
        family: "keychron-4k",
        defaultDisplayName: identity.name,
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
        statusNote: "Lift-off: Low is 1 mm, High is 2 mm.",
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: true,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: power.percent <= 100 ? power.percent : null,
      batteryState: power.state === 2 ? "Full" : power.state === 1 || power.state === 3 ? "Charging" : "Discharging",
      dpi: settings.dpiStages[settings.activeDpiStage] ?? settings.dpiStages[0] ?? 800,
      dpiStages: settings.dpiStages.slice(0, settings.stageCount),
      activeDpiStage: settings.activeDpiStage,
      pollingRateHz: POLLING_RATES[settings.pollingIndex] ?? 1000,
      supportedPollingRates: [...POLLING_RATES],
      activeProfile: power.profile + 1,
      profileCount: PROFILE_COUNT,
      connectionType: this.receiver ? "Wireless" : "Wired",
      connectionDetail: this.receiver ? "2.4 GHz (Keychron 4K receiver)" : "Wired USB",
      liftOffDistance,
      supportedLiftOffDistances: Object.keys(LOD_BY_LEVEL) as LiftOff[],
      motionSync: (settings.flags & FLAG.motionSync) !== 0,
      angleSnapping: (settings.flags & FLAG.angleSnapping) !== 0,
      rippleControl: (settings.flags & FLAG.rippleControl) !== 0,
      debounceMs: settings.debounceMs,
      firmware: [identity.firmware ?? "Firmware unavailable"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    this.requireDpi(dpi);
    const settings = await this.readSettings();
    return this.setDpiStageValue(settings.activeDpiStage, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.requireDpi(dpi);
    const settings = await this.readSettings();
    this.requireStage(stage, settings.stageCount);
    const dpiStages = settings.dpiStages.slice();
    dpiStages[stage] = dpi;
    const confirmed = (await this.write({ ...settings, dpiStages })).dpiStages[stage];
    if (confirmed !== dpi) throw new Error(`The ${this.label} kept ${confirmed} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const settings = await this.readSettings();
    this.requireStage(stage, settings.stageCount);
    const confirmed = (await this.write({ ...settings, activeDpiStage: stage })).activeDpiStage;
    if (confirmed !== stage) throw new Error(`The ${this.label} kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > DPI_STAGE_COUNT) {
      throw new Error(`The ${this.label} holds between 1 and ${DPI_STAGE_COUNT} DPI stages.`);
    }
    const settings = await this.readSettings();
    const activeDpiStage = Math.min(settings.activeDpiStage, count - 1);
    const confirmed = (await this.write({ ...settings, stageCount: count, activeDpiStage })).stageCount;
    if (confirmed !== count) throw new Error(`The ${this.label} kept ${confirmed} DPI stages instead of ${count}.`);
    return confirmed;
  }

  async setPollingRate(rateHz: number): Promise<number> {
    const pollingIndex = POLLING_RATES.indexOf(rateHz as (typeof POLLING_RATES)[number]);
    if (pollingIndex < 0) throw new Error(`The ${this.label} does not support ${rateHz} Hz.`);
    const settings = await this.readSettings();
    const actual = POLLING_RATES[(await this.write({ ...settings, pollingIndex })).pollingIndex];
    if (actual !== rateHz) throw new Error(`The ${this.label} kept ${actual ?? "an unknown rate"} Hz instead of ${rateHz} Hz.`);
    return actual;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    const code = LOD_BY_LEVEL[lod as keyof typeof LOD_BY_LEVEL];
    if (code === undefined) throw new Error(`The ${this.label} has no ${lod} lift-off distance.`);
    const settings = await this.readSettings();
    const confirmed = (await this.write({ ...settings, lod: code })).lod;
    if (confirmed !== code) throw new Error(`The ${this.label} kept lift-off code ${confirmed}.`);
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return this.writeFlag("motionSync", enabled);
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.writeFlag("angleSnapping", enabled);
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return this.writeFlag("rippleControl", enabled);
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`The ${this.label} debounce must be between 0 and ${DEBOUNCE_MAX_MS} ms.`);
    }
    const settings = await this.readSettings();
    const confirmed = (await this.write({ ...settings, debounceMs })).debounceMs;
    if (confirmed !== debounceMs) throw new Error(`The ${this.label} kept ${confirmed} ms debounce instead of ${debounceMs} ms.`);
    return confirmed;
  }

  /** Switch the onboard profile (1-based, as the panel numbers them). */
  async setProfile(profile: number): Promise<number> {
    if (!Number.isInteger(profile) || profile < 1 || profile > PROFILE_COUNT) {
      throw new Error(`The ${this.label} profile must be between 1 and ${PROFILE_COUNT}.`);
    }
    await this.readIdentity();
    const packet = commandPacket(CMD.profile);
    packet[4] = profile - 1;
    await this.request(packet, replyTo(CMD.profile));
    // The ack can arrive before the switch lands, so wait for the power report to show it.
    let current = -1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      current = (await this.readPower()).profile;
      if (current === profile - 1) return profile;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`The ${this.label} stayed on profile ${current + 1}.`);
  }

  private get label(): string {
    return this.identity?.name ?? "Keychron mouse";
  }

  private async writeFlag(flag: Flag, enabled: boolean): Promise<boolean> {
    const settings = await this.readSettings();
    const flags = enabled ? settings.flags | FLAG[flag] : settings.flags & ~FLAG[flag];
    const confirmed = ((await this.write({ ...settings, flags })).flags & FLAG[flag]) !== 0;
    if (confirmed !== enabled) throw new Error(`The ${this.label} kept ${flag} ${confirmed ? "on" : "off"}.`);
    return confirmed;
  }

  /** Sends the whole settings block the way Launcher builds it, saves, and reads it back. */
  private async write(next: Settings): Promise<Settings> {
    const packet = commandPacket(CMD.writeSettings);
    packet[4] = next.flags & WRITABLE_FLAGS;
    packet[5] = next.pollingIndex > 0 ? next.pollingIndex + 1 : 0;
    packet[6] = (1 << next.stageCount) - 1;
    packet[7] = next.activeDpiStage;
    next.dpiStages.forEach((dpi, stage) => {
      writeU16(packet, 8 + stage * 4, dpi);
      writeU16(packet, 10 + stage * 4, dpi);
    });
    packet[43] = next.lod;
    writeU16(packet, 50, next.sleepSeconds);
    writeU16(packet, 52, next.sleepSeconds);
    packet[54] = next.debounceMs;
    await this.request(packet, replyTo(CMD.writeSettings));
    await this.request(commandPacket(CMD.save), (bytes) => ((bytes[0] ?? 0) & 0xbf) === CMD.save[0]);
    return await this.readSettings();
  }

  private requireDpi(dpi: number): void {
    if (!Number.isInteger(dpi) || dpi < DPI_MIN || dpi > DPI_MAX || dpi % DPI_STEP !== 0) {
      throw new Error(`The ${this.label} DPI must be a multiple of ${DPI_STEP} between ${DPI_MIN} and ${DPI_MAX}.`);
    }
  }

  private requireStage(stage: number, stageCount: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
      throw new Error(`DPI stage must be between 1 and ${stageCount}.`);
    }
  }

  /**
   * Read once per connection. The first power query goes to whichever device
   * is plugged in (receiver or mouse) and rejects Launcher's "8k_nordic"
   * variant, whose reply carries Keychron's vendor ID where a 4K mouse keeps
   * its battery and profile. The version query is routed to the mouse, so over
   * the receiver its model ID says which 4K mouse is on the other end.
   */
  private async readIdentity(): Promise<Identity> {
    await this.open();
    if (this.identity) return this.identity;
    // Strict match: a routed live report from the mouse (0x41) must not stand in for the receiver's own answer.
    const handshake = await this.request(commandPacket(CMD.power), (bytes) => bytes[0] === CMD.power[0] && bytes[3] === CMD.power[2], false);
    if ((handshake[6] === 0x34 && handshake[7] === 0x34) || (handshake[6] === 0x2d && handshake[7] === 0x36)) {
      throw new Error(`This Keychron device (product ID 0x${this.device.productId.toString(16).padStart(4, "0")}) uses the 8K Nordic protocol, but OpenMouse does not know it yet. Please report the ID.`);
    }
    const version = await this.request(commandPacket(CMD.version), replyTo(CMD.version)).catch(() => null);
    const modelId = version ? readU16(version, 4) : -1;
    const mouse = MICE.find((entry) => entry.productId === this.device.productId)
      ?? MICE.find((entry) => entry.modelId === modelId);
    this.identity = {
      name: mouse?.name ?? "Keychron 4K mouse",
      firmware: version ? `v${version[9]}.${(version[8] ?? 0) >> 4}.${(version[8] ?? 0) & 0x0f}` : null,
    };
    return this.identity;
  }

  private async readSettings(): Promise<Settings> {
    // Every write reads first, so this keeps the 8K Nordic check ahead of any write.
    await this.readIdentity();
    const bytes = await this.request(commandPacket(CMD.readSettings), replyTo(CMD.readSettings));
    let stageCount = 0;
    for (let mask = bytes[6] ?? 0; mask; mask >>= 1) stageCount += mask & 1;
    stageCount = Math.min(stageCount || DPI_STAGE_COUNT, DPI_STAGE_COUNT);
    const polling = bytes[5] ?? 0;
    return {
      flags: bytes[4] ?? 0,
      pollingIndex: polling > 1 ? polling - 1 : 0,
      stageCount,
      activeDpiStage: Math.min(bytes[7] ?? 0, stageCount - 1),
      dpiStages: Array.from({ length: DPI_STAGE_COUNT }, (_, stage) => readU16(bytes, 8 + stage * 4)),
      lod: bytes[43] ?? 0,
      sleepSeconds: readU16(bytes, 52),
      debounceMs: bytes[54] ?? 0,
    };
  }

  private async readPower(): Promise<Power> {
    const bytes = await this.request(commandPacket(CMD.power), replyTo(CMD.power));
    return { state: bytes[5] ?? 0, percent: bytes[6] ?? 0, profile: Math.min(bytes[7] ?? 0, PROFILE_COUNT - 1) };
  }

  /** Routes through the receiver unless told not to, then fills in the checksum. */
  private async request(packet: Uint8Array, match: (bytes: Uint8Array) => boolean, route = true): Promise<Uint8Array> {
    if (this.waiter) throw new Error(`Another ${this.label} request is already in progress.`);
    const finished = new Uint8Array(orbitalFinishPacket(packet, this.receiver && route));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let fail: (reason: Error) => void = () => undefined;
    const response = new Promise<Uint8Array>((resolve, reject) => {
      fail = reject;
      timeout = setTimeout(() => {
        this.waiter = null;
        reject(new Error(this.receiver
          ? `The ${this.label} did not answer through the receiver. Wake the mouse and try again.`
          : `The ${this.label} did not answer command 0x${packet[0]?.toString(16)}.`));
      }, QUERY_TIMEOUT_MS);
      this.waiter = { match, resolve, reject };
    });
    void response.catch(() => undefined);
    try {
      await this.device.sendReport(0, finished);
    } catch (error) {
      this.waiter = null;
      fail(new Error(`Chrome could not write the ${this.label} HID report. ${error instanceof Error ? error.message : String(error)}`));
    }
    try {
      return await response;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function commandPacket(command: Command): Uint8Array {
  const packet = new Uint8Array(PACKET_LENGTH);
  packet[0] = command[0];
  packet[2] = command[1];
  packet[3] = command[2];
  return packet;
}

/** Replies echo bytes 0 and 3; the receiver adds 0x40 to byte 0. */
function replyTo(command: Command): (bytes: Uint8Array) => boolean {
  return (bytes) => ((bytes[0] ?? 0) & 0xbf) === command[0] && bytes[3] === command[2];
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}
