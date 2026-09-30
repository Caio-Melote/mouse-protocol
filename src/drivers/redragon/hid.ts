import type { MouseLighting, MouseLightingMode, MouseStatus } from "../mouse-types.js";
import {
  REDRAGON_COMMIT_CODES,
  REDRAGON_CONFIG_USAGE,
  REDRAGON_CONFIG_USAGE_PAGE,
  REDRAGON_M612_ACTIVE_PROFILE_ADDRESS,
  REDRAGON_M612_BUTTON_LENGTH,
  REDRAGON_M612_BUTTON_OFFSETS,
  REDRAGON_M612_BUTTON_OPTIONS,
  REDRAGON_M612_DPI_LABELS,
  REDRAGON_M612_EFFECTS,
  REDRAGON_M612_LIGHTING_BLOCK_LENGTH,
  REDRAGON_M612_LIGHTING_EFFECT_ADDRESS,
  REDRAGON_M612_LIGHTING_SPEEDS,
  REDRAGON_M612_POLL_ADDRESS,
  REDRAGON_M612_POLL_LENGTH,
  REDRAGON_M612_PRODUCT_ID,
  REDRAGON_M612_PROFILE_COUNT,
  REDRAGON_M612_PROFILE_SELECT_CODE,
  REDRAGON_M612_PROFILE_BASES,
  REDRAGON_M612_SLOT_LENGTH,
  REDRAGON_M612_STAGE_COUNT,
  REDRAGON_POLLING_CODES,
  REDRAGON_POLLING_RATES,
  REDRAGON_PRODUCTS,
  REDRAGON_PRODUCT_IDS,
  REDRAGON_PROFILE0,
  REDRAGON_PROFILE0_DPI_SUBCMDS,
  REDRAGON_REPORT_ID,
  REDRAGON_VENDOR_ID,
  redragonDecodeRead,
  redragonEncodeCommit,
  redragonEncodeDpiSlot,
  redragonEncodePollingRate,
  redragonEncodeRead,
  redragonEncodeWrite,
  redragonHello,
  redragonM612ButtonAddress,
  redragonM612DecodeButtonAction,
  redragonM612DecodeDpi,
  redragonM612EffectForBit,
  redragonM612EncodeButtonAction,
  redragonM612EncodeDpi,
  redragonM612SlotAddress,
  type RedragonM612Effect,
  redragonSession,
} from "@openmouse/protocol/redragon";

/** RDCfg gaps consecutive writes ~8-18 ms; stay well above that. */
const WRITE_DELAY_MS = 30;
/** Factory DPI table a default RDCfg pushes (level 1 is 1200 out of the box). */
const FACTORY_STAGES = [1200, 2400, 3500, 5500, 12400];
const DEFAULT_POLLING_HZ = 1000;

function hasConfigCollection(collections: readonly HIDCollectionInfo[]): boolean {
  return collections.some((collection) =>
    (collection.usagePage === REDRAGON_CONFIG_USAGE_PAGE &&
      collection.usage === REDRAGON_CONFIG_USAGE &&
      (collection.featureReports ?? []).some((report) => report.reportId === REDRAGON_REPORT_ID)) ||
    hasConfigCollection(collection.children ?? []));
}

/**
 * Redragon K1NG 1K (M724, `04d9:fc7a`) WebHID control.
 *
 * Transport: Holtek vendor collection `0xFFA0:0x01` on USB interface 2,
 * 16-byte numbered feature report 2, `SET_FEATURE` writes of the form
 * `[F3 sub profile section ...]` (see `@openmouse/protocol/redragon`).
 * The device STALLs malformed writes and never answers reads: RDCfg pushes
 * its whole profile table at startup and issues no `GET_REPORT` at all, so
 * this driver is write-only like the SteelSeries Rival 3. `readStatus`
 * therefore reports this session's last-written stages (or the factory
 * table before any write) with `valuesVerified: false`, and the only
 * hardware probe is the `FA FA` marker every `GET_FEATURE` echo carries.
 */
export class RedragonHidClient {
  readonly device: HIDDevice;
  private queue: Promise<unknown> = Promise.resolve();
  private lastStages: number[] | null = null;
  private lastPollingHz: number | null = null;

  constructor(device: HIDDevice) {
    this.device = device;
    // The driver registry builds this class for every Redragon PID. The M612
    // answers reads, so it gets a subclass with read-back and active-stage
    // control; the app gates those controls on which methods exist.
    if (new.target === RedragonHidClient && device.productId === REDRAGON_M612_PRODUCT_ID) {
      return new RedragonM612HidClient(device);
    }
  }

  static isSupported(device: HIDDevice): boolean {
    if (device.vendorId !== REDRAGON_VENDOR_ID) return false;
    if (!REDRAGON_PRODUCT_IDS.includes(device.productId)) return false;
    return hasConfigCollection(device.collections);
  }

  get supportedPollingRates(): number[] {
    return [...REDRAGON_POLLING_RATES];
  }

  getDpiOptions(): number[] {
    return [200, 400, 800, 1200, 1600, 2000, 2400, 3200, 3500, 4000, 5500, 6400, 8000, 10000, 12400];
  }

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
  }

  async close(): Promise<void> {
    if (this.device.opened) await this.device.close();
  }

  async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      await this.probeConfigChannel();
      const product = REDRAGON_PRODUCTS.get(this.device.productId);
      // The firmware reports a generic "USB Gaming Mouse" product string,
      // so prefer the catalog name whenever the PID is known.
      const name = product ? `Redragon ${product.name}` : (this.device.productName?.trim() || "Redragon Mouse");
      const stages = this.lastStages ?? [...FACTORY_STAGES];
      return {
        brand: "Redragon",
        name,
        ui: {
          family: "redragon",
          settingsReady: true,
          valuesVerified: false,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          pollingNote: "The M724 never reports its polling rate; the value shown is this session's last write, or 1000 Hz before any write.",
          statusNote: "The K1NG 1K never reports settings back; values shown are this session's last writes, or the factory table before any write.",
          dpiStageEditor: {
            maxStages: REDRAGON_PROFILE0_DPI_SUBCMDS.length,
            countEditable: false,
            minDpi: 50,
            maxDpi: product?.maxDpi ?? 12400,
            stepDpi: 50,
          },
          defaultDisplayName: `Redragon ${product?.name ?? "Mouse"}`,
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: stages[0] ?? FACTORY_STAGES[0]!,
        dpiStages: stages,
        pollingRateHz: this.lastPollingHz ?? DEFAULT_POLLING_HZ,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: null,
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /**
   * Writes the whole profile-1 DPI table in one vendor session bracket,
   * closed by the commit block. Bisected live: RDCfg re-pushes the table on
   * every Apply and the change is felt immediately; a lone slot write is
   * stored but only takes effect at boot, and the trailing `F1` block is
   * what activates it. Sibling stages come from this session's cache
   * (factory table before any write): editing in RDCfg meanwhile makes the
   * cache stale, exactly like any write-only driver.
   */
  async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_PROFILE0_DPI_SUBCMDS.length) {
      throw new Error(`Redragon DPI stage ${stage} is out of range 0-4.`);
    }
    // Validates the DPI before anything is sent.
    redragonEncodeDpiSlot(REDRAGON_PROFILE0, stage, dpi);
    await this.run(async () => {
      await this.open();
      const next = [...(this.lastStages ?? FACTORY_STAGES)];
      next[stage] = dpi;
      await this.writeSession(async () => {
        for (let level = 0; level < REDRAGON_PROFILE0_DPI_SUBCMDS.length; level++) {
          await this.sendFrame(redragonEncodeDpiSlot(REDRAGON_PROFILE0, level, next[level]!));
        }
        for (const code of REDRAGON_COMMIT_CODES) {
          await this.sendFrame(redragonEncodeCommit(code));
        }
      });
      this.lastStages = next;
    });
    return dpi;
  }

  /**
   * Writes the polling rate inside the same session bracket + commit block
   * as DPI writes (the vendor sends it mid-push; the trailing `F1` block is
   * what activates writes, verified live for DPI).
   */
  async setPollingRate(hz: number): Promise<number> {
    const frame = redragonEncodePollingRate(hz);
    await this.run(async () => {
      await this.open();
      await this.writeSession(async () => {
        await this.sendFrame(frame);
        for (const code of REDRAGON_COMMIT_CODES) {
          await this.sendFrame(redragonEncodeCommit(code));
        }
      });
      this.lastPollingHz = hz;
    });
    return hz;
  }

  /**
   * The `FA FA` echo every `GET_FEATURE` carries doubles as the proof that
   * the granted interface is the config channel: the mouse and keyboard
   * interfaces expose no feature report 2 at all. The marker is matched as
   * the last two payload bytes so both WebHID framings (report id stripped
   * or kept) validate.
   */
  protected async probeConfigChannel(): Promise<void> {
    const view = await this.device.receiveFeatureReport(REDRAGON_REPORT_ID);
    const echo = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    console.debug("[redragon] feature2 echo", [...echo].map((b) => b.toString(16).padStart(2, "0")).join(" "));
    const marker = echo.length >= 2 && echo[echo.length - 2] === 0xfa && echo[echo.length - 1] === 0xfa;
    if (!marker) {
      throw new Error(
        `The Redragon config channel answered ${echo.length} bytes without its FA FA marker (see console "[redragon] feature2 echo"). Add the device again and choose the entry backed by the vendor interface.`,
      );
    }
  }

  protected async sendFrame(frame: Uint8Array): Promise<void> {
    await this.device.sendFeatureReport(REDRAGON_REPORT_ID, frame.slice(1).buffer as ArrayBuffer);
    await new Promise((resolve) => setTimeout(resolve, WRITE_DELAY_MS));
  }

  private async sendSessionFrame(begin: boolean): Promise<void> {
    await this.sendFrame(begin ? redragonHello() : redragonSession(false));
  }

  protected async writeSession(operation: () => Promise<void>): Promise<void> {
    await this.sendSessionFrame(true);
    try {
      await operation();
    } finally {
      await this.sendSessionFrame(false);
    }
  }

  protected async run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return await result;
  }
}

interface M612Settings {
  profile: number;
  activeStage: number;
  stages: number[];
  pollingHz: number;
}


/** RDCfg's button numbers, named for what each one is on the mouse. */
const M612_BUTTON_NAMES = [
  "Left (1)", "Right (2)", "Wheel click (3)", "Fire (4)", "Button 5", "Button 6",
  "Button 7", "Button 8", "Button 9", "Wheel up", "Wheel down",
] as const;

/** RDCfg effects OpenMouse can show; FLASH has no matching lighting mode. */
const M612_MODES: ReadonlyArray<readonly [RedragonM612Effect, MouseLightingMode]> = [
  ["static", "Static"],
  ["breathing", "Breathing single"],
  ["spectrumBreathing", "Breathing random"],
  ["wave", "Wave"],
  ["off", "Off"],
];
/** RDCfg's three brightness positions as percentages. */
const M612_BRIGHTNESS = [33, 67, 100] as const;
const M612_SPEEDS = Array.from({ length: REDRAGON_M612_LIGHTING_SPEEDS }, (_, index) => index + 1);

/**
 * Redragon Predator M612 (`04d9:fc61`) WebHID control.
 *
 * Same Holtek transport as the M724, but the M612 answers `F2` reads (see
 * `redragonEncodeRead`), so every value shown is read from the mouse and
 * every write is read back before it is reported as done. Reads need no
 * session bracket; writes use the vendor bracket and commit block.
 *
 * DPI stages live per onboard profile, so writes target whichever profile
 * the mouse reports as active. DPI values snap to the positions RDCfg's
 * slider offers and report its label for them.
 */
export class RedragonM612HidClient extends RedragonHidClient {
  override getDpiOptions(): number[] {
    return [...REDRAGON_M612_DPI_LABELS];
  }

  override async readStatus(): Promise<MouseStatus> {
    return await this.run(async () => {
      await this.open();
      await this.probeConfigChannel();
      const settings = await this.readSettings();
      const product = REDRAGON_PRODUCTS.get(REDRAGON_M612_PRODUCT_ID)!;
      const labels = REDRAGON_M612_DPI_LABELS;
      return {
        brand: "Redragon",
        name: `Redragon ${product.name}`,
        ui: {
          family: "redragon",
          settingsReady: true,
          valuesVerified: true,
          hideUnsupportedPollingRates: true,
          hideProcessingCard: true,
          dpiStageEditor: {
            maxStages: REDRAGON_M612_STAGE_COUNT,
            countEditable: false,
            minDpi: labels[0]!,
            maxDpi: labels[labels.length - 1]!,
            stepDpi: 10,
          },
          defaultDisplayName: `Redragon ${product.name}`,
          showAdvancedSection: true,
        },
        batteryPercent: null,
        batteryState: "Unknown",
        dpi: settings.stages[settings.activeStage]!,
        dpiStages: settings.stages,
        activeDpiStage: settings.activeStage,
        pollingRateHz: settings.pollingHz,
        supportedPollingRates: this.supportedPollingRates,
        activeProfile: settings.profile + 1,
        profileCount: REDRAGON_M612_PROFILE_COUNT,
        buttonMappings: await this.readButtonMappings(settings.profile),
        buttonOptions: [...REDRAGON_M612_BUTTON_OPTIONS],
        lighting: await this.readLighting(),
        connectionType: "Wired",
        liftOffDistance: null,
        firmware: [],
      };
    });
  }

  /**
   * Rewrites one stage slot of the active profile, keeping its enabled byte,
   * then reads it back. Returns the DPI label the mouse now holds, which
   * can differ from the request by the slider's step.
   */
  override async setDpiStageValue(stage: number, dpi: number): Promise<number> {
    // Validate both before anything is sent.
    const code = redragonM612EncodeDpi(dpi);
    redragonM612SlotAddress(0, stage);
    return await this.run(async () => {
      await this.open();
      const address = redragonM612SlotAddress(await this.readActiveProfile(), stage);
      const slot = await this.readBytes(address, REDRAGON_M612_SLOT_LENGTH);
      await this.writeAndConfirm(address, [slot[0]!, code.value, code.range, code.value, code.range]);
      return code.dpi;
    });
  }

  /** Selects the active DPI stage of the active profile, as the DPI button does. */
  async setActiveDpiStage(stage: number): Promise<number> {
    if (!Number.isInteger(stage) || stage < 0 || stage >= REDRAGON_M612_STAGE_COUNT) {
      throw new Error(`Redragon M612 DPI stage ${stage} is outside 0-4.`);
    }
    return await this.run(async () => {
      await this.open();
      const base = REDRAGON_M612_PROFILE_BASES[await this.readActiveProfile()]!;
      await this.writeAndConfirm(base, [stage]);
      return stage;
    });
  }

  /** Rewrites the polling code, keeping the block's other bytes. */
  override async setPollingRate(hz: number): Promise<number> {
    const code = REDRAGON_POLLING_CODES[hz];
    if (code === undefined) {
      throw new Error(`Redragon polling rate ${hz} Hz is not offered; supported: ${REDRAGON_POLLING_RATES.join(", ")}.`);
    }
    return await this.run(async () => {
      await this.open();
      const block = await this.readBytes(REDRAGON_M612_POLL_ADDRESS, REDRAGON_M612_POLL_LENGTH);
      block[0] = code;
      await this.writeAndConfirm(REDRAGON_M612_POLL_ADDRESS, [...block]);
      return hz;
    });
  }

  /** Switches the onboard profile (1-5), exactly as RDCfg's MODE menu does. */
  async setProfile(profile: number): Promise<void> {
    if (!Number.isInteger(profile) || profile < 1 || profile > REDRAGON_M612_PROFILE_COUNT) {
      throw new Error(`Redragon M612 profile ${profile} is outside 1-${REDRAGON_M612_PROFILE_COUNT}.`);
    }
    await this.run(async () => {
      await this.open();
      const current = await this.readBytes(REDRAGON_M612_ACTIVE_PROFILE_ADDRESS, 2);
      const next = [profile - 1, current[1]!];
      await this.sendFrame(redragonEncodeWrite(REDRAGON_M612_ACTIVE_PROFILE_ADDRESS, next));
      await this.sendFrame(redragonEncodeCommit(REDRAGON_M612_PROFILE_SELECT_CODE));
      for (const code of REDRAGON_COMMIT_CODES) await this.sendFrame(redragonEncodeCommit(code));
      await this.confirm(REDRAGON_M612_ACTIVE_PROFILE_ADDRESS, next);
    });
  }

  /**
   * Assigns an action from `buttonOptions` to one button of the active
   * profile. Refuses to take away the profile's last left click, which would
   * leave the mouse unable to click.
   */
  async setButtonMapping(button: string, action: string): Promise<void> {
    const slot = M612_BUTTON_NAMES.indexOf(button as (typeof M612_BUTTON_NAMES)[number]);
    if (slot < 0) throw new Error(`The Redragon M612 has no button named "${button}".`);
    const value = redragonM612EncodeButtonAction(action);
    await this.run(async () => {
      await this.open();
      const profile = await this.readActiveProfile();
      if (action !== "Left click") {
        const mappings = await this.readButtonMappings(profile);
        const others = Object.entries(mappings).filter(([name, assigned]) => name !== button && assigned === "Left click");
        if (mappings[button] === "Left click" && others.length === 0) {
          throw new Error("Keep Left click on at least one button, or the mouse cannot click.");
        }
      }
      await this.writeAndConfirm(redragonM612ButtonAddress(profile, slot), value);
    });
  }

  /**
   * Writes the effect selector and that effect's parameter block. Lighting is
   * global, not per profile. A colour, speed, or brightness equal to what
   * the current effect shows is treated as unchanged, so switching effects
   * keeps the target effect's own stored values.
   */
  async setLighting(lighting: MouseLighting): Promise<void> {
    const effect = M612_MODES.find(([, mode]) => mode === lighting.mode)?.[0];
    if (!effect) throw new Error(`The Redragon M612 has no "${lighting.mode}" lighting effect.`);
    const info = REDRAGON_M612_EFFECTS.find((candidate) => candidate.effect === effect)!;
    if (lighting.speed != null && !M612_SPEEDS.includes(lighting.speed)) {
      throw new Error(`Redragon M612 lighting speed ${lighting.speed} is outside 1-${REDRAGON_M612_LIGHTING_SPEEDS}.`);
    }
    if (lighting.brightness != null && !M612_BRIGHTNESS.includes(lighting.brightness as 33)) {
      throw new Error(`Redragon M612 brightness ${lighting.brightness}% is not one of ${M612_BRIGHTNESS.join(", ")}.`);
    }
    const rgb = lighting.color == null ? null : parseColor(lighting.color);
    await this.run(async () => {
      await this.open();
      const shown = await this.readLighting();
      const selector = await this.readBytes(REDRAGON_M612_LIGHTING_EFFECT_ADDRESS, 2);
      const writes: Array<[number, number[]]> = [];
      if (info.block !== null) {
        const block = [...await this.readBytes(info.block, REDRAGON_M612_LIGHTING_BLOCK_LENGTH)];
        if (info.color && rgb && lighting.color !== shown.color) block.splice(1, 3, ...rgb);
        if (info.speed && lighting.speed != null && lighting.speed !== shown.speed) {
          block[5] = REDRAGON_M612_LIGHTING_SPEEDS + 1 - lighting.speed;
        }
        if (lighting.brightness != null && lighting.brightness !== shown.brightness) {
          block[7] = M612_BRIGHTNESS.indexOf(lighting.brightness as 33) + 1;
        }
        writes.push([info.block, block]);
      }
      writes.push([REDRAGON_M612_LIGHTING_EFFECT_ADDRESS, [info.bit, selector[1]!]]);
      await this.writeSession(async () => {
        for (const [address, data] of writes) await this.sendFrame(redragonEncodeWrite(address, data));
        for (const code of REDRAGON_COMMIT_CODES) await this.sendFrame(redragonEncodeCommit(code));
      });
      for (const [address, data] of writes) await this.confirm(address, data);
    });
  }

  private async readButtonMappings(profile: number): Promise<Record<string, string>> {
    const first = redragonM612ButtonAddress(profile, 0);
    const span = REDRAGON_M612_BUTTON_OFFSETS.at(-1)! + REDRAGON_M612_BUTTON_LENGTH;
    const bytes = await this.readRange(first, span);
    return Object.fromEntries(M612_BUTTON_NAMES.map((name, slot) => {
      const offset = REDRAGON_M612_BUTTON_OFFSETS[slot]!;
      return [name, redragonM612DecodeButtonAction(bytes.subarray(offset, offset + REDRAGON_M612_BUTTON_LENGTH))];
    }));
  }

  private async readLighting(): Promise<MouseLighting> {
    const [bit] = await this.readBytes(REDRAGON_M612_LIGHTING_EFFECT_ADDRESS, 1);
    const info = redragonM612EffectForBit(bit ?? -1);
    const block = info?.block != null ? await this.readBytes(info.block, REDRAGON_M612_LIGHTING_BLOCK_LENGTH) : null;
    const mode = M612_MODES.find(([effect]) => effect === info?.effect)?.[1] ?? null;
    const colorModes = M612_MODES.filter(([effect]) => REDRAGON_M612_EFFECTS.find((e) => e.effect === effect)!.color).map(([, m]) => m);
    const speedModes = M612_MODES.filter(([effect]) => REDRAGON_M612_EFFECTS.find((e) => e.effect === effect)!.speed).map(([, m]) => m);
    const lit = block !== null;
    return {
      zone: "Mouse",
      modes: M612_MODES.map(([, m]) => m),
      mode,
      color: block ? `#${[...block.subarray(1, 4)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` : null,
      color2: null,
      colorModes,
      dualColorModes: [],
      reactiveModes: speedModes,
      speeds: M612_SPEEDS,
      speed: block && info?.speed && block[5]! >= 1 && block[5]! <= REDRAGON_M612_LIGHTING_SPEEDS
        ? REDRAGON_M612_LIGHTING_SPEEDS + 1 - block[5]! : null,
      brightness: block ? (M612_BRIGHTNESS[block[7]! - 1] ?? null) : null,
      // Off has no parameter block, so there is no brightness to set.
      brightnessLevels: lit ? [...M612_BRIGHTNESS] : undefined,
    };
  }

  private async readRange(address: number, length: number): Promise<Uint8Array> {
    const out = new Uint8Array(length);
    for (let offset = 0; offset < length; offset += 8) {
      out.set(await this.readBytes(address + offset, Math.min(8, length - offset)), offset);
    }
    return out;
  }

  private async readSettings(): Promise<M612Settings> {
    const profile = await this.readActiveProfile();
    const base = REDRAGON_M612_PROFILE_BASES[profile]!;
    const [activeStage] = await this.readBytes(base, 1);
    if (activeStage === undefined || activeStage >= REDRAGON_M612_STAGE_COUNT) {
      throw new Error(`The Redragon M612 reported DPI stage ${activeStage}; expected 0-4.`);
    }
    const stages: number[] = [];
    for (let stage = 0; stage < REDRAGON_M612_STAGE_COUNT; stage++) {
      const slot = await this.readBytes(redragonM612SlotAddress(profile, stage), REDRAGON_M612_SLOT_LENGTH);
      stages.push(redragonM612DecodeDpi(slot[1]!, slot[2]!));
    }
    const [pollCode] = await this.readBytes(REDRAGON_M612_POLL_ADDRESS, 1);
    const pollingHz = REDRAGON_POLLING_RATES.find((hz) => REDRAGON_POLLING_CODES[hz] === pollCode);
    if (pollingHz === undefined) {
      throw new Error(`The Redragon M612 reported polling code ${pollCode}; expected 1, 2, 4, or 8.`);
    }
    return { profile, activeStage, stages, pollingHz };
  }

  private async readActiveProfile(): Promise<number> {
    const [profile] = await this.readBytes(REDRAGON_M612_ACTIVE_PROFILE_ADDRESS, 1);
    if (profile === undefined || profile >= REDRAGON_M612_PROFILE_BASES.length) {
      throw new Error(`The Redragon M612 reported profile ${profile}; expected 0-4.`);
    }
    return profile;
  }

  private async readBytes(address: number, length: number): Promise<Uint8Array> {
    await this.sendFrame(redragonEncodeRead(address, length));
    const view = await this.device.receiveFeatureReport(REDRAGON_REPORT_ID);
    const answer = new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength));
    return redragonDecodeRead(answer, address, length);
  }

  /** One write inside the vendor bracket + commit block, then a read-back. */
  private async writeAndConfirm(address: number, data: number[]): Promise<void> {
    await this.writeSession(async () => {
      await this.sendFrame(redragonEncodeWrite(address, data));
      for (const code of REDRAGON_COMMIT_CODES) {
        await this.sendFrame(redragonEncodeCommit(code));
      }
    });
    await this.confirm(address, data);
  }

  /** Reads `data.length` bytes back and throws unless they match. */
  private async confirm(address: number, data: readonly number[]): Promise<void> {
    const confirmed = await this.readBytes(address, data.length);
    if (confirmed.some((byte, index) => byte !== data[index])) {
      const hex = (bytes: ArrayLike<number>) => Array.from(bytes).map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
      throw new Error(`The Redragon M612 kept ${hex(confirmed)} at 0x${address.toString(16)} instead of ${hex(data)}.`);
    }
  }
}

function parseColor(color: string): [number, number, number] {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!match) throw new Error(`Redragon M612 colour "${color}" is not #rrggbb.`);
  return [parseInt(match[1]!, 16), parseInt(match[2]!, 16), parseInt(match[3]!, 16)];
}
