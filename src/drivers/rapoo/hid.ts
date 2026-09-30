import type { MouseStatus } from "../mouse-types.ts";
import {
  RAPOO_ADDRESS,
  RAPOO_BLOCK_LENGTH,
  RAPOO_CONFIG_REPORT_ID,
  RAPOO_CONFIG_USAGE,
  RAPOO_CONFIG_USAGE_PAGE,
  RAPOO_NOTIFY_REPORT_ID,
  RAPOO_PRODUCT_IDS,
  RAPOO_STATUS_REPORT_ID,
  RAPOO_VENDOR_ID,
  RAPOO_WIRELESS_PRODUCT_ID,
  decodeRapooActiveStage,
  decodeRapooAnswer,
  decodeRapooBatteryAnswer,
  decodeRapooDpiTable,
  decodeRapooNotification,
  decodeRapooPerformance,
  decodeRapooSensor,
  decodeRapooTiming,
  encodeRapooBatteryQuery,
  encodeRapooRead,
  rapooAnswerBlock,
  rapooLinkConnection,
  rapooStatusBatteryPercent,
  type RapooAnswer,
  type RapooBattery,
  type RapooDpiTable,
  type RapooNotification,
  type RapooPerformance,
  type RapooSensor,
  type RapooTiming,
} from "@openmouse/protocol/rapoo";

/**
 * Rapoo's configuration channel (VT9 Pro and its family), read-only for now.
 *
 * The mouse answers on 0xFF00:0x000E with output report 0xBA - 31 bytes of
 * report data, 32 on Windows because `HidP_GetCaps` counts the report id - and
 * the answer comes back through **GET_REPORT(Input)** rather than as an interrupt-IN
 * report. WebHID has no equivalent call - `receiveFeatureReport` reads a
 * feature report, not an input report - so in a plain browser every frame this
 * driver sends is delivered and its answer is dropped on the floor. That is a
 * property of the browser, not of the mouse: the same request is
 * `HidD_GetInputReport` on Windows, `HIDIOCGINPUT` on Linux hidraw, and
 * `receiveInputReport` in OpenMouse Bridge, and on all three the register map
 * reads back correctly.
 *
 * So the driver has two shapes:
 *
 * - **without a native transport** it does what a browser can still do. The
 *   0xFF0B:0x0104 interface answers a *feature* report, and that block carries
 *   the battery, so the battery is live; everything else stays unavailable and
 *   `ui.settingsReady` is false with a note saying why;
 * - **with `receiveInputReport`** it walks the register map through the
 *   busy -> OK handshake the vendor driver waits for, and reports DPI, polling
 *   rate, motion sync, debounce, sleep and the sensor flags as verified values.
 *
 * What is measured, from the capture in `captures/rapoo-vt9-pro/`:
 *
 * - **about 40% of frames are dropped** without the device ever going busy, so
 *   a read is sent again in rounds, and an OK that was not preceded by a busy
 *   is the previous command's answer rather than this one's;
 * - **an idle mouse stops answering 0xBA entirely.** Moving it wakes the
 *   channel up; the 0x2A feature read keeps working either way;
 * - **the connection byte is not validated** - 0xFF, 0xA5, 0x00, 0x01 and 0x5A
 *   all answered - so a dropped frame is never reported as "wrong link".
 *
 * Nothing here writes. The register map is a read-modify-write protocol: a
 * partial write is impossible, and the bytes this driver does not understand
 * (the reserved bytes in the performance block, the sensor and angle blocks)
 * have to be carried through untouched. That needs the read-back that only a
 * native transport provides, and it is a separate change.
 */

/**
 * The GET_REPORT(Input) call OpenMouse Bridge adds to `HIDDevice`, the same
 * extension the Microsoft driver uses. Optional: a device without it still
 * connects, it just cannot read registers.
 */
interface RapooNativeTransport {
  receiveInputReport(reportId: number): Promise<DataView>;
}

/**
 * How many times one frame is sent before a read is considered lost, and how
 * long to wait for the busy -> OK transition. The vendor driver sleeps 50 ms
 * between sends, shows busy within about 4 ms, and gives up on a frame 120 ms
 * after sending it - all three figures are its own.
 */
const EXCHANGE_ATTEMPTS = 4;
const EXCHANGE_RETRY_MS = 50;
const EXCHANGE_ACCEPT_MS = 120;
const EXCHANGE_POLL_MS = 2;

/**
 * How many times a whole read is retried before a register is called
 * unreadable. Four rounds of four sends read every address of the map on every
 * capture run, wired and wireless alike.
 */
const BLOCK_ROUNDS = 4;
const BLOCK_GAP_MS = 120;

/**
 * How many registers in a row have to come back empty before the walk gives up.
 *
 * One register can lose every frame and still be there - it was measured - so a
 * single empty result is not proof of anything. A mouse that is asleep or out
 * of range loses all of them, and the point of stopping is to keep that from
 * turning into a connect that looks hung: at ~2.9 s per silent register, a full
 * walk of the map costs about 14 s.
 */
const BLOCK_FAILURES_BEFORE_SLEEPING = 2;

/**
 * A battery query does not follow busy -> OK: the value is already sitting in
 * the device's input buffer, so the answer is found by looking for the marker
 * byte instead of by watching the handshake.
 */
const BATTERY_ROUNDS = 4;
const BATTERY_POLLS = 60;
const BATTERY_POLL_MS = 4;

/**
 * How long to wait before walking the register map again after a mouse that did
 * not answer. The sweep is the expensive part of a status read, and the app
 * refreshes status on a timer, so a mouse that was asleep at connect must not
 * make every refresh pay for it. It gets retried on the next read after the
 * window instead, which is what eventually catches a user who woke the mouse
 * up without reconnecting it.
 */
const SWEEP_RETRY_MS = 30_000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function asBytes(view: DataView): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Everything one walk of the register map produced. */
interface RapooRegisters {
  /** [0] is the 2.4 GHz rate, [2] the cable rate. */
  performance: RapooPerformance | null;
  sensor: RapooSensor | null;
  dpi: RapooDpiTable | null;
  activeStage: number | null;
  timing: RapooTiming | null;
}

export class RapooHidClient {
  readonly device: HIDDevice;

  /** The last unsolicited 0xBB status, which arrives about every three seconds. */
  private notification: RapooNotification | null = null;

  /**
   * The last battery answer from 0xAA - the only place the charge state is
   * readable. Kept across a status read so a frame lost to the lossy channel
   * does not blank the field.
   */
  private battery: RapooBattery | null = null;

  /**
   * The register map, walked once per session: five registers at four rounds
   * each is slow enough that repeating it on every status would hold up the
   * connect flow. The two values that change while the window is open - the
   * active DPI stage and the battery - are re-read every time instead.
   */
  private registers: RapooRegisters | null = null;

  /** When the walk last ran, so a silent mouse is retried and not re-walked. */
  private lastSweepAt = 0;

  /**
   * Status reads are serialized the way every driver here does it. The app can
   * ask for a status from its refresh timer while another read is in flight,
   * and two interleaved exchanges would pair one command's answer with
   * another's.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private listening = false;

  constructor(device: HIDDevice) {
    this.device = device;
  }

  static isSupported(device: HIDDevice): boolean {
    const search = (collection: HIDCollectionInfo): boolean =>
      (collection.usagePage === RAPOO_CONFIG_USAGE_PAGE
        && collection.usage === RAPOO_CONFIG_USAGE)
      || collection.children.some(search);
    return device.vendorId === RAPOO_VENDOR_ID
      && RAPOO_PRODUCT_IDS.has(device.productId)
      && device.collections.some(search);
  }

  private nativeTransport(): RapooNativeTransport | null {
    const candidate = this.device as unknown as Partial<RapooNativeTransport>;
    return typeof candidate.receiveInputReport === "function"
      ? candidate as RapooNativeTransport
      : null;
  }

  private readonly onInputReport = (event: HIDInputReportEvent): void => {
    if (event.reportId !== RAPOO_NOTIFY_REPORT_ID) return;
    const notification = decodeRapooNotification(asBytes(event.data));
    if (notification) this.notification = notification;
  };

  async open(): Promise<void> {
    if (!RapooHidClient.isSupported(this.device)) {
      throw new Error("The Rapoo configuration collection is unavailable.");
    }
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
    if (this.device.opened) await this.device.close();
  }

  /** Nothing is writable yet, so there is no range to offer. */
  getDpiOptions(): number[] {
    return [];
  }

  getPollingRateOptions(): number[] {
    return [];
  }

  async readStatus(): Promise<MouseStatus> {
    const next = this.queue.then(() => this.readStatusNow(), () => this.readStatusNow());
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readStatusNow(): Promise<MouseStatus> {
    await this.open();

    const native = this.nativeTransport();
    const wireless = this.device.productId === RAPOO_WIRELESS_PRODUCT_ID;

    // Feature reports work while the mouse is idle, and are the only Rapoo
    // read a browser can perform, so this one is always tried.
    const featureBattery = await this.readFeatureBattery();

    if (native) {
      if (!this.registers && Date.now() - this.lastSweepAt >= SWEEP_RETRY_MS) {
        this.lastSweepAt = Date.now();
        this.registers = await this.readRegisters(native);
      }
      // The battery query rides the same channel as the register walk, so it is
      // only worth asking when that walk found the mouse awake.
      if (this.registers) this.battery = await this.readBattery(native) ?? this.battery;
    } else {
      this.registers = null;
      this.battery = null;
    }

    const registers = this.registers;
    const liveStage = native && registers ? await this.readActiveStage(native) : null;

    const table = registers?.dpi ?? null;
    const stageIndex = liveStage ?? registers?.activeStage ?? null;
    const dpi = table && stageIndex !== null ? table.stages[stageIndex] ?? 0 : 0;

    const performance = registers?.performance ?? null;
    const pollingRateHz = (wireless ? performance?.receiverHz : performance?.wiredHz) ?? 0;

    const percent = this.battery?.percent
      ?? featureBattery
      ?? this.notification?.batteryPercent
      ?? null;
    const batteryState: MouseStatus["batteryState"] = this.battery
      ? this.battery.charging ? "Charging" : "Discharging"
      : "Unknown";

    // The 0xBB link byte is the live answer; the product id is the fallback,
    // because the byte has only ever been seen as 0x01 (receiver).
    const linked = this.notification ? rapooLinkConnection(this.notification.linkCode) : null;
    const connectionType: "Wired" | "Wireless" = linked ?? (wireless ? "Wireless" : "Wired");

    return {
      brand: "Rapoo",
      name: this.device.productName?.trim() || "Rapoo Mouse",
      ui: {
        family: "rapoo",
        settingsReady: false,
        valuesVerified: registers !== null,
        pollingReadOnly: true,
        hideProcessingCard: true,
        hideSignalCard: true,
        hideSleepCard: true,
        forceShowBattery: true,
        defaultDisplayName: "Rapoo Mouse",
        statusNote: this.statusNote(registers !== null, native !== null),
      },
      batteryPercent: percent,
      batteryState,
      dpi,
      ...(table ? {
        dpiStages: table.stages.slice(0, table.enabledStages),
      } : {}),
      ...(table && stageIndex !== null ? { activeDpiStage: stageIndex } : {}),
      pollingRateHz,
      activeProfile: null,
      // The stored lift-off selector is read, but the scale it indexes is not
      // established for this mouse, so no Low/Medium/High claim is made.
      liftOffDistance: null,
      ...(registers?.sensor ? { motionSync: registers.sensor.motionSync } : {}),
      ...(registers?.timing ? {
        // The mouse stores press and release separately; the shared field is
        // the press figure and the codec keeps both.
        debounceMs: registers.timing.pressDebounceMs,
        sleepTimeout: registers.timing.sleepMinutes * 60,
        angleSnapping: !registers.timing.angleSnapOff,
        rippleControl: !registers.timing.rippleOff,
      } : {}),
      connectionType,
      connectionDetail: connectionType === "Wireless" ? "2.4 GHz receiver" : "USB",
      firmware: [],
    };
  }

  private statusNote(readable: boolean, native: boolean): string {
    if (readable) {
      return "Settings are read through OpenMouse Bridge. This driver does not write to the mouse yet.";
    }
    if (native) {
      return "The mouse did not answer its register channel. Move it to wake it up and reconnect.";
    }
    return "Read-only in the browser: reading Rapoo's registers needs GET_REPORT(Input), which WebHID does not have, so only the battery is available. OpenMouse Bridge adds it and unlocks DPI, polling rate and the sensor settings.";
  }

  /** One more read of the live DPI stage, so a stage change is picked up. */
  private async readActiveStage(native: RapooNativeTransport): Promise<number | null> {
    const block = await this.readBlock(native, RAPOO_ADDRESS.activeStage, 4);
    return block ? decodeRapooActiveStage(block) : null;
  }

  private async readRegisters(native: RapooNativeTransport): Promise<RapooRegisters | null> {
    let answered = 0;
    let silent = 0;
    const blocks = new Map<number, Uint8Array>();
    const read = async (address: number): Promise<Uint8Array | null> => {
      const block = await this.readBlock(native, address, RAPOO_BLOCK_LENGTH[address]);
      if (block) {
        answered += 1;
        silent = 0;
      } else {
        silent += 1;
      }
      if (block) blocks.set(address, block);
      return block;
    };

    const addresses = [
      RAPOO_ADDRESS.performance,
      RAPOO_ADDRESS.sensor,
      RAPOO_ADDRESS.dpiX,
      RAPOO_ADDRESS.activeStage,
      RAPOO_ADDRESS.timing,
    ];

    await read(addresses[0]);
    for (const address of addresses.slice(1)) {
      if (silent < BLOCK_FAILURES_BEFORE_SLEEPING) await read(address);
    }

    // A mouse that answered nothing is asleep or out of range; saying so beats
    // reporting five null fields as if the registers did not exist.
    if (answered === 0) return null;

    // The first frames of a walk are the ones a mouse that was asleep a moment
    // ago loses: on the cable, one cold walk came back with the polling rate
    // missing and the three walks after it read it. One more pass over whatever
    // is still empty costs a healthy mouse nothing - it is only reached while
    // the mouse is answering, and every read here is idempotent - and turns
    // that gap into a value instead of a zero.
    for (const address of addresses) {
      if (!blocks.has(address)) await read(address);
    }

    const performance = blocks.get(RAPOO_ADDRESS.performance) ?? null;
    const sensor = blocks.get(RAPOO_ADDRESS.sensor) ?? null;
    const dpi = blocks.get(RAPOO_ADDRESS.dpiX) ?? null;
    const activeStage = blocks.get(RAPOO_ADDRESS.activeStage) ?? null;
    const timing = blocks.get(RAPOO_ADDRESS.timing) ?? null;

    return {
      performance: performance ? decodeRapooPerformance(performance) : null,
      sensor: sensor ? decodeRapooSensor(sensor) : null,
      dpi: dpi ? decodeRapooDpiTable(dpi) : null,
      activeStage: activeStage ? decodeRapooActiveStage(activeStage) : null,
      timing: timing ? decodeRapooTiming(timing) : null,
    };
  }

  /**
   * Read one register block, resending the frame until the device answers.
   *
   * Reads are idempotent, so a resend costs nothing but time; the alternative -
   * treating the first silence as "the register does not exist" - is what makes
   * a lossy channel look like a missing feature.
   */
  private async readBlock(
    native: RapooNativeTransport,
    address: number,
    length: number,
  ): Promise<Uint8Array | null> {
    const frame = encodeRapooRead(address, length);
    for (let round = 0; round < BLOCK_ROUNDS; round += 1) {
      if (round > 0) await delay(BLOCK_GAP_MS);
      const answer = await this.exchange(native, frame);
      const block = answer ? rapooAnswerBlock(answer, length) : null;
      if (block) return block;
    }
    return null;
  }

  /**
   * Send one frame and wait for the busy -> OK handshake.
   *
   * The input report holds the previous answer until the receiver picks the
   * frame up, so an OK that arrives without a busy in between belongs to the
   * command before this one and must not be handed back as data. Nothing
   * arrives at all for a dropped frame, so the wait is bounded and the frame is
   * sent again.
   */
  private async exchange(
    native: RapooNativeTransport,
    frame: Uint8Array,
  ): Promise<RapooAnswer | null> {
    for (let attempt = 0; attempt < EXCHANGE_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(EXCHANGE_RETRY_MS);

      try {
        await this.device.sendReport(RAPOO_CONFIG_REPORT_ID, frame);
      } catch {
        continue;
      }

      const sent = Date.now();
      let busy = false;
      // Busy shows up within a few milliseconds and the fresh answer follows it
      // across the radio round trip. A frame that has neither by 120 ms was
      // dropped, whatever the transport is doing in the meantime.
      while (Date.now() - sent < EXCHANGE_ACCEPT_MS) {
        const raw = await this.getInputReport(native);
        const answer = raw ? decodeRapooAnswer(raw) : null;
        if (answer) {
          if (!answer.ok) {
            busy = true;
          } else if (busy) {
            return answer;
          }
        }
        await delay(EXCHANGE_POLL_MS);
      }
    }
    return null;
  }

  /**
   * The `0xAA` battery query. Its answer is marked by a non-zero byte 1 rather
   * than by the handshake, so each send is followed by a short poll for the
   * marker instead of the busy -> OK wait.
   */
  private async readBattery(native: RapooNativeTransport): Promise<RapooBattery | null> {
    const frame = encodeRapooBatteryQuery();
    for (let round = 0; round < BATTERY_ROUNDS; round += 1) {
      try {
        await this.device.sendReport(RAPOO_CONFIG_REPORT_ID, frame);
      } catch {
        return null;
      }

      for (let poll = 0; poll < BATTERY_POLLS; poll += 1) {
        const raw = await this.getInputReport(native);
        const answer = raw ? decodeRapooAnswer(raw) : null;
        const battery = answer ? decodeRapooBatteryAnswer(answer) : null;
        if (battery) return battery;
        await delay(BATTERY_POLL_MS);
      }
    }
    return null;
  }

  private async getInputReport(native: RapooNativeTransport): Promise<Uint8Array | null> {
    try {
      return asBytes(await native.receiveInputReport(RAPOO_CONFIG_REPORT_ID));
    } catch {
      // A transport with nothing buffered throws. That is a "not yet", not a
      // reason to abandon the exchange.
      return null;
    }
  }

  /** The battery out of the 0x2A feature block, or null when it will not read. */
  private async readFeatureBattery(): Promise<number | null> {
    try {
      const view = await this.device.receiveFeatureReport(RAPOO_STATUS_REPORT_ID);
      return rapooStatusBatteryPercent(asBytes(view));
    } catch {
      return null;
    }
  }
}
