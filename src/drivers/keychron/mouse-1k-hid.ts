import type { MouseLighting, MouseStatus } from "../mouse-types.ts";
import {
  KEYCHRON_1K_BUTTON_REPORT_ID as BUTTON_REPORT_ID,
  KEYCHRON_1K_REPORT_ID as REPORT_ID,
  KEYCHRON_1K_USAGE as USAGE,
  KEYCHRON_1K_USAGE_PAGE as USAGE_PAGE,
  KEYCHRON_M6_USAGE_PAGE,
  KEYCHRON_RECEIVERS,
  KEYCHRON_VENDOR_ID,
  type KeychronLauncherMouse,
} from "@openmouse/protocol/keychron";
import {
  KEYCHRON_DEBOUNCE_MAX_MS as DEBOUNCE_MAX_MS,
  KEYCHRON_DEFAULT_DPI as DEFAULT_DPI,
  KEYCHRON_DPI_STAGE_COUNT as DPI_STAGE_COUNT,
  KEYCHRON_DPI_STEP as DPI_STEP,
  KEYCHRON_POLLING_RATES as POLLING_RATES,
  KEYCHRON_SET,
  KEYCHRON_STANDARD_LOD as STANDARD_LOD,
  keychronActiveGear,
  keychronActiveStage,
  keychronButtonOptions,
  keychronButtons,
  keychronDecodeButton,
  keychronDecodeConnectedMouse,
  keychronDecodeSettings,
  keychronEncodeButton,
  keychronEncodeDebounce,
  keychronEncodeDpi,
  keychronEncodeLighting,
  keychronEncodeSensor,
  keychronLauncherFirmware,
  keychronLauncherMouse,
  keychronLighting,
  keychronLiftOff,
  keychronLiftOffStops,
  readU16,
  type KeychronButton,
  type KeychronLight,
  type KeychronSettings,
} from "./launcher-mouse.ts";

const REPORT_LENGTH = 20;
const BUTTON_REPORT_LENGTH = 64;
/** Launcher's receiver transceiver waits this long before it fetches the answer. */
const RECEIVER_ANSWER_DELAY_MS = 200;
const ANSWER_ATTEMPTS = 5;
const ANSWER_RETRY_MS = 50;
/** Launcher gives "1k" mice a fixed table: gears 0-2 are 125, 500 and 1000 Hz. */
const POLLING_TABLE = [0, 1, 2] as const;

/** Commands on feature report 0x51, except the two button ones, which use 0x52. */
const CMD = {
  receiverState: KEYCHRON_SET.receiverState,
  firmware: KEYCHRON_SET.firmware,
  identity: 0x06,
  status: 0x07,
  readLightMode: 0x12,
  readLight: 0x18,
  writeLightMode: 0x22,
  writeLightBrightness: 0x23,
  writeLightSpeed: 0x27,
  writeLightColor: 0x28,
  polling: KEYCHRON_SET.polling,
  readButton: KEYCHRON_SET.readButton,
  writeButton: KEYCHRON_SET.writeButton,
} as const;

type LiftOff = NonNullable<MouseStatus["liftOffDistance"]>;
type SensorFlag = "motionSync" | "angleSnapping" | "rippleControl";

type Identity = {
  firmware: string | null;
  /** 0 USB, 1 2.4 GHz. */
  workMode: number;
  productId: number | null;
  batteryPercent: number;
  /** Bits 0-1 of byte 11: 1 charging, 2 full. */
  powerState: number;
};

/**
 * Keychron Launcher's "1k" mouse protocol on usage page 0x8c: the "8k"
 * command set in 20-byte feature reports on 0x51 (answers fetched with a
 * feature read of the same report), with buttons on 64-byte feature report
 * 0x52. It has no sleep, profile, angle or 20K FPS commands and a fixed
 * 125/500/1000 Hz table. Decoded from Launcher (main.be11320b2a72b61b.js,
 * webpack modules 20706, 61892 and 8596), not yet confirmed on hardware, and
 * Launcher does not say which models use it.
 *
 * 0x06 identity: [1..2] protocol version, [3..4] vendor ID, [5..6] product
 * ID, [7..8] firmware, [9] low 3 bits connection, [10] battery percent,
 * [11] bits 0-1 power state. 0x07 status: bytes 1-17 of the "8k" status
 * report. 0x03 through a receiver lists the paired mice.
 */
export class Keychron1kHidClient {
  readonly device: HIDDevice;
  private identity: Identity | null = null;
  private model: KeychronLauncherMouse | null | undefined;
  /** Feature writes and reads come in pairs, so they run one at a time. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(device: HIDDevice) {
    this.device = device;
  }

  /** Launcher uses this collection only when the device has no 0xffc1 one. */
  static isSupported(device: HIDDevice): boolean {
    return device.vendorId === KEYCHRON_VENDOR_ID
      && device.collections.some((collection) =>
        collection.usagePage === USAGE_PAGE
        && collection.usage === USAGE
        && (collection.featureReports ?? []).some((report) => report.reportId === REPORT_ID))
      && !device.collections.some((collection) => collection.usagePage === KEYCHRON_M6_USAGE_PAGE);
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  getDpiOptions(): number[] {
    const [min, max] = this.model?.dpi ?? DEFAULT_DPI;
    return Array.from({ length: Math.floor((max - min) / DPI_STEP) + 1 }, (_, index) => min + index * DPI_STEP);
  }

  getDebounceOptions(): number[] {
    return Array.from({ length: DEBOUNCE_MAX_MS + 1 }, (_, ms) => ms);
  }

  /** Falls back to the name alone when the mouse does not answer, e.g. asleep behind its receiver. */
  async readStatus(): Promise<MouseStatus> {
    const identity = await this.readIdentity();
    const model = await this.readModel(identity);
    let settings: KeychronSettings;
    try {
      settings = await this.readSettings();
    } catch {
      return this.unreachableStatus(identity);
    }
    const power = await this.readPower().catch(() => identity);
    const buttons = await this.readButtons().catch(() => null);
    const light = model?.light ? await this.readLight().catch(() => null) : null;
    const lod = keychronLiftOff(this.lodChoices(), settings.lod);
    const activeStage = keychronActiveStage(settings, identity.workMode);
    const [min, max] = model?.dpi ?? DEFAULT_DPI;
    const sensorOptions = !model?.noSensorOptions;
    const name = this.label;

    return {
      brand: "Keychron",
      name,
      ui: {
        family: "keychron-1k",
        defaultDisplayName: name,
        hideUnsupportedPollingRates: true,
        hideSleepCard: true,
        forceShowBattery: true,
        ...(lod.note ? { statusNote: lod.note } : {}),
        ...(sensorOptions ? {} : { hideProcessingCard: true }),
        dpiStageEditor: {
          maxStages: DPI_STAGE_COUNT,
          countEditable: true,
          minDpi: min,
          maxDpi: max,
          stepDpi: DPI_STEP,
        },
      },
      batteryPercent: power.batteryPercent <= 100 ? power.batteryPercent : null,
      batteryState: power.powerState === 1 ? "Charging" : power.powerState === 2 ? "Full" : "Discharging",
      dpi: settings.dpiStages[activeStage] ?? settings.dpiStages[0] ?? 800,
      dpiStages: settings.dpiStages.slice(0, settings.stageCount),
      activeDpiStage: activeStage,
      pollingRateHz: this.pollingRate(settings, identity),
      supportedPollingRates: POLLING_TABLE.map((gear) => POLLING_RATES[gear]),
      activeProfile: null,
      connectionType: identity.workMode === 0 ? "Wired" : "Wireless",
      connectionDetail: identity.workMode === 0
        ? "Wired USB"
        : `2.4 GHz (${KEYCHRON_RECEIVERS.get(this.device.productId) ?? "Keychron receiver"})`,
      liftOffDistance: lod.liftOffDistance,
      ...(lod.supportedLiftOffDistances ? { supportedLiftOffDistances: lod.supportedLiftOffDistances } : {}),
      ...(sensorOptions ? {
        motionSync: settings.motionSync,
        angleSnapping: settings.angleSnapping,
        rippleControl: settings.rippleControl,
      } : {}),
      debounceMs: settings.debounceMs,
      ...(buttons ? {
        buttonMappings: Object.fromEntries(buttons.map(({ button, action }) => [button.name, action])),
        buttonOptions: keychronButtonOptions("1k"),
      } : {}),
      ...(light && model?.light ? { lighting: keychronLighting(light, model.light) } : {}),
      firmware: [identity.firmware ?? "Firmware unavailable"],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    const settings = await this.readSettings();
    return await this.setDpiStageValue(keychronActiveStage(settings, (await this.readIdentity()).workMode), dpi);
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    this.requireDpi(dpi);
    const settings = await this.readSettings();
    this.requireStage(stage, settings.stageCount);
    const identity = await this.readIdentity();
    const stages = settings.dpiStages.map((value, index) => (index === stage ? dpi : value));
    await this.write(REPORT_ID, keychronEncodeDpi(keychronActiveStage(settings, identity.workMode), stages, settings.stageCount));
    const confirmed = (await this.readSettings()).dpiStages[stage];
    if (confirmed !== dpi) throw new Error(`The ${this.label} kept ${confirmed} DPI on stage ${stage + 1} instead of ${dpi} DPI.`);
    return confirmed;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const settings = await this.readSettings();
    this.requireStage(stage, settings.stageCount);
    await this.write(REPORT_ID, keychronEncodeDpi(stage, settings.dpiStages, settings.stageCount));
    const confirmed = keychronActiveStage(await this.readSettings(), (await this.readIdentity()).workMode);
    if (confirmed !== stage) throw new Error(`The ${this.label} kept DPI stage ${confirmed + 1}.`);
    return confirmed;
  }

  async setDpiStageCount(count: number): Promise<number> {
    if (!Number.isInteger(count) || count < 1 || count > DPI_STAGE_COUNT) {
      throw new Error(`The ${this.label} holds between 1 and ${DPI_STAGE_COUNT} DPI stages.`);
    }
    const settings = await this.readSettings();
    const activeStage = Math.min(keychronActiveStage(settings, (await this.readIdentity()).workMode), count - 1);
    await this.write(REPORT_ID, keychronEncodeDpi(activeStage, settings.dpiStages, count));
    const confirmed = (await this.readSettings()).stageCount;
    if (confirmed !== count) throw new Error(`The ${this.label} kept ${confirmed} DPI stages instead of ${count}.`);
    return confirmed;
  }

  /** 0x41: the gear for both connection slots, then Launcher's table. */
  async setPollingRate(rateHz: number): Promise<number> {
    const gear = POLLING_TABLE.findIndex((value) => POLLING_RATES[value] === rateHz);
    if (gear < 0) throw new Error(`The ${this.label} does not support ${rateHz} Hz.`);
    await this.write(REPORT_ID, [CMD.polling, gear, gear, ...POLLING_TABLE]);
    const actual = this.pollingRate(await this.readSettings(), await this.readIdentity());
    if (actual !== rateHz) throw new Error(`The ${this.label} kept ${actual} Hz instead of ${rateHz} Hz.`);
    return actual;
  }

  async setLiftOffDistance(lod: LiftOff): Promise<LiftOff> {
    const code = keychronLiftOffStops(this.lodChoices()).find(([name]) => name === lod)?.[1];
    if (code === undefined) throw new Error(`The ${this.label} has no ${lod} lift-off distance.`);
    const confirmed = await this.writeSensor({ ...(await this.readSettings()), lod: code });
    if (confirmed.lod !== code) throw new Error(`The ${this.label} kept lift-off code ${confirmed.lod}.`);
    return lod;
  }

  async setMotionSync(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("motionSync", enabled);
  }

  async setAngleSnapping(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("angleSnapping", enabled);
  }

  async setRippleControl(enabled: boolean): Promise<boolean> {
    return this.writeSensorFlag("rippleControl", enabled);
  }

  async setDebounceTime(debounceMs: number): Promise<number> {
    if (!Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > DEBOUNCE_MAX_MS) {
      throw new Error(`The ${this.label} debounce must be between 0 and ${DEBOUNCE_MAX_MS} ms.`);
    }
    await this.write(REPORT_ID, keychronEncodeDebounce(debounceMs));
    const confirmed = (await this.readSettings()).debounceMs;
    if (confirmed !== debounceMs) throw new Error(`The ${this.label} kept ${confirmed} ms debounce instead of ${debounceMs} ms.`);
    return confirmed;
  }

  /** 0x52 on feature report 0x52: [1] button index, [3] type, then the type's data. */
  async setButtonMapping(button: string, action: string): Promise<void> {
    await this.readModel(await this.readIdentity());
    const slot = keychronButtons(this.model ?? undefined).find((entry) => entry.name === button);
    if (!slot) throw new Error(`The ${this.label} has no "${button}" button.`);
    const code = keychronEncodeButton(action, "1k");
    if (!code) throw new Error(`Unknown button action "${action}".`);
    const expected = action === "Default" ? slot.defaultAction : action;
    const after = (await this.readButtons()).map((entry) => (entry.button.index === slot.index ? expected : entry.action));
    if (!after.includes("Left Click")) throw new Error("Keep at least one button as Left Click.");
    await this.write(BUTTON_REPORT_ID, [CMD.writeButton, slot.index, 0, ...code]);
    const confirmed = await this.readButton(slot);
    if (confirmed !== expected) throw new Error(`The ${this.label} kept ${confirmed} on ${button} instead of ${action}.`);
  }

  /** Launcher writes the effect, then its brightness, speed and colour one command at a time. */
  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    await this.readModel(await this.readIdentity());
    const offered = this.model?.light;
    if (!offered) throw new Error(`The ${this.label} has no lighting.`);
    const light = keychronEncodeLighting(lighting, offered);
    await this.write(REPORT_ID, [CMD.writeLightMode, 1, light.mode]);
    if (light.mode !== 0) {
      await this.write(REPORT_ID, [CMD.writeLightBrightness, 1, light.mode, light.brightness]);
      await this.write(REPORT_ID, [CMD.writeLightSpeed, 1, light.mode, light.speed]);
      await this.write(REPORT_ID, [CMD.writeLightColor, 1, light.mode, ...light.rgb]);
    }
    const confirmed = keychronLighting(await this.readLight(), offered);
    if (confirmed.mode !== lighting.mode) throw new Error(`The ${this.label} kept its ${confirmed.mode ?? "previous"} lighting.`);
    return confirmed;
  }

  private get label(): string {
    return this.model?.name ?? "Keychron mouse";
  }

  private get receiver(): boolean {
    return this.identity ? this.identity.workMode === 1 : KEYCHRON_RECEIVERS.has(this.device.productId);
  }

  private pollingRate(settings: KeychronSettings, identity: Identity): number {
    return POLLING_RATES[POLLING_TABLE[keychronActiveGear(settings, identity.workMode)] ?? 2] ?? 1000;
  }

  private lodChoices(): ReadonlyArray<readonly [number, number]> {
    return this.model ? this.model.lod ?? [] : STANDARD_LOD;
  }

  private async writeSensorFlag(flag: SensorFlag, enabled: boolean): Promise<boolean> {
    const confirmed = await this.writeSensor({ ...(await this.readSettings()), [flag]: enabled });
    if (confirmed[flag] !== enabled) throw new Error(`The ${this.label} kept ${flag} ${confirmed[flag] ? "on" : "off"}.`);
    return confirmed[flag];
  }

  /** 0x42 with every option resent; "1k" firmware has no 20K FPS or lift-off level bytes. */
  private async writeSensor(next: KeychronSettings): Promise<KeychronSettings> {
    await this.write(REPORT_ID, keychronEncodeSensor(next));
    return await this.readSettings();
  }

  private unreachableStatus(identity: Identity): MouseStatus {
    const name = this.label;
    return {
      brand: "Keychron",
      name,
      ui: {
        family: "keychron-1k",
        defaultDisplayName: name,
        settingsReady: false,
        statusNote: identity.workMode === 1
          ? "The mouse did not answer through the receiver. Wake it and reconnect."
          : "The mouse did not answer its settings reads. Reconnect it and try again.",
      },
      batteryPercent: null,
      batteryState: "Unknown",
      dpi: 0,
      pollingRateHz: 0,
      activeProfile: null,
      connectionType: identity.workMode === 0 ? "Wired" : "Wireless",
      liftOffDistance: null,
      firmware: identity.firmware ? [identity.firmware] : [],
    };
  }

  private requireDpi(dpi: number): void {
    const [min, max] = this.model?.dpi ?? DEFAULT_DPI;
    if (!Number.isInteger(dpi) || dpi < min || dpi > max || dpi % DPI_STEP !== 0) {
      throw new Error(`The ${this.label} DPI must be a multiple of ${DPI_STEP} between ${min} and ${max}.`);
    }
  }

  private requireStage(stage: number, stageCount: number): void {
    if (!Number.isInteger(stage) || stage < 0 || stage >= stageCount) {
      throw new Error(`DPI stage must be between 1 and ${stageCount}.`);
    }
  }

  private async readSettings(): Promise<KeychronSettings> {
    await this.readModel(await this.readIdentity());
    const bytes = await this.request(REPORT_ID, [CMD.status], (answer) => answer[0] === CMD.status);
    return keychronDecodeSettings(bytes);
  }

  /** Read once per connection; a failed read leaves the mode the product ID implies. */
  private async readIdentity(): Promise<Identity> {
    if (this.identity) return this.identity;
    const bytes = await this.request(REPORT_ID, [CMD.identity], (answer) => answer[0] === CMD.identity).catch(() => null);
    const firmware = await this.request(REPORT_ID, [CMD.firmware], (answer) => answer[0] === CMD.firmware)
      .then(keychronLauncherFirmware)
      .catch(() => null);
    this.identity = {
      firmware: firmware ?? (bytes ? `v${bytes[8]}.${(bytes[7] ?? 0) >> 4}.${(bytes[7] ?? 0) & 0x0f}` : null),
      workMode: bytes ? (bytes[9] ?? 0) & 0x07 : Number(KEYCHRON_RECEIVERS.has(this.device.productId)),
      productId: bytes ? readU16(bytes, 5) : null,
      batteryPercent: bytes?.[10] ?? 0xff,
      powerState: (bytes?.[11] ?? 0) & 0x03,
    };
    return this.identity;
  }

  /** 0x06 again: the battery sits in the identity answer, which is otherwise read once. */
  private async readPower(): Promise<Pick<Identity, "batteryPercent" | "powerState">> {
    const bytes = await this.request(REPORT_ID, [CMD.identity], (answer) => answer[0] === CMD.identity);
    return { batteryPercent: bytes[10] ?? 0xff, powerState: (bytes[11] ?? 0) & 0x03 };
  }

  /** By USB product ID, then the identity's, then the connected mouse in a receiver's 0x03 list. */
  private async readModel(identity: Identity): Promise<KeychronLauncherMouse | null> {
    if (this.model !== undefined) return this.model;
    let model = keychronLauncherMouse(this.device.productId) ?? keychronLauncherMouse(identity.productId);
    if (!model && identity.workMode === 1) {
      const list = await this.request(REPORT_ID, [CMD.receiverState], (answer) => answer[0] === CMD.receiverState).catch(() => null);
      model = keychronLauncherMouse(list ? keychronDecodeConnectedMouse(list) : null);
    }
    this.model = model ?? null;
    return this.model;
  }

  private async readButtons(): Promise<Array<{ button: KeychronButton; action: string }>> {
    const buttons = keychronButtons(this.model ?? undefined);
    if (!buttons.length) throw new Error(`OpenMouse does not know the ${this.label} buttons.`);
    const result: Array<{ button: KeychronButton; action: string }> = [];
    for (const button of buttons) result.push({ button, action: await this.readButton(button) });
    return result;
  }

  private async readButton(button: KeychronButton): Promise<string> {
    const bytes = await this.request(
      BUTTON_REPORT_ID,
      [CMD.readButton, button.index],
      (answer) => answer[0] === CMD.readButton && answer[1] === button.index,
    );
    return keychronDecodeButton(bytes, "1k") ?? button.defaultAction;
  }

  /** 0x12 names the active effect ([3]); 0x18 then gives its RGB ([2..4]), brightness ([5]) and speed ([6]). */
  private async readLight(): Promise<KeychronLight> {
    const mode = (await this.request(REPORT_ID, [CMD.readLightMode], (answer) => answer[0] === CMD.readLightMode))[3] ?? 0;
    const bytes = await this.request(REPORT_ID, [CMD.readLight, mode], (answer) => answer[0] === CMD.readLight);
    return { mode, brightness: bytes[5] ?? 0, speed: bytes[6] ?? 0, rgb: [bytes[2] ?? 0, bytes[3] ?? 0, bytes[4] ?? 0] };
  }

  /** A write's answer carries nothing Launcher checks, so it is only drained; the re-read confirms. */
  private async write(reportId: number, payload: ArrayLike<number>): Promise<void> {
    await this.request(reportId, Array.from(payload), () => true).catch(() => undefined);
  }

  /**
   * Sends a feature report, then reads the same report back until the answer
   * matches, as Launcher's feature transceivers do (behind a receiver it waits
   * first). The answer starts with the report ID, which is dropped.
   */
  private async request(reportId: number, payload: number[], match: (answer: Uint8Array) => boolean): Promise<Uint8Array> {
    const run = this.queue.then(async () => {
      await this.open();
      const packet = new Uint8Array(reportId === BUTTON_REPORT_ID ? BUTTON_REPORT_LENGTH : REPORT_LENGTH);
      packet.set(payload.slice(0, packet.length));
      try {
        await this.device.sendFeatureReport(reportId, packet);
      } catch (error) {
        throw new Error(`Chrome could not write the ${this.label} HID report. ${error instanceof Error ? error.message : String(error)}`);
      }
      for (let attempt = 0; attempt < ANSWER_ATTEMPTS; attempt += 1) {
        if (attempt > 0 || this.receiver) await delay(attempt > 0 ? ANSWER_RETRY_MS : RECEIVER_ANSWER_DELAY_MS);
        const view = await this.device.receiveFeatureReport(reportId);
        const answer = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice(1);
        if (match(answer)) return answer;
      }
      throw new Error(`The ${this.label} did not answer command 0x${payload[0]?.toString(16)}.`);
    });
    this.queue = run.catch(() => undefined);
    return await run;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
