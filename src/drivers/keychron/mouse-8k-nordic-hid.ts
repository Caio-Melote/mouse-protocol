import type { MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_4K_USAGE as USAGE,
  KEYCHRON_4K_USAGE_PAGE as USAGE_PAGE,
  KEYCHRON_8K_NORDIC_MICE as MICE,
  KEYCHRON_8K_NORDIC_PRODUCT_IDS as PRODUCT_IDS,
  KEYCHRON_VENDOR_ID,
  LEMOKEY_VENDOR_ID,
} from "@openmouse/protocol/keychron";
import { orbitalFinishPacket } from "@openmouse/protocol/orbital";

const PACKET_LENGTH = 64;
const QUERY_TIMEOUT_MS = 1000;
/** Launcher's receiver queue resends an unanswered command three times; wired it sends once. */
const RECEIVER_RESENDS = 3;
const DPI_STAGE_COUNT = 5;
/** The G3 Air config (launcher.keychron.com/static/device/875876471/json/v3.json) says 100-30000; Launcher steps by 50. */
const DPI_MIN = 100;
const DPI_MAX = 30_000;
const DPI_STEP = 50;
/** Launcher's POLLING_RATE_VALUE_SCALE. Gear table bytes are an index into it plus one, with 0 for 125 Hz. */
const POLLING_RATES = [125, 500, 1000, 2000, 4000, 8000] as const;
const POLLING_GEARS = 6;
/** Sensor byte 11, per the G3 Air config: 0 = 0.7 mm, 1 = 1 mm, 2 = 2 mm. */
const LOD_BY_LEVEL = { Low: 0, Medium: 1, High: 2 } as const;
/** Launcher's angle slider; the byte is signed. */
const ANGLE_LIMIT = 90;
const DEBOUNCE_MAX_MS = 20;
/** Launcher takes 1-240 minutes and stores seconds. These are the M6 driver's choices. */
const SLEEP_MINUTES = [1, 3, 5, 10, 15, 30, 60, 120, 240] as const;
const SLEEP_MAX_MINUTES = 240;
const PROFILE_COUNT = 5;
/** From this firmware the system block holds a second polling gear set for 2.4 GHz. */
const SEPARATE_RATES_FIRMWARE = [1, 6, 0] as const;

/** Bytes 0, 2 and 3 of each command; byte 2 is 0x80 | payload length. */
const CMD = {
  version: [0x00, 0x81, 0x00],
  status: [0x01, 0x81, 0x01],
  profile: [0x02, 0x82, 0x02],
  readButtons: [0x03, 0x81, 0x01],
  writeButton: [0x03, 0x85, 0x04],
  readSensor: [0x04, 0x81, 0x01],
  writeSensor: [0x04, 0xbc, 0x02],
  readSystem: [0x04, 0x83, 0x03],
  /** 24-byte payload; 32 bytes (0xa0) once the 2.4 GHz gear set exists. */
  writeSystem: [0x04, 0x98, 0x04],
  save: [0x0a, 0x81, 0x01],
} as const;
type Command = (typeof CMD)[keyof typeof CMD];

/** Physical buttons by their index in the 0x03 table (the G3 Air config's key list). */
const BUTTONS = [
  { name: "Left", index: 0 },
  { name: "Right", index: 1 },
  { name: "Middle", index: 2 },
  { name: "Back", index: 4 },
  { name: "Forward", index: 3 },
] as const;
/**
 * Four-byte button codes from the key enums Launcher's 8k_nordic commands use
 * (its 4K set, webpack module 45710): mouse buttons are 01 00 f0-f4 00, the
 * same table the GearHub driver confirmed on hardware.
 */
const BUTTON_ACTIONS: ReadonlyArray<readonly [string, readonly [number, number, number, number]]> = [
  ["Left Click", [0x01, 0x00, 0xf0, 0x00]],
  ["Right Click", [0x01, 0x00, 0xf1, 0x00]],
  ["Middle Click", [0x01, 0x00, 0xf2, 0x00]],
  ["Back", [0x01, 0x00, 0xf3, 0x00]],
  ["Forward", [0x01, 0x00, 0xf4, 0x00]],
  ["DPI Loop", [0x07, 0x00, 0x03, 0x00]],
  ["DPI +", [0x07, 0x00, 0x01, 0x00]],
  ["DPI -", [0x07, 0x00, 0x02, 0x00]],
  ["Disabled", [0x00, 0x00, 0x00, 0x00]],
];
const MACRO_CODE = 0x09;

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;
type SensorFlag = "angleSnapping" | "rippleControl" | "motionSync" | "maxSpeed";

export type KeychronNordicSensor = {
  angleSnapping: boolean;
  rippleControl: boolean;
  motionSync: boolean;
  /** Launcher's "20K FPS" switch (maxSpeedMode). */
  maxSpeed: boolean;
  /** Bytes 7, 9 and 10 (full-speed mode, lift-down, glass mode). Launcher never edits them. */
  reserved: [number, number, number];
  lod: number;
  angle: number;
  activeStage: number;
  stageCount: number;
  /** Five X/Y pairs; only the first `stageCount` are in use. */
  stages: Array<[number, number]>;
  /** Stage indicator colours, 5 x RGB. */
  colors: number[];
};

export type KeychronNordicGears = {
  /** The active gear: an index into `rates`, not a rate. */
  level: number;
  /** How many gears the polling button cycles through. */
  count: number;
  /** Six indexes into POLLING_RATES. */
  rates: number[];
};

export type KeychronNordicSystem = {
  sleepSeconds: number;
  bleSleepSeconds: number;
  debounceMs: number;
  /** Bytes 10-19: quick response, wake sources, wheel reverse, key modes, RF power, BLE slot. */
  reserved: number[];
  /** The USB set (shared before firmware 1.6.0), then the 2.4 GHz set. */
  gears: [KeychronNordicGears, KeychronNordicGears];
};

type Power = { state: number; percent: number; profile: number };
type Identity = { firmware: string; separateRates: boolean };

/**
 * Keychron Launcher's "8k_nordic" mouse protocol (Keychron G3 Air), decoded
 * from Launcher (main.be11320b2a72b61b.js, webpack module 20706) and not yet
 * confirmed on hardware. It shares the 4K family's collection and framing:
 * 64-byte report 0, byte 63 = 0xa1 - sum, 0x40 on byte 0 to route through
 * the receiver (echoed on the reply). The settings are Orbital's DMS v2
 * blocks, with Keychron's polling gear table added to the system block.
 * Every offset below is a packet offset; reads and writes share them.
 *
 * Sensor block (read 04/81/01, write 04/bc/02):
 *   [4..10]  angle snapping, ripple, motion sync, full speed, 20K FPS, lift-down, glass (0/1)
 *   [11]     lift-off code; [12] sensor angle, signed
 *   [13]     active stage; [14] enabled-stage mask (1, 3, 7, 15, 31)
 *   [15..34] five stages of X then Y DPI, little-endian 16-bit
 *   [43..57] five stage colours, RGB
 * System block (read 04/83/03, write 04/98/04 or 04/a0/04):
 *   [4..5]   sleep in seconds; [6..7] Bluetooth sleep; both little-endian
 *   [8]      active polling gear; [9] debounce in ms
 *   [10..19] quick response, wake sources, wheel reverse, key modes, RF power, BLE slot
 *   [20]     enabled-gear mask; [21..26] gear table
 *   [28..35] the same three fields for 2.4 GHz, from firmware 1.6.0
 * Status (01/81/01): [4] link, [6..9] vendor and product ID, [10] charge
 * state (3 counts as none), [11] battery percent, [12] profile. Sent to the
 * receiver unrouted, it answers itself with the paired mouse's IDs, which is
 * how Launcher tells this protocol from the 4K one.
 * Version (00/81/00): [9] major, [8] minor and patch nibbles.
 * Buttons: 03/81/01 returns a 4-byte code per index at [4 + 4i]; 03/85/04
 * writes one ([4] index, [5..8] code). Writes are followed by a save
 * (0a/81/01), as Launcher does; a profile switch (02/82/02) is not.
 */
export class Keychron8kNordicHidClient {
  readonly device: HIDDevice;
  /** Anything that is not a known wired mouse is one of the Ultra-Link 8K receivers. */
  private readonly receiver: boolean;
  private listening = false;
  private name: string | null = null;
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

  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KEYCHRON_VENDOR_ID
      && PRODUCT_IDS.includes(device.productId)
      && device.collections.some((collection) => collection.usagePage === USAGE_PAGE && collection.usage === USAGE);
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

  getSleepOptions(): number[] {
    return SLEEP_MINUTES.map((minutes) => minutes * 60);
  }

  /** Falls back to the name alone when the mouse does not answer, e.g. asleep behind its receiver. */
  async readStatus(): Promise<MouseStatus> {
    const name = await this.readName();
    let identity: Identity;
    let sensor: KeychronNordicSensor;
    let system: KeychronNordicSystem;
    let power: Power;
    try {
      identity = await this.readIdentity();
      sensor = await this.readSensor();
      system = await this.readSystem();
      power = await this.readPower();
    } catch {
      return this.unreachableStatus(name);
    }
    const buttons = await this.readButtons().catch(() => null);
    const gears = system.gears[this.gearSet(identity)];
    const pollingRateHz = POLLING_RATES[gears.rates[gears.level] ?? -1] ?? 1000;
    const liftOffDistance = (Object.keys(LOD_BY_LEVEL) as Array<keyof typeof LOD_BY_LEVEL>)
      .find((level) => LOD_BY_LEVEL[level] === sensor.lod) ?? null;
    return {
      brand: "Keychron",
      name,
      ui: {
        family: "keychron-8k-nordic",
        defaultDisplayName: name,
        hideUnsupportedPollingRates: true,
        forceShowBattery: true,
        statusNote: "Lift-off: Low is 0.7 mm, Medium is 1 mm, High is 2 mm.",
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: true,
          minDpi: DPI_MIN,
          maxDpi: DPI_MAX,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: power.percent <= 100 ? power.percent : null,
      batteryState: power.state === 2 ? "Full" : power.state === 1 ? "Charging" : "Discharging",
      dpi: sensor.stages[sensor.activeStage]?.[0] ?? 800,
      dpiStages: sensor.stages.slice(0, sensor.stageCount).map(([x]) => x),
      activeDpiStage: sensor.activeStage,
      pollingRateHz,
      supportedPollingRates: [...POLLING_RATES],
      activeProfile: power.profile + 1,
      profileCount: PROFILE_COUNT,
      connectionType: this.receiver ? "Wireless" : "Wired",
      connectionDetail: this.receiver ? "2.4 GHz (Keychron Ultra-Link 8K)" : "Wired USB",
      liftOffDistance,
      supportedLiftOffDistances: Object.keys(LOD_BY_LEVEL) as LiftOff[],
      motionSync: sensor.motionSync,
      angleSnapping: sensor.angleSnapping,
      rippleControl: sensor.rippleControl,
      performanceMode: sensor.maxSpeed,
      angleTuning: sensor.angle,
      debounceMs: system.debounceMs,
      sleepTimeout: system.sleepSeconds > 0 ? system.sleepSeconds : null,
      ...(buttons ? {
        buttonMappings: Object.fromEntries(BUTTONS.map(({ name: button, index }) => [button, keychronNordicButtonLabel(buttons[index]!)])),
        buttonOptions: BUTTON_ACTIONS.map(([label]) => label),
      } : {}),
      firmware: [identity.firmware],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    this.requireDpi(dpi);
    return this.setDpiStageValue((await this.readSensor()).activeStage, dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.requireDpi(dpi);
    const sensor = await this.readSensor();
    this.requireStage(stage, sensor.stageCount);
    // The panel edits one axis, so the stage gets X = Y; other stages keep their pairs.
    const stages = sensor.stages.map((pair, index): [number, number] => (index === stage ? [dpi, dpi] : pair));
    const [x, y] = (await this.writeSensor({ ...sensor, stages })).stages[stage] ?? [];
    if (x !== dpi || y !== dpi) throw new Error(`The ${this.label} kept ${x} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const sensor = await this.readSensor();
    this.requireStage(stage, sensor.stageCount);
    const confirmed = (await this.writeSensor({ ...sensor, activeStage: stage })).activeStage;
    if (confirmed !== stage) throw new Error(`The ${this.label} kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > DPI_STAGE_COUNT) {
      throw new Error(`The ${this.label} holds between 1 and ${DPI_STAGE_COUNT} DPI stages.`);
    }
    const sensor = await this.readSensor();
    const activeStage = Math.min(sensor.activeStage, count - 1);
    const confirmed = (await this.writeSensor({ ...sensor, stageCount: count, activeStage })).stageCount;
    if (confirmed !== count) throw new Error(`The ${this.label} kept ${confirmed} DPI stages instead of ${count}.`);
    return confirmed;
  }

  /**
   * Picks the gear that already holds the rate, or puts the rate in the
   * active gear, which is what Launcher's own assistant does.
   */
  async setPollingRate(rateHz: number): Promise<number> {
    const rate = POLLING_RATES.indexOf(rateHz as (typeof POLLING_RATES)[number]);
    if (rate < 0) throw new Error(`The ${this.label} does not support ${rateHz} Hz.`);
    const identity = await this.readIdentity();
    const system = await this.readSystem();
    const set = this.gearSet(identity);
    const gears = system.gears[set];
    const gear = gears.rates.slice(0, gears.count).indexOf(rate);
    const next: KeychronNordicGears = gear >= 0
      ? { ...gears, level: gear }
      : { ...gears, rates: gears.rates.map((value, index) => (index === gears.level ? rate : value)) };
    const updated: KeychronNordicSystem = { ...system, gears: set === 0 ? [next, system.gears[1]] : [system.gears[0], next] };
    const confirmed = (await this.writeSystem(updated)).gears[set];
    const actual = POLLING_RATES[confirmed.rates[confirmed.level] ?? -1];
    if (actual !== rateHz) throw new Error(`The ${this.label} kept ${actual ?? "an unknown rate"} Hz instead of ${rateHz} Hz.`);
    return actual;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    const code = LOD_BY_LEVEL[lod as keyof typeof LOD_BY_LEVEL];
    if (code === undefined) throw new Error(`The ${this.label} has no ${lod} lift-off distance.`);
    const confirmed = (await this.writeSensor({ ...(await this.readSensor()), lod: code })).lod;
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

  async setPerformanceMode(enabled: boolean): Promise<boolean> {
    return this.writeFlag("maxSpeed", enabled);
  }

  async setAngleTuning(degrees: number): Promise<number> {
    if (!Number.isInteger(degrees) || Math.abs(degrees) > ANGLE_LIMIT) {
      throw new Error(`The ${this.label} angle must be a whole number between -${ANGLE_LIMIT} and ${ANGLE_LIMIT} degrees.`);
    }
    const confirmed = (await this.writeSensor({ ...(await this.readSensor()), angle: degrees })).angle;
    if (confirmed !== degrees) throw new Error(`The ${this.label} kept a ${confirmed}° sensor angle instead of ${degrees}°.`);
    return confirmed;
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`The ${this.label} debounce must be between 0 and ${DEBOUNCE_MAX_MS} ms.`);
    }
    const confirmed = (await this.writeSystem({ ...(await this.readSystem()), debounceMs })).debounceMs;
    if (confirmed !== debounceMs) throw new Error(`The ${this.label} kept ${confirmed} ms debounce instead of ${debounceMs} ms.`);
    return confirmed;
  }

  /** Launcher writes the same timeout to the 2.4 GHz and Bluetooth fields. */
  async setSleepTimeout(seconds: number): Promise<number> {
    const minutes = seconds / 60;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > SLEEP_MAX_MINUTES) {
      throw new Error(`The ${this.label} sleeps after 1 to ${SLEEP_MAX_MINUTES} whole minutes.`);
    }
    const system = await this.readSystem();
    const confirmed = (await this.writeSystem({ ...system, sleepSeconds: seconds, bleSleepSeconds: seconds })).sleepSeconds;
    if (confirmed !== seconds) throw new Error(`The ${this.label} kept a ${confirmed} s sleep timeout instead of ${seconds} s.`);
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
    // The ack can arrive before the switch lands, so wait for the status report to show it.
    let current = -1;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      current = (await this.readPower()).profile;
      if (current === profile - 1) return profile;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error(`The ${this.label} stayed on profile ${current + 1}.`);
  }

  async setButtonMapping(button: string, action: string): Promise<void> {
    const slot = BUTTONS.find((entry) => entry.name === button);
    if (!slot) throw new Error(`The ${this.label} has no "${button}" button.`);
    const code = BUTTON_ACTIONS.find(([label]) => label === action)?.[1];
    if (!code) throw new Error(`Unknown button action "${action}".`);
    const codes = await this.readButtons();
    if (keychronNordicButtonLabel(codes[slot.index]!) === action) return;
    codes[slot.index] = [...code];
    if (!BUTTONS.some(({ index }) => keychronNordicButtonLabel(codes[index]!) === "Left Click")) {
      throw new Error("Keep at least one button as Left Click.");
    }
    const packet = commandPacket(CMD.writeButton);
    packet[4] = slot.index;
    packet.set(code, 5);
    await this.request(packet, replyTo(CMD.writeButton));
    await this.save();
    const confirmed = keychronNordicButtonLabel((await this.readButtons())[slot.index]!);
    if (confirmed !== action) throw new Error(`The ${this.label} kept ${confirmed} on ${button} instead of ${action}.`);
  }

  private get label(): string {
    return this.name ?? "Keychron mouse";
  }

  /** Which gear set this connection uses: 2.4 GHz has its own from firmware 1.6.0. */
  private gearSet(identity: Identity): 0 | 1 {
    return this.receiver && identity.separateRates ? 1 : 0;
  }

  private unreachableStatus(name: string): MouseStatus {
    return {
      brand: "Keychron",
      name,
      ui: {
        family: "keychron-8k-nordic",
        defaultDisplayName: name,
        settingsReady: false,
        statusNote: this.receiver
          ? "The mouse did not answer through the receiver. Wake it and reconnect."
          : "The mouse did not answer its settings reads. Reconnect it and try again.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: this.receiver ? "Wireless" : "Wired",
      liftOffDistance: null,
      firmware: this.identity ? [this.identity.firmware] : [],
    };
  }

  private async writeFlag(flag: SensorFlag, enabled: boolean): Promise<boolean> {
    const confirmed = (await this.writeSensor({ ...(await this.readSensor()), [flag]: enabled }))[flag];
    if (confirmed !== enabled) throw new Error(`The ${this.label} kept ${flag} ${confirmed ? "on" : "off"}.`);
    return confirmed;
  }

  private async writeSensor(next: KeychronNordicSensor): Promise<KeychronNordicSensor> {
    await this.request(keychronNordicEncodeSensor(next), replyTo(CMD.writeSensor));
    await this.save();
    return await this.readSensor();
  }

  private async writeSystem(next: KeychronNordicSystem): Promise<KeychronNordicSystem> {
    const identity = await this.readIdentity();
    await this.request(keychronNordicEncodeSystem(next, identity.separateRates), replyTo(CMD.writeSystem));
    await this.save();
    return await this.readSystem();
  }

  private async save(): Promise<void> {
    await this.request(commandPacket(CMD.save), (bytes) => ((bytes[0] ?? 0) & 0xbf) === CMD.save[0]);
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
   * Read once per connection. A receiver answers this handshake itself, so
   * it goes out unrouted; bytes 6-7 must carry Keychron's or Lemokey's vendor
   * ID (Launcher's test for this protocol) and bytes 8-9 name the paired mouse.
   * Every read and write passes through here first, so a receiver on another
   * protocol is refused before anything is written.
   */
  private async readName(): Promise<string> {
    await this.open();
    if (this.name) return this.name;
    let productId = this.device.productId;
    if (this.receiver) {
      // Strict match: a routed status report from the mouse (0x41) must not stand in for the receiver's answer.
      const handshake = await this.request(commandPacket(CMD.status), (bytes) => bytes[0] === CMD.status[0] && bytes[3] === CMD.status[2], false);
      const vendorId = readU16(handshake, 6);
      if (vendorId !== KEYCHRON_VENDOR_ID && vendorId !== LEMOKEY_VENDOR_ID) {
        throw new Error("This Keychron receiver did not report a paired 8K Nordic mouse.");
      }
      productId = readU16(handshake, 8);
    }
    this.name = MICE.find((mouse) => mouse.productId === productId)?.name ?? "Keychron 8K mouse";
    return this.name;
  }

  /** The mouse's firmware (routed), which decides the system block layout. */
  private async readIdentity(): Promise<Identity> {
    await this.readName();
    if (this.identity) return this.identity;
    const reply = await this.request(commandPacket(CMD.version), replyTo(CMD.version));
    const version = [reply[9] ?? 0, (reply[8] ?? 0) >> 4, (reply[8] ?? 0) & 0x0f];
    const newer = version.findIndex((part, index) => part !== SEPARATE_RATES_FIRMWARE[index]);
    this.identity = {
      firmware: `v${version.join(".")}`,
      separateRates: newer < 0 || version[newer]! > SEPARATE_RATES_FIRMWARE[newer]!,
    };
    return this.identity;
  }

  private async readSensor(): Promise<KeychronNordicSensor> {
    await this.readName();
    return keychronNordicDecodeSensor(await this.request(commandPacket(CMD.readSensor), replyTo(CMD.readSensor)));
  }

  private async readSystem(): Promise<KeychronNordicSystem> {
    await this.readName();
    return keychronNordicDecodeSystem(await this.request(commandPacket(CMD.readSystem), replyTo(CMD.readSystem)));
  }

  private async readPower(): Promise<Power> {
    await this.readName();
    const bytes = await this.request(commandPacket(CMD.status), replyTo(CMD.status));
    const state = bytes[10] ?? 0;
    return {
      state: state === 3 ? 0 : state,
      percent: bytes[11] ?? 0,
      profile: Math.min(bytes[12] ?? 0, PROFILE_COUNT - 1),
    };
  }

  /** Four-byte codes for every table index up to the last button. */
  private async readButtons(): Promise<number[][]> {
    await this.readName();
    const bytes = await this.request(commandPacket(CMD.readButtons), replyTo(CMD.readButtons));
    const last = Math.max(...BUTTONS.map(({ index }) => index));
    return Array.from({ length: last + 1 }, (_, index) => Array.from(bytes.slice(4 + index * 4, 8 + index * 4)));
  }

  /** Routes through the receiver unless told not to, fills in the checksum, and resends like Launcher's queue. */
  private async request(packet: Uint8Array, match: (bytes: Uint8Array) => boolean, route = true): Promise<Uint8Array> {
    const routed = this.receiver && route;
    const finished = new Uint8Array(orbitalFinishPacket(packet, routed));
    for (let resends = routed ? RECEIVER_RESENDS : 0; ; resends -= 1) {
      const reply = await this.exchange(finished, match);
      if (reply) return reply;
      if (resends === 0) {
        throw new Error(routed
          ? `The ${this.label} did not answer through the receiver. Wake the mouse and try again.`
          : `The ${this.label} did not answer command 0x${packet[0]?.toString(16)}.`);
      }
    }
  }

  /** One send; resolves null when no matching reply arrives in time. */
  private async exchange(packet: Uint8Array<ArrayBuffer>, match: (bytes: Uint8Array) => boolean): Promise<Uint8Array | null> {
    if (this.waiter) throw new Error(`Another ${this.label} request is already in progress.`);
    return await new Promise<Uint8Array | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, QUERY_TIMEOUT_MS);
      this.waiter = {
        match,
        resolve: (bytes) => {
          clearTimeout(timeout);
          resolve(bytes);
        },
        reject: (reason) => {
          clearTimeout(timeout);
          reject(reason);
        },
      };
      this.device.sendReport(0, packet).catch((error: unknown) => {
        this.waiter?.reject(new Error(`Chrome could not write the ${this.label} HID report. ${error instanceof Error ? error.message : String(error)}`));
        this.waiter = null;
      });
    });
  }
}

export function keychronNordicDecodeSensor(bytes: Uint8Array): KeychronNordicSensor {
  const stageCount = Math.min(countBits(bytes[14] ?? 0) || DPI_STAGE_COUNT, DPI_STAGE_COUNT);
  const angle = bytes[12] ?? 0;
  return {
    angleSnapping: Boolean(bytes[4]),
    rippleControl: Boolean(bytes[5]),
    motionSync: Boolean(bytes[6]),
    maxSpeed: Boolean(bytes[8]),
    reserved: [bytes[7] ?? 0, bytes[9] ?? 0, bytes[10] ?? 0],
    lod: bytes[11] ?? 0,
    // Launcher reads anything above its +90 limit as negative.
    angle: angle > ANGLE_LIMIT ? angle - 256 : angle,
    activeStage: Math.min(bytes[13] ?? 0, stageCount - 1),
    stageCount,
    stages: Array.from({ length: DPI_STAGE_COUNT }, (_, stage): [number, number] => [
      readU16(bytes, 15 + stage * 4),
      readU16(bytes, 17 + stage * 4),
    ]),
    colors: Array.from(bytes.slice(43, 58)),
  };
}

/** The sensor block exactly as Launcher builds it: every field it knows, zeros elsewhere. */
export function keychronNordicEncodeSensor(sensor: KeychronNordicSensor): Uint8Array {
  const packet = commandPacket(CMD.writeSensor);
  packet[4] = Number(sensor.angleSnapping);
  packet[5] = Number(sensor.rippleControl);
  packet[6] = Number(sensor.motionSync);
  packet[7] = sensor.reserved[0];
  packet[8] = Number(sensor.maxSpeed);
  packet[9] = sensor.reserved[1];
  packet[10] = sensor.reserved[2];
  packet[11] = sensor.lod;
  packet[12] = sensor.angle & 0xff;
  packet[13] = sensor.activeStage;
  packet[14] = (1 << sensor.stageCount) - 1;
  sensor.stages.forEach(([x, y], stage) => {
    writeU16(packet, 15 + stage * 4, x);
    writeU16(packet, 17 + stage * 4, y);
  });
  packet.set(sensor.colors.slice(0, 15), 43);
  return packet;
}

export function keychronNordicDecodeSystem(bytes: Uint8Array): KeychronNordicSystem {
  const gears = (levelAt: number, maskAt: number, tableAt: number): KeychronNordicGears => {
    const count = Math.min(countBits(bytes[maskAt] ?? 0) || POLLING_GEARS, POLLING_GEARS);
    return {
      level: Math.min(bytes[levelAt] ?? 0, count - 1),
      count,
      // Stored as rate index + 1; 0 (and the unused 1) mean 125 Hz.
      rates: Array.from(bytes.slice(tableAt, tableAt + POLLING_GEARS), (raw) => (raw > 0 ? raw - 1 : 0)),
    };
  };
  return {
    sleepSeconds: readU16(bytes, 4),
    bleSleepSeconds: readU16(bytes, 6),
    debounceMs: bytes[9] ?? 0,
    reserved: Array.from(bytes.slice(10, 20)),
    gears: [gears(8, 20, 21), gears(28, 29, 30)],
  };
}

/** Launcher sends the 2.4 GHz gear set only to firmware that has one. */
export function keychronNordicEncodeSystem(system: KeychronNordicSystem, separateRates: boolean): Uint8Array {
  const packet = commandPacket(CMD.writeSystem);
  if (separateRates) packet[2] = 0x80 | 32;
  writeU16(packet, 4, system.sleepSeconds);
  writeU16(packet, 6, system.bleSleepSeconds);
  packet[9] = system.debounceMs;
  packet.set(system.reserved.slice(0, 10), 10);
  const writeGears = (gears: KeychronNordicGears, levelAt: number, maskAt: number, tableAt: number): void => {
    packet[levelAt] = gears.level;
    packet[maskAt] = (1 << gears.count) - 1;
    gears.rates.forEach((rate, gear) => {
      packet[tableAt + gear] = rate > 0 ? rate + 1 : 0;
    });
  };
  writeGears(system.gears[0], 8, 20, 21);
  if (separateRates) writeGears(system.gears[1], 28, 29, 30);
  return packet;
}

/** "Macro" and "Custom" cover codes the remapper cannot offer (macros, keys, media). */
export function keychronNordicButtonLabel(code: readonly number[]): string {
  if (code[0] === MACRO_CODE) return "Macro";
  return BUTTON_ACTIONS.find(([, bytes]) => bytes.every((byte, index) => byte === code[index]))?.[0] ?? "Custom";
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

function countBits(value: number): number {
  let count = 0;
  for (let rest = value; rest; rest >>= 1) count += rest & 1;
  return count;
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
}
