import type { MouseLighting, MouseStatus } from "../mouse-types.ts";
import {
  KSNAKE_BUTTON_ACTIONS,
  KSNAKE_BUTTON_NAMES,
  KSNAKE_BUTTON_WIRE_INDICES,
  KSNAKE_MACRO_BYTES,
  KSNAKE_MACRO_CHUNK_BYTES,
  KSNAKE_MACRO_REPORT_ID,
  KSNAKE_LIGHT_MODE_LABELS,
  KSNAKE_PRODUCT_ID,
  KSNAKE_POLLING_RATES,
  KSNAKE_SLEEP_OPTIONS,
  KSNAKE_REPORT_ID,
  KSNAKE_USAGE,
  KSNAKE_USAGE_PAGE,
  KSNAKE_USB_VENDOR_ID,
  NOIR_M2_NEX_BRAND,
  NOIR_M2_NEX_MODEL,
  ksnakeDecodeBattery,
  ksnakeDecodeConfig,
  ksnakeDecodeLightMode,
  ksnakeDecodeKeys,
  ksnakeDecodeMacroChunk,
  ksnakeDecodeMacroData,
  ksnakeDecodeLiftOff,
  ksnakeDecodePollingRate,
  ksnakeDecodeVersion,
  ksnakeEncodeLiftOff,
  ksnakeEncodeLightMode,
  ksnakeEncodePollingRate,
  ksnakeEncodeSetLightMode,
  ksnakeEncodeSetConfig,
  ksnakeEncodeSetKeys,
  ksnakeEncodeMacroChunk,
  ksnakeEncodeMacroCommit,
  ksnakeEncodeMacroData,
  ksnakeGetBatteryRequest,
  ksnakeGetConfigRequest,
  ksnakeGetKeysRequest,
  ksnakeGetMacroChunkRequest,
  ksnakeGetVersionRequest,
  ksnakeBindingLabel,
  ksnakeFindButtonAction,
  ksnakeIsValidDpi,
  ksnakeKeysLookPlausible,
  isNoirM2NexDevice,
  type KsnakeConfig,
  type KsnakeKeyBinding,
  type KsnakeMacroProfile,
} from "../../ksnake/index.js";
import { VENDOR_ID } from "../vendors.ts";

const REPLY_TIMEOUT_MS = 800;
/** Pause after a SET before reading back, so the mouse can commit to flash. */
const SETTLE_AFTER_WRITE_MS = 250;

/** Rejected when a command gets no inputreport within the timeout. Retried by writes. */
export class KsnakeTimeoutError extends Error {
  constructor() {
    super("The mouse did not answer — it may be asleep or out of range.");
    this.name = "KsnakeTimeoutError";
  }
}

export interface KsnakeClientOptions {
  replyTimeoutMs?: number;
  settleAfterWriteMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * K-snake X11 vendor HID control.
 *
 * Transport: output report 0 (64 bytes starting with 0x55); the reply
 * arrives as the next `inputreport`. A tiny queue serializes concurrent
 * calls like the vendor panel's commandQueueWrapper.
 *
 * Evidence: vendor panel at https://x1a11.yjx2012.com/, the X11 user manual
 * (6 factory DPI steps, 1000 Hz in 2.4G/wired, 125 Hz in BT, PAW3311), plus
 * retail-hardware verification — 2.4 GHz dongle (VID 0xA8A5, Vendor 0xFF01
 * interface, PARTIAL as expected since this protocol never uses feature
 * reports), FW 2.1.7, read/set/confirm round-trips for DPI and polling.
 */
export class KsnakeHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly replyTimeoutMs: number;
  private readonly settleAfterWriteMs: number;
  /** Last config that passed validation (see readStatus). */
  private lastGoodConfig: KsnakeConfig | null = null;

  constructor(device: HIDDevice, options: KsnakeClientOptions = {}) {
    this.device = device;
    this.replyTimeoutMs = options.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
    this.settleAfterWriteMs = options.settleAfterWriteMs ?? SETTLE_AFTER_WRITE_MS;
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.productId !== KSNAKE_PRODUCT_ID) return false;
    if (device.vendorId !== VENDOR_ID.ksnakeUsb && device.vendorId !== VENDOR_ID.ksnakeDongle) return false;
    const search = (list: readonly HIDCollectionInfo[]): boolean =>
      list.some(
        (c) => (c.usagePage === KSNAKE_USAGE_PAGE && c.usage === KSNAKE_USAGE) || search(c.children),
      );
    return search(device.collections);
  }

  get supportedPollingRates(): number[] {
    return [...KSNAKE_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    // PAW3311, vendor slider 200–12000. Defaults: 800/1200/1600/3200/5000/12000.
    const options: number[] = [];
    for (let dpi = 200; dpi <= 12000; dpi += 100) options.push(dpi);
    return options;
  }

  getSleepOptions(): number[] {
    return [...KSNAKE_SLEEP_OPTIONS];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  private async run<T>(task: () => Promise<T>): Promise<T> {
    const started = this.queue.then(task, task);
    this.queue = started.catch(() => undefined);
    return started;
  }

  private async exchange(body: Uint8Array, reportId = KSNAKE_REPORT_ID): Promise<Uint8Array> {
    const timeoutMs = this.replyTimeoutMs;
    return this.run(() => this.exchangeNow(body, reportId, timeoutMs));
  }

  private async exchangeNow(body: Uint8Array, reportId: number, timeoutMs = this.replyTimeoutMs): Promise<Uint8Array> {
    await this.open();
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.device.removeEventListener("inputreport", listener);
        reject(new KsnakeTimeoutError());
      }, timeoutMs);
      const listener = (event: HIDInputReportEvent): void => {
        // Older test doubles omit reportId; a real WebHID event always has it.
        // Filtering real events matters for macro reads because report 6 shares
        // this collection with the normal report-0 command stream.
        if (typeof event.reportId === "number" && event.reportId !== reportId) return;
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", listener);
        resolve(copyDataView(event.data));
      };
      this.device.addEventListener("inputreport", listener);
      this.device.sendReport(reportId, new Uint8Array(body.slice(0, 64)).buffer).catch((error: unknown) => {
        clearTimeout(timer);
        this.device.removeEventListener("inputreport", listener);
        reject(error);
      });
    });
  }

  /**
   * Some K-snake descriptors expose the optional macro read channel as HID
   * report 6, while the M2-NEX descriptor only advertises output report 0.
   * Use the descriptor instead of asking WebHID to send an undeclared report.
   * Test doubles without collections retain the original report-6 behavior.
   */
  private macroReadReportId(): number {
    const collections = (this.device as unknown as {
      collections?: Array<{ outputReports?: Array<{ reportId: number }> }>;
    }).collections;
    if (!collections) return KSNAKE_MACRO_REPORT_ID;
    const outputReports = collections.flatMap((collection) => collection.outputReports ?? []);
    // Minimal test doubles expose collections but omit the report descriptors.
    // Keep the generic K-snake report-6 behavior for those; a real M2-NEX
    // descriptor has outputReports: [{ reportId: 0 }] and therefore selects 0.
    if (outputReports.length === 0) return KSNAKE_MACRO_REPORT_ID;
    return outputReports.some((report) => report.reportId === KSNAKE_MACRO_REPORT_ID)
      ? KSNAKE_MACRO_REPORT_ID
      : KSNAKE_REPORT_ID;
  }

  /** Same as exchange, but resends on timeout (a sleeping dongle often drops the first). Non-timeout errors throw immediately. SETs are idempotent full-config writes, so resending is safe. */
  private async exchangeRetrying(body: Uint8Array, attempts: number): Promise<Uint8Array> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        return await this.exchange(body);
      } catch (error) {
        if (!(error instanceof KsnakeTimeoutError)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }

  /** Best-effort config read for post-write confirmation; null when the mouse stays silent. */
  private async readBackConfig(attempts: number): Promise<KsnakeConfig | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reply = await this.exchange(ksnakeGetConfigRequest()).catch(() => null);
      const config = reply ? ksnakeDecodeConfig(reply) : null;
      if (config) return config;
    }
    return null;
  }

  /**
   * Reads with one retry when the reply fails validation. The dongle can emit
   * unsolicited reports that a queued exchange mistakes for its answer, so a
   * single failed decode is worth one resend before giving up.
   */
  private async readValidated<T>(
    read: () => Promise<T | null>,
    valid: (value: T) => boolean,
  ): Promise<T | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const value = await read().catch(() => null);
      if (value !== null && valid(value)) return value;
    }
    return null;
  }

  async readStatus(): Promise<MouseStatus> {
    await this.open();
    const [freshConfig, battery, version] = await Promise.all([
      this.readValidated(
        () => this.exchange(ksnakeGetConfigRequest()).then((r) => ksnakeDecodeConfig(r)),
        (c) => ksnakeDecodePollingRate(c.reportRate) !== null && c.dpiIndex >= 0 && c.dpiIndex < c.stages.length,
      ),
      this.readValidated(
        () => this.exchange(ksnakeGetBatteryRequest()).then((r) => ksnakeDecodeBattery(r)),
        (b) => b.percent <= 100,
      ),
      this.readValidated(
        () => this.exchange(ksnakeGetVersionRequest()).then((r) => ksnakeDecodeVersion(r)),
        (v) => v.length > 0,
      ),
    ]);
    // Sequential on purpose: parallel reads on this dongle collide into
    // crossed reports, and keys are the least critical of the four.
    const keys = await this.getKeys().catch(() => null);
    // Last-good cache: a failed poll read must not blank the stages/DPI in
    // the UI until the next poll (the panel re-renders on every change).
    if (freshConfig) this.lastGoodConfig = freshConfig;
    const config = freshConfig ?? this.lastGoodConfig;
    const stages = config?.stages ?? [];
    const activeStage = config ? Math.min(Math.max(config.dpiIndex, 0), Math.max(stages.length - 1, 0)) : 0;
    const dpi = stages[activeStage] ?? 1600;
    const pollingRateHz = config ? (ksnakeDecodePollingRate(config.reportRate) ?? 1000) : 1000;
    const isNoirM2Nex = isNoirM2NexDevice(this.device);
    const brand: MouseStatus["brand"] = isNoirM2Nex ? NOIR_M2_NEX_BRAND : "K-snake";
    const model = this.device.productName || (isNoirM2Nex ? NOIR_M2_NEX_MODEL : "K-snake X11");
    const lightingMode = config ? ksnakeDecodeLightMode(config.lightMode) : null;
    const liftOffDistance = config ? ksnakeDecodeLiftOff(config.lodValue) : null;
    const supportedLiftOffDistances: NonNullable<MouseStatus["supportedLiftOffDistances"]> = liftOffDistance
      ? ["Low", "High"]
      : [];
    return {
      brand,
      name: model,
      ui: {
        family: "ksnake",
        settingsReady: config !== null,
        // K-snake has no generic advanced cards, but its readable key map
        // belongs in the shared Buttons tab. Keep the tab hidden when the
        // dongle only returns the erased 0xff sentinel.
        showAdvancedSection: keys !== null,
        hideUnsupportedPollingRates: true,
        hideProcessingCard: true,
        defaultDisplayName: model,
        dpiStageEditor: {
          maxStages: 6,
          countEditable: false,
          minDpi: 200,
          maxDpi: 12000,
          stepDpi: 100,
        },
      },
      batteryPercent: battery ? Math.min(battery.percent, 100) : null,
      batteryState: battery ? (battery.charging !== 0 ? "Charging" : "Discharging") : "Unknown",
      dpi,
      dpiStages: stages.length ? stages : undefined,
      activeDpiStage: stages.length ? activeStage : undefined,
      pollingRateHz,
      supportedPollingRates: this.supportedPollingRates,
      activeProfile: null,
      connectionType: this.device.vendorId === KSNAKE_USB_VENDOR_ID ? "Wired" : "Wireless",
      connectionDetail: this.device.vendorId === KSNAKE_USB_VENDOR_ID ? "Wired USB" : "2.4 GHz receiver",
      liftOffDistance,
      supportedLiftOffDistances,
      sleepTimeout: config && config.sleepLight > 0 ? config.sleepLight * 60 : null,
      scrollDirection: config ? (config.scrollFlag === 1 ? "Reverse" : "Forward") : null,
      lighting: lightingMode ? {
        zone: "Mouse",
        modes: [...KSNAKE_LIGHT_MODE_LABELS],
        mode: lightingMode,
        color: null,
        color2: null,
        colorModes: [],
        dualColorModes: [],
        reactiveModes: [],
        speeds: [],
        speed: null,
      } : undefined,
      // Generic remap interface: the shared ButtonMappingCard renders these
      // with no brand-specific code. The fixed DPI slot is deliberately not
      // exposed as a user-remappable control; opaque bindings surface as
      // "Custom (…)" and are preserved during a different slot's write.
      buttonMappings: keys
        ? Object.fromEntries(
            KSNAKE_BUTTON_NAMES.map((name, index) => {
              const binding = keys[KSNAKE_BUTTON_WIRE_INDICES[index]];
              return [
                name,
                binding
                  ? ksnakeBindingLabel(binding)
                    ?? `Custom (${binding.type},${binding.code1},${binding.code2},${binding.code3})`
                  : "Unknown",
              ] as const;
            }),
          )
        : undefined,
      buttonOptions: KSNAKE_BUTTON_ACTIONS.map((action) => action.label),
      firmware: version ? [(isNoirM2Nex ? NOIR_M2_NEX_MODEL : "X11") + " " + version] : [model],
    };
  }

  async setDpi(dpi: number): Promise<number> {
    if (!ksnakeIsValidDpi(dpi)) {
      throw new Error(`DPI must be a whole number between 200 and 12000 for the K-snake X11 (got ${dpi}).`);
    }
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    const stages = [...config.stages];
    const index = Math.min(Math.max(config.dpiIndex, 0), stages.length - 1);
    stages[index] = dpi;
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, stages }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    const got = confirmed?.stages[Math.min(Math.max(confirmed.dpiIndex, 0), confirmed.stages.length - 1)];
    if (got !== dpi) throw new Error(`The mouse kept ${got ?? "?"} DPI instead of ${dpi}.`);
    return dpi;
  }

  async setActiveDpiStage(stage: number): Promise<number> {
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    if (!Number.isInteger(stage) || stage < 0 || stage >= config.stages.length) {
      throw new Error(`DPI stage must be between 1 and ${config.stages.length}.`);
    }
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, dpiIndex: stage }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    if (confirmed?.dpiIndex !== stage) {
      throw new Error(`The mouse kept DPI stage ${(confirmed?.dpiIndex ?? 0) + 1} instead of ${stage + 1}.`);
    }
    return stage;
  }

  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!ksnakeIsValidDpi(dpi)) {
      throw new Error(`DPI must be a whole number between 200 and 12000 for the K-snake X11 (got ${dpi}).`);
    }
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    if (!Number.isInteger(stage) || stage < 0 || stage >= config.stages.length) {
      throw new Error(`DPI stage must be between 1 and ${config.stages.length}.`);
    }
    const stages = [...config.stages];
    stages[stage] = dpi;
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, stages }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    if (confirmed?.stages[stage] !== dpi) {
      throw new Error(`The mouse kept ${confirmed?.stages[stage] ?? "?"} DPI instead of ${dpi}.`);
    }
    return dpi;
  }

  /** Read-only dump of all 8 key slots (GET_KEYS, reply[8..39]). */
  async getKeys(): Promise<KsnakeKeyBinding[] | null> {
    // Consensus, not first-plausible: a crossed report from another command
    // can decode to plausible-but-wrong slots, and two strays never agree.
    const seen: KsnakeKeyBinding[][] = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const reply = await this.exchange(ksnakeGetKeysRequest()).catch(() => null);
      const keys = reply ? ksnakeDecodeKeys(reply) : null;
      if (!keys || !ksnakeKeysLookPlausible(keys)) continue;
      if (seen.some((prev) => equalKeyMaps(prev, keys))) return keys;
      seen.push(keys);
    }
    return null;
  }

  /**
   * Experimental legacy read of the 4096-byte macro store. The live M2-NEX
   * receiver exposes no reliable read response on its browser HID interface,
   * so the OpenMouse editor intentionally does not call this method.
   */
  async getMacroData(): Promise<Uint8Array> {
    return this.run(async () => {
      const data = new Uint8Array(KSNAKE_MACRO_BYTES);
      const reportId = this.macroReadReportId();
      for (let offset = 0; offset < KSNAKE_MACRO_BYTES; offset += KSNAKE_MACRO_CHUNK_BYTES) {
        const length = Math.min(KSNAKE_MACRO_CHUNK_BYTES, KSNAKE_MACRO_BYTES - offset);
        const request = ksnakeGetMacroChunkRequest(offset, length);
        const reply = await this.exchangeNow(request.body, reportId);
        const chunk = ksnakeDecodeMacroChunk(reply, length);
        if (!chunk) throw new Error(`The mouse returned an invalid macro chunk at offset ${offset}.`);
        data.set(chunk, offset);
      }
      return data;
    });
  }

  /** Experimental legacy decode of the vendor's 32 onboard macro slots. */
  async getMacros(): Promise<KsnakeMacroProfile[]> {
    const profiles = ksnakeDecodeMacroData(await this.getMacroData());
    if (!profiles) throw new Error("The mouse returned an invalid macro store.");
    return profiles;
  }

  /**
   * Upload a raw vendor macro image and commit it. The shared OpenMouse UI does
   * not call this yet, but keeping the transport here makes future macro
   * editing possible without touching the already-verified key-map path.
   * The vendor panel waits for an input response after every chunk and after
   * the commit. Those replies confirm transport only; this firmware does not
   * expose a byte-for-byte macro read-back on the live 2.4G receiver.
   */
  async setMacroData(data: Uint8Array): Promise<void> {
    if (data.length > KSNAKE_MACRO_BYTES) {
      throw new RangeError(`Macro data cannot exceed ${KSNAKE_MACRO_BYTES} bytes.`);
    }
    await this.run(async () => {
      for (let offset = 0; offset < data.length; offset += KSNAKE_MACRO_CHUNK_BYTES) {
        const chunk = data.slice(offset, Math.min(offset + KSNAKE_MACRO_CHUNK_BYTES, data.length));
        await this.exchangeNow(ksnakeEncodeMacroChunk(offset, chunk), KSNAKE_REPORT_ID);
      }
      await this.exchangeNow(ksnakeEncodeMacroCommit(), KSNAKE_REPORT_ID);
    });
  }

  /** Encode and commit all onboard macro slots in one vendor transaction. */
  async setMacros(profiles: readonly KsnakeMacroProfile[]): Promise<void> {
    await this.setMacroData(ksnakeEncodeMacroData(profiles));
  }

  /**
   * Write all 8 key slots (SET_KEYS). The fixed DPI slot must remain intact;
   * opaque macro/custom slots are preserved rather than guessed or rebuilt.
   * Confirms by reading the map back.
   */
  async setKeys(keys: readonly KsnakeKeyBinding[]): Promise<KsnakeKeyBinding[]> {
    const slots = [...keys].slice(0, 8);
    if (slots.length !== 8) throw new Error(`Exactly 8 key bindings are required (got ${keys.length}).`);
    for (const [index, key] of slots.entries()) {
      const bytes = [key.type, key.code1, key.code2, key.code3];
      if (!bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
        throw new Error(`Button ${index + 1}: binding bytes must be 0-255.`);
      }
    }
    if (!equalBinding(slots[5], { type: 33, code1: 85, code2: 0, code3: 0 })) {
      throw new Error("The fixed DPI button binding may not be changed.");
    }
    await this.exchangeRetrying(ksnakeEncodeSetKeys(slots), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackKeys(3);
    if (!confirmed || !slots.every((key, index) => equalBinding(confirmed[index], key))) {
      const seen = confirmed ? JSON.stringify(confirmed) : "no readable reply";
      throw new Error(`The mouse did not keep the new button map (read back ${seen}).`);
    }
    return slots;
  }

  /** Best-effort key-map read for post-write confirmation. */
  private async readBackKeys(attempts: number): Promise<KsnakeKeyBinding[] | null> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const reply = await this.exchange(ksnakeGetKeysRequest()).catch(() => null);
      const keys = reply ? ksnakeDecodeKeys(reply) : null;
      if (keys && ksnakeKeysLookPlausible(keys)) return keys;
    }
    return null;
  }

  /**
   * Remap one button by display label (generic `setButtonMapping` interface).
   * SET_KEYS always carries all eight key slots, so the current map is
   * re-read and the single user-visible slot replaced — confirmed by
   * setKeys' read-back. Slot "Left" is locked (the vendor panel refuses
   * drops there too).
   */
  async setButtonMapping(button: string, actionLabel: string): Promise<void> {
    const index = KSNAKE_BUTTON_NAMES.indexOf(button as (typeof KSNAKE_BUTTON_NAMES)[number]);
    if (index < 0) throw new Error(`This mouse has no "${button}" button.`);
    if (index === 0) throw new Error("Left Click is fixed and cannot be reassigned.");
    const binding = ksnakeFindButtonAction(actionLabel);
    if (!binding) throw new Error(`Unknown button action "${actionLabel}".`);
    const current = await this.getKeys();
    if (!current) throw new Error("Could not read the current button map from the mouse.");
    const slots = current.map((slot) => ({ ...slot }));
    slots[KSNAKE_BUTTON_WIRE_INDICES[index]] = binding;
    await this.setKeys(slots);
  }

  async setLiftOffDistance(
    value: NonNullable<MouseStatus["liftOffDistance"]>,
  ): Promise<NonNullable<MouseStatus["liftOffDistance"]>> {
    const encoded = ksnakeEncodeLiftOff(value);
    if (encoded === null) throw new Error(`This mouse does not support a ${value.toLowerCase()} lift-off distance.`);
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    if (ksnakeDecodeLiftOff(config.lodValue) === null) {
      throw new Error("The mouse did not report a readable lift-off setting; changing it is disabled.");
    }
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, lodValue: encoded }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    const back = confirmed ? ksnakeDecodeLiftOff(confirmed.lodValue) : null;
    if (back !== value) throw new Error(`The mouse kept a ${String(back).toLowerCase()} lift-off distance instead of ${value.toLowerCase()}.`);
    return value;
  }

  async setPollingRate(rate: number): Promise<number> {
    const index = ksnakeEncodePollingRate(rate);
    if (index === null) throw new Error(`This mouse does not support ${rate} Hz.`);
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, reportRate: index }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    const back = confirmed ? ksnakeDecodePollingRate(confirmed.reportRate) : null;
    if (back !== rate) throw new Error(`The mouse kept ${back ?? "?"} Hz instead of ${rate} Hz.`);
    return rate;
  }

  async setSleepTimeout(seconds: number): Promise<number> {
    if (!this.getSleepOptions().includes(seconds)) {
      throw new Error(`This mouse does not support a ${seconds}-second sleep timeout.`);
    }
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    const sleepLight = seconds / 60;
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, sleepLight }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    if (confirmed?.sleepLight !== sleepLight) {
      throw new Error(`The mouse kept a ${confirmed?.sleepLight ?? "?"}-minute sleep timeout instead of ${sleepLight}.`);
    }
    return seconds;
  }

  /** Sets the stored wheel direction and confirms the config byte. */
  async setScrollDirection(direction: NonNullable<MouseStatus["scrollDirection"]>): Promise<NonNullable<MouseStatus["scrollDirection"]>> {
    if (direction !== "Forward" && direction !== "Reverse") {
      throw new Error(`Scroll direction must be Forward or Reverse (got ${direction}).`);
    }
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    const scrollFlag = direction === "Reverse" ? 1 : 0;
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, scrollFlag }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    const confirmedDirection = confirmed?.scrollFlag === 1 ? "Reverse" : confirmed?.scrollFlag === 0 ? "Forward" : null;
    if (confirmedDirection !== direction) {
      throw new Error(`The mouse kept ${confirmedDirection ?? "?"} scroll direction instead of ${direction}.`);
    }
    return direction;
  }

  /** Sets the vendor lighting effect, then persists and confirms it. */
  async setLighting(lighting: MouseLighting): Promise<MouseLighting> {
    if (!lighting.mode) throw new Error("A lighting mode is required.");
    const lightMode = ksnakeEncodeLightMode(lighting.mode);
    if (lightMode === null) throw new Error(`Unsupported K-snake lighting mode: ${lighting.mode}.`);
    // The vendor panel uses this immediate command for the LED controller and
    // then keeps the same value in the full config block for the next connect.
    await this.exchangeRetrying(ksnakeEncodeSetLightMode(lightMode), 2);
    const raw = await this.exchangeRetrying(ksnakeGetConfigRequest(), 3).catch(() => null);
    const config = raw ? ksnakeDecodeConfig(raw) : null;
    if (!config) throw new Error("Could not read the current config from the mouse.");
    await this.exchangeRetrying(ksnakeEncodeSetConfig({ ...config, lightMode }), 2);
    await sleep(this.settleAfterWriteMs);
    const confirmed = await this.readBackConfig(3);
    if (confirmed?.lightMode !== lightMode) {
      throw new Error(`The mouse kept lighting mode ${confirmed?.lightMode ?? "?"} instead of ${lightMode}.`);
    }
    return { ...lighting, mode: ksnakeDecodeLightMode(lightMode)! };
  }
}

function copyDataView(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
}

function equalBinding(a: KsnakeKeyBinding | undefined, b: KsnakeKeyBinding): boolean {
  return a !== undefined && a.type === b.type && a.code1 === b.code1 && a.code2 === b.code2 && a.code3 === b.code3;
}

function equalKeyMaps(a: readonly KsnakeKeyBinding[], b: readonly KsnakeKeyBinding[]): boolean {
  return a.length === b.length && a.every((key, index) => equalBinding(key, b[index] as KsnakeKeyBinding));
}
