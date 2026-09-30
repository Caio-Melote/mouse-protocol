import assert from "node:assert/strict";
import test from "node:test";

import { RapooHidClient } from "./hid.ts";

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

const zeros = (count: number): string => "00 ".repeat(count).trim();

/** The address of every 0xA4 read in a send log, in order. */
function readAddresses(sent: ReadonlyArray<{ data: Uint8Array }>): number[] {
  return sent
    .filter((report) => report.data[1] === 0xa4)
    .map((report) => report.data[3] | (report.data[4] << 8) | (report.data[5] << 16));
}

/**
 * The register blocks a real VT9 Pro returned on 2026-09-29, keyed by the
 * address the driver asks for them at. Wired and wireless were identical.
 */
const BLOCKS: ReadonlyArray<readonly [number, string]> = [
  [0x880, "82 00 82 ff"],
  [0x884, "01 01 01 00"],
  [0x888, "90 01 20 03 b0 04 40 06 80 0c 00 19 90 65 02 00"],
  [0x898, "01 00 02 01"],
  [0x8c0, "04 04 78 03"],
];

const BLOCK_BY_ADDRESS = new Map(BLOCKS);

/** The 0x2A feature block as Windows returned it, on the cable. */
const STATUS_BLOCK = fromHex(`2a 01 00 00 04 21 50 00 00 62 ${zeros(51)}`);

const CONFIG_COLLECTION = {
  usagePage: 0xff00,
  usage: 0x000e,
  type: 1,
  children: [],
  inputReports: [],
  outputReports: [],
  featureReports: [],
} as unknown as HIDCollectionInfo;

/** `status` is what the transport hands back for GET_REPORT(Input). */
function busy(): Uint8Array {
  return fromHex("02 00 00 00 00 00 00 00");
}

function answered(block: string, withReportId = false): Uint8Array {
  const body = fromHex(`01 00 00 00 ${block}`);
  return withReportId ? Uint8Array.from([0xba, ...body]) : body;
}

/**
 * A HIDDevice that answers 0xBA the way the captures say the mouse does: a
 * busy report first, then the block. Addresses in `silentSends` drop that many
 * frames instead, which is what a lost frame looks like from the host.
 */
class FakeDevice {
  vendorId = 0x24ae;
  productId = 0x1205;
  productName = "Rapoo Gaming Device";
  opened = false;
  collections: HIDCollectionInfo[] = [CONFIG_COLLECTION];

  /** Every report the driver sent, in order. */
  sent: Array<{ reportId: number; data: Uint8Array }> = [];
  /** Every feature report the driver asked for. */
  featureReads: number[] = [];
  /** When true the 0x2A feature read fails, as it does on a sleeping mouse. */
  featureThrows = false;
  /** Address -> how many sends of it to swallow before answering. */
  silentSends = new Map<number, number>();
  /** Set when the transport keeps the report id in front of the answer. */
  keepReportId = false;
  /** Installed when the test wants GET_REPORT(Input) to exist. */
  receiveInputReport?: (reportId: number) => Promise<DataView>;

  private pending: Uint8Array[] = [];
  private listeners = new Set<(event: unknown) => void>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const view = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    const bytes = Uint8Array.from(view);
    this.sent.push({ reportId, data: bytes });
    if (reportId !== 0xba) return;

    if (bytes[1] === 0xaa) {
      // A battery answer carries the marker in byte 1 and needs no handshake.
      this.pending = [fromHex("01 01 62 00 00 00 00 00")];
      return;
    }

    const address = bytes[3] | (bytes[4] << 8) | (bytes[5] << 16) | (bytes[6] << 24);
    const swallow = this.silentSends.get(address) ?? 0;
    if (swallow > 0) {
      this.silentSends.set(address, swallow - 1);
      this.pending = [];
      return;
    }

    const block = BLOCK_BY_ADDRESS.get(address);
    this.pending = block
      ? [busy(), answered(block, this.keepReportId)]
      : [];
  }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    void data;
    this.sent.push({ reportId, data: new Uint8Array(0) });
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    this.featureReads.push(reportId);
    if (this.featureThrows) throw new Error("no feature report");
    return new DataView(STATUS_BLOCK.buffer, STATUS_BLOCK.byteOffset, STATUS_BLOCK.byteLength);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "inputreport") this.listeners.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (type === "inputreport") this.listeners.delete(listener);
  }

  /** Drive the unsolicited 0xBB report the mouse sends every ~3 seconds. */
  emitNotification(payload: string): void {
    const bytes = fromHex(payload);
    const event = {
      device: this,
      reportId: 0xbb,
      data: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    };
    for (const listener of this.listeners) listener(event);
  }

  /** The port of `receiveInputReport` a native transport installs. */
  attachNativeTransport(options: { keepReportId?: boolean } = {}): void {
    this.keepReportId = options.keepReportId ?? false;
    this.receiveInputReport = async (): Promise<DataView> => {
      const next = this.pending.shift();
      if (!next) throw new Error("no input report buffered");
      return new DataView(next.buffer, next.byteOffset, next.byteLength);
    };
  }

  asHidDevice(): HIDDevice {
    return this as unknown as HIDDevice;
  }
}

test("the driver claims both of the interfaces the mouse has been seen on", () => {
  const receiver = new FakeDevice();
  assert.equal(RapooHidClient.isSupported(receiver.asHidDevice()), true);

  const wired = new FakeDevice();
  wired.productId = 0x4405;
  assert.equal(RapooHidClient.isSupported(wired.asHidDevice()), true);

  const wrongVendor = new FakeDevice();
  wrongVendor.vendorId = 0x046d;
  assert.equal(RapooHidClient.isSupported(wrongVendor.asHidDevice()), false);

  const wrongProduct = new FakeDevice();
  wrongProduct.productId = 0x1206;
  assert.equal(RapooHidClient.isSupported(wrongProduct.asHidDevice()), false);

  // A Rapoo product without the 0xBA config collection is a different animal.
  const wrongCollection = new FakeDevice();
  wrongCollection.collections = [{
    usagePage: 0xff0b,
    usage: 0x0104,
    type: 1,
    children: [],
    inputReports: [],
    outputReports: [],
    featureReports: [],
  } as unknown as HIDCollectionInfo];
  assert.equal(RapooHidClient.isSupported(wrongCollection.asHidDevice()), false);
});

test("the config collection is found inside a child collection too", () => {
  const nested = new FakeDevice();
  nested.collections = [{
    usagePage: 0x0001,
    usage: 0x0002,
    type: 1,
    children: [CONFIG_COLLECTION],
    inputReports: [],
    outputReports: [],
    featureReports: [],
  } as unknown as HIDCollectionInfo];
  assert.equal(RapooHidClient.isSupported(nested.asHidDevice()), true);
});

test("a browser alone still gets the battery, and nothing is sent", async () => {
  const fake = new FakeDevice();
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  assert.equal(status.brand, "Rapoo");
  assert.equal(status.name, "Rapoo Gaming Device");
  assert.equal(status.batteryPercent, 98);
  // Charge state needs the 0xAA answer, which needs GET_REPORT(Input).
  assert.equal(status.batteryState, "Unknown");
  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.liftOffDistance, null);
  assert.deepEqual(status.firmware, []);
  assert.deepEqual(fake.featureReads, [0x2a]);
  // Without a transport that can carry the answer back there is nothing to
  // send, so the driver does not write to the mouse at all.
  assert.deepEqual(fake.sent, []);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, false);
  assert.equal(status.ui?.forceShowBattery, true);
  assert.match(status.ui?.statusNote ?? "", /Bridge/);
});

test("the register map is read through the busy -> OK handshake", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport();
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  // The stage-1 entry of the stored table is the live DPI.
  assert.equal(status.dpi, 800);
  assert.deepEqual(status.dpiStages, [400, 800, 1200]);
  assert.equal(status.activeDpiStage, 1);
  assert.equal(status.pollingRateHz, 4000);
  assert.equal(status.motionSync, true);
  assert.equal(status.debounceMs, 16);
  assert.equal(status.sleepTimeout, 120 * 60);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, false);
  assert.equal(status.batteryPercent, 98);
  assert.equal(status.batteryState, "Discharging");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "2.4 GHz receiver");
  assert.equal(status.ui?.valuesVerified, true);
  assert.equal(status.ui?.settingsReady, false);
  assert.match(status.ui?.statusNote ?? "", /Bridge/);

  // The first frame is the performance read.
  assert.equal(
    toHex(fake.sent[0].data),
      `a5 a4 04 80 08 00 00 ${zeros(24)}`,
  );
  // The battery is asked for with its own command, and the last frame is the
  // live re-read of the active stage.
  const batteryQuery = fake.sent.find((report) => report.data[1] === 0xaa);
    assert.equal(toHex(batteryQuery!.data), `a5 aa 00 00 00 00 00 ${zeros(24)}`);
    assert.equal(toHex(fake.sent[fake.sent.length - 1].data), `a5 a4 04 98 08 00 00 ${zeros(24)}`);
  assert.ok(fake.sent.every((report) => report.reportId === 0xba));
});

test("a wired mouse reads its cable polling rate and reports USB", async () => {
  const fake = new FakeDevice();
  fake.productId = 0x4405;
  fake.attachNativeTransport();
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  assert.equal(status.pollingRateHz, 4000);
  assert.equal(status.connectionType, "Wired");
  assert.equal(status.connectionDetail, "USB");
});

test("an answer that keeps the report id in front of the status decodes too", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport({ keepReportId: true });
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 4000);
});

test("a lost frame is sent again rather than read as a missing register", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport();
  // Swallow one round (four sends) of the sensor register.
  fake.silentSends.set(0x884, 4);
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  assert.equal(status.motionSync, true);
  const sensorSends = fake.sent.filter((report) => report.data[3] === 0x84 && report.data[4] === 0x08);
  assert.ok(sensorSends.length > 4, `expected a resend, saw ${sensorSends.length} sends`);
  // Nothing else was disturbed by the retry.
  assert.equal(status.dpi, 800);
  assert.equal(status.debounceMs, 16);
});

test("a register the whole first pass lost is read again instead of reported as zero", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport();
  // A cold mouse loses the first frames of a walk: swallowing all sixteen sends
  // of one round makes the first pass give up on the polling register. That is
  // what the real mouse did - one walk came back with pollingRateHz 0 and the
  // three walks after it read 4000.
  fake.silentSends.set(0x880, 16);
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  assert.equal(status.pollingRateHz, 4000);
  const pollingSends = fake.sent.filter((report) => report.data[3] === 0x80 && report.data[4] === 0x08);
  assert.ok(pollingSends.length > 16, `expected the walk to come back for it, saw ${pollingSends.length} sends`);
  // The second pass re-reads the gap and leaves the rest of the map alone.
  assert.equal(status.dpi, 800);
  assert.equal(status.debounceMs, 16);
});

test("the register map is walked once, not on every status refresh", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport();
  const client = new RapooHidClient(fake.asHidDevice());

  await client.readStatus();
  assert.deepEqual(readAddresses(fake.sent), [0x880, 0x884, 0x888, 0x898, 0x8c0, 0x898]);

  // The app refreshes status on a timer; each refresh re-reads the live stage
  // and the battery, and leaves the five-register walk alone.
  fake.sent.length = 0;
  await client.readStatus();
  assert.deepEqual(readAddresses(fake.sent), [0x898]);
  assert.ok(fake.sent.some((report) => report.data[1] === 0xaa));
});

test("the mouse is never asked for the feature that disconnects it", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport();
  const client = new RapooHidClient(fake.asHidDevice());
  await client.readStatus();

  // Feature 0x2B drops the link until the cable is pulled; nothing here may
  // touch it, on either side of the exchange.
  assert.ok(!fake.featureReads.includes(0x2b));
  assert.ok(fake.sent.every((report) => report.reportId !== 0x2b));
});

test("the unsolicited 0xBB report supplies the battery when nothing else answers", async () => {
  const fake = new FakeDevice();
  fake.featureThrows = true;
  const client = new RapooHidClient(fake.asHidDevice());
  await client.open();

  fake.emitNotification("b0 51 20 03 01 45");
  const status = await client.readStatus();

  assert.equal(status.batteryPercent, 69);
  assert.equal(status.connectionType, "Wireless");
});

test("a sleeping mouse is reported as unanswered, not as an empty map", async () => {
  const fake = new FakeDevice();
  fake.attachNativeTransport();
  // Every register frame is dropped, which is what an idle mouse looks like.
  for (const [address] of BLOCKS) fake.silentSends.set(address, 1000);
  const client = new RapooHidClient(fake.asHidDevice());

  const status = await client.readStatus();

  assert.equal(status.dpi, 0);
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.motionSync, undefined);
  assert.equal(status.ui?.valuesVerified, false);
  assert.match(status.ui?.statusNote ?? "", /wake/i);
  // The feature block keeps answering while the register channel is silent.
  assert.equal(status.batteryPercent, 98);
  // And the walk gave up after two silent registers instead of all five.
  const polled = new Set(fake.sent.map((report) => report.data[3] | (report.data[4] << 8)));
  assert.deepEqual([...polled].sort((a, b) => a - b), [0x880, 0x884]);
});

test("closing detaches the listener it installed", async () => {
  const fake = new FakeDevice();
  const client = new RapooHidClient(fake.asHidDevice());
  await client.open();
  assert.equal(fake.opened, true);

  await client.close();
  assert.equal(fake.opened, false);

  // A report arriving after close must not be remembered.
  fake.featureThrows = true;
  fake.emitNotification("b0 51 20 03 01 45");
  const status = await client.readStatus();
  assert.equal(status.batteryPercent, null);
});
