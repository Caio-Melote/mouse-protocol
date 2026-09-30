import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  KSNAKE_PRODUCT_ID,
  KSNAKE_MACRO_REPORT_ID,
  KSNAKE_USAGE,
  KSNAKE_USAGE_PAGE,
  ksnakeDecodeBattery,
  ksnakeDecodeConfig,
  ksnakeDecodeLightMode,
  ksnakeDecodeKeys,
  ksnakeDecodeMacroChunk,
  ksnakeDecodePollingRate,
  ksnakeDecodeVersion,
  ksnakeEncodePollingRate,
  ksnakeEncodeSetLightMode,
  ksnakeEncodeSetConfig,
  ksnakeEncodeSetKeys,
  ksnakeEncodeMacroChunk,
  ksnakeEncodeMacroCommit,
  ksnakeGetBatteryRequest,
  ksnakeGetConfigRequest,
  ksnakeGetKeysRequest,
  ksnakeGetMacroChunkRequest,
  ksnakeGetVersionRequest,
  ksnakeFindButtonAction,
  ksnakeBindingLabel,
  ksnakeEncodeMacroData,
  ksnakeDecodeMacroData,
  ksnakeIsKnownKeyType,
  ksnakeIsValidDpi,
  ksnakeKeysLookPlausible,
  isNoirM2NexDevice,
} from "../../ksnake/index.js";
import { KsnakeHidClient } from "./hid.ts";
import { createSupportedClient, deviceBrand } from "../registry.ts";

function fakeDevice(overrides?: Partial<HIDDevice>): HIDDevice {
  return {
    vendorId: 0xa8a5,
    productId: KSNAKE_PRODUCT_ID,
    productName: "USB Receiver",
    opened: false,
    collections: [{ usagePage: KSNAKE_USAGE_PAGE, usage: KSNAKE_USAGE, children: [] }],
    open: async () => {},
    close: async () => {},
    sendReport: async () => {},
    sendFeatureReport: async () => {},
    receiveFeatureReport: async () => new DataView(new ArrayBuffer(64)),
    addEventListener: () => {},
    removeEventListener: () => {},
    ...overrides,
  } as unknown as HIDDevice;
}

describe("ksnake codec", () => {
  it("frames version/battery/config requests", () => {
    assert.equal(ksnakeGetVersionRequest()[1], 0x03);
    assert.equal(ksnakeGetBatteryRequest()[1], 0x30);
    assert.deepEqual([...ksnakeGetConfigRequest().slice(0, 7)], [0x55, 0x0e, 0xa5, 0x0b, 0x2f, 0x01, 0x01]);
  });

  it("decodes version ASCII", () => {
    const reply = new Uint8Array(64);
    reply[23] = 49;
    reply[24] = 50;
    reply[25] = 51;
    assert.equal(ksnakeDecodeVersion(reply), "1.2.3");
  });

  it("decodes battery", () => {
    const reply = new Uint8Array(64);
    reply[8] = 87;
    reply[9] = 1;
    assert.deepEqual(ksnakeDecodeBattery(reply), { percent: 87, charging: 1 });
  });

  it("falls back to defaults on blank config", () => {
    const config = ksnakeDecodeConfig(new Uint8Array(64));
    assert.ok(config);
    assert.deepEqual(config?.stages.slice(0, 4), [800, 1200, 1600, 3200]);
    // Retail hardware reports 6 enabled stages.
    assert.equal(config?.dpiCount, 6);
  });

  it("validates the vendor DPI range (200-12000, whole numbers)", () => {
    for (const dpi of [200, 600, 800, 1200, 1600, 3200, 5000, 12000]) {
      assert.equal(ksnakeIsValidDpi(dpi), true);
    }
    for (const dpi of [0, 100, 150, 12001, 26000, 1600.5, Number.NaN]) {
      assert.equal(ksnakeIsValidDpi(dpi), false);
    }
  });

  it("round-trips polling rates (X11: 125-1000 Hz)", () => {
    for (const hz of [125, 250, 500, 1000]) {
      const index = ksnakeEncodePollingRate(hz);
      assert.ok(index !== null);
      assert.equal(ksnakeDecodePollingRate(index as number), hz);
    }
  });

  it("frames the vendor lighting modes", () => {
    assert.equal(ksnakeDecodeLightMode(6), "Breathing Loop");
    assert.equal(ksnakeDecodeLightMode(99), null);
    assert.deepEqual(
      [...ksnakeEncodeSetLightMode(4).slice(0, 11)],
      [0x55, 0x21, 0, 0, 3, 0, 0, 0, 0, 0, 4],
    );
  });

  it("encodes setConfig with vendor layout", () => {
    const req = ksnakeEncodeSetConfig({
      lightMode: 2,
      reportRate: 3,
      dpiIndex: 2,
      dpiCount: 5,
      stages: [800, 1200, 1600, 3200, 5000, 12000],
      scrollFlag: 0,
      lodValue: 1,
      sensorFlag: 53,
      keyRespond: 2,
      sleepLight: 10,
      highspeedMode: 0,
      wakeupFlag: 1,
      moveLightFlag: 1,
    });
    assert.equal(req[10], 4);
    assert.equal(req[12], 3);
    assert.equal(req[17], 0x40);
    assert.equal(req[18], 0x06);
  });
});

describe("KsnakeHidClient", () => {
  it("matches the X11 control collection", () => {
    assert.equal(KsnakeHidClient.isSupported(fakeDevice()), true);
    assert.equal(KsnakeHidClient.isSupported(fakeDevice({ vendorId: 0xa8a4, productName: "M2-NEX" })), true);
    assert.equal(KsnakeHidClient.isSupported(fakeDevice({ vendorId: 0x046d })), false);
    assert.equal(KsnakeHidClient.isSupported(fakeDevice({ productId: 0x1234 })), false);
  });

  it("recognizes the M2-NEX retail identity without changing the shared transport", () => {
    assert.equal(isNoirM2NexDevice(fakeDevice({ productName: "M2-NEX" })), true);
    assert.equal(isNoirM2NexDevice(fakeDevice({ productName: "K-snake X11" })), false);
    const client = createSupportedClient(fakeDevice({ vendorId: 0xa8a4, productName: "M2-NEX" }));
    assert.ok(client instanceof KsnakeHidClient);
    assert.equal(deviceBrand(client), "Noir Gear");
  });

  it("rejects unsupported polling rates without touching HID", async () => {
    const client = new KsnakeHidClient(fakeDevice());
    await assert.rejects(() => client.setPollingRate(9999), /does not support/);
  });
});

type FakeListener = (event: { data: DataView; reportId?: number }) => void;

function configReply(
  stages: number[],
  reportRate: number,
  dpiIndex: number,
  lodValue = 1,
  options: { lightMode?: number; scrollFlag?: number; sleepLight?: number; flags?: number } = {},
): Uint8Array {
  const reply = new Uint8Array(64);
  reply[9] = options.lightMode ?? 2;
  reply[10] = reportRate + 1;
  reply[11] = 6;
  reply[12] = dpiIndex + 1;
  stages.forEach((stage, i) => {
    reply[13 + i * 2] = stage & 0xff;
    reply[14 + i * 2] = (stage >> 8) & 0xff;
  });
  reply[48] = options.scrollFlag ?? 0;
  reply[49] = lodValue;
  reply[50] = 53;
  reply[51] = 2;
  reply[52] = options.sleepLight ?? 10;
  reply[53] = 0;
  reply[55] = options.flags ?? 0x11;
  return reply;
}

/** HIDDevice stand-in backed by emulated mouse state. */
class FakeKsnakeDevice {
  vendorId = 0xa8a5;
  productId = KSNAKE_PRODUCT_ID;
  productName = "USB Receiver";
  collections = [{ usagePage: KSNAKE_USAGE_PAGE, usage: KSNAKE_USAGE, children: [] }];
  opened = false;
  stages = [800, 1200, 1600, 3200, 5000, 12000];
  reportRate = 3;
  dpiIndex = 2;
  lodValue = 1;
  lightMode = 2;
  scrollFlag = 0;
  sleepLight = 10;
  flags = 0x11;
  /** 8 wire key slots, mirroring a retail dump (slot 4 = macro reference). */
  keys = [
    { type: 32, code1: 1, code2: 0, code3: 0 },
    { type: 32, code1: 2, code2: 0, code3: 0 },
    { type: 32, code1: 4, code2: 0, code3: 0 },
    { type: 32, code1: 8, code2: 0, code3: 0 },
    { type: 112, code1: 0, code2: 1, code3: 3 },
    { type: 33, code1: 85, code2: 0, code3: 0 },
    { type: 33, code1: 56, code2: 1, code3: 0 },
    { type: 33, code1: 56, code2: 255, code3: 0 },
  ];
  /** Upcoming replies to swallow (simulates a sleeping dongle). */
  dropReplies = 0;
  /** Next version reply decodes to null once (simulates a crossed report). */
  badVersionOnce = false;
  /** Next battery reply exceeds 100% once (simulates a crossed report). */
  badBatteryOnce = false;
  /** Next keys reply is zeroed once (simulates a stray report). */
  badKeysOnce = false;
  /** Next keys reply is plausible-but-wrong once (simulates a crossed report). */
  garbageKeysOnce = false;
  macro = Uint8Array.from({ length: 4096 }, (_, index) => index & 0xff);
  sent: number[] = [];
  private listeners = new Map<string, Set<FakeListener>>();

  async open(): Promise<void> {
    this.opened = true;
  }

  async close(): Promise<void> {
    this.opened = false;
  }

  addEventListener(type: string, listener: FakeListener): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: FakeListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  async sendReport(reportId: number, payload: ArrayBuffer): Promise<void> {
    const body = new Uint8Array(payload);
    if (reportId === KSNAKE_MACRO_REPORT_ID && body[0] === 0x0c) {
      const length = body[1];
      const offset = body[2] | (body[3] << 8);
      const reply = new Uint8Array(64);
      reply.set(this.macro.slice(offset, offset + length), 8);
      queueMicrotask(() => {
        const data = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
        this.listeners.get("inputreport")?.forEach((listener) => listener({ data, reportId }));
      });
      return;
    }
    this.sent.push(body[1]);
    let reply: Uint8Array;
    if (body[1] === 0x03) {
      reply = new Uint8Array(64);
      if (!this.badVersionOnce) {
        reply[23] = 50; // "2"
        reply[24] = 49; // "1"
        reply[25] = 55; // "7"
      }
      this.badVersionOnce = false;
    } else if (body[1] === 0x30) {
      reply = new Uint8Array(64);
      reply[8] = this.badBatteryOnce ? 200 : 81;
      reply[9] = 0;
      this.badBatteryOnce = false;
    } else if (body[1] === 0x08) {
      reply = new Uint8Array(64);
      if (this.garbageKeysOnce) {
        for (let i = 0; i < 8; i++) {
          reply[8 + i * 4] = 99;
          reply[9 + i * 4] = i;
        }
      } else if (!this.badKeysOnce) {
        this.keys.forEach((key, i) => {
          reply[8 + i * 4] = key.type;
          reply[9 + i * 4] = key.code1;
          reply[10 + i * 4] = key.code2;
          reply[11 + i * 4] = key.code3;
        });
      }
      this.badKeysOnce = false;
      this.garbageKeysOnce = false;
    } else if (body[1] === 0x09) {
      for (let i = 0; i < 8; i++) {
        this.keys[i] = { type: body[8 + i * 4], code1: body[9 + i * 4], code2: body[10 + i * 4], code3: body[11 + i * 4] };
      }
      reply = new Uint8Array(64);
      this.keys.forEach((key, i) => {
        reply[8 + i * 4] = key.type;
        reply[9 + i * 4] = key.code1;
        reply[10 + i * 4] = key.code2;
        reply[11 + i * 4] = key.code3;
      });
    } else if (body[1] === 0x21) {
      this.lightMode = body[10];
      reply = new Uint8Array(64);
      reply[1] = 0x21;
      reply[10] = this.lightMode;
    } else if (body[1] === 0x0d) {
      const length = body[4];
      const offset = body[5] | (body[6] << 8);
      this.macro.set(body.slice(8, 8 + length), offset);
      reply = new Uint8Array(64);
      reply[1] = 0x0d;
    } else if (body[1] === 0x10) {
      reply = new Uint8Array(64);
      reply[1] = 0x10;
    } else {
      if (body[1] === 0x0f) {
        for (let i = 0; i < 6; i++) {
          this.stages[i] = body[13 + i * 2] | (body[14 + i * 2] << 8);
        }
        this.reportRate = body[10] - 1;
        this.dpiIndex = body[12] - 1;
        this.lodValue = body[49];
        this.lightMode = body[9];
        this.scrollFlag = body[48];
        this.sleepLight = body[52];
        this.flags = body[54];
      }
      reply = configReply(this.stages, this.reportRate, this.dpiIndex, this.lodValue, {
        lightMode: this.lightMode,
        scrollFlag: this.scrollFlag,
        sleepLight: this.sleepLight,
        flags: this.flags,
      });
    }
    queueMicrotask(() => {
      if (this.dropReplies > 0) {
        this.dropReplies -= 1;
        return;
      }
      const data = new DataView(reply.buffer, reply.byteOffset, reply.byteLength);
      this.listeners.get("inputreport")?.forEach((listener) => listener({ data, reportId }));
    });
  }
}

function fastClient(device: FakeKsnakeDevice): KsnakeHidClient {
  return new KsnakeHidClient(device as unknown as HIDDevice, {
    replyTimeoutMs: 20,
    settleAfterWriteMs: 0,
  });
}

describe("KsnakeHidClient writes", () => {
  it("writes the active DPI stage and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setDpi(800), 800);
    assert.equal(device.stages[2], 800);
    assert.deepEqual(device.sent, [0x0e, 0x0f, 0x0e]);
  });

  it("recovers when the first reply is lost", async () => {
    const device = new FakeKsnakeDevice();
    device.dropReplies = 1;
    assert.equal(await fastClient(device).setDpi(2400), 2400);
    assert.equal(device.stages[2], 2400);
  });

  it("reports an unreadable config when the mouse stays silent", async () => {
    const device = new FakeKsnakeDevice();
    device.dropReplies = 99;
    await assert.rejects(() => fastClient(device).setDpi(800), /Could not read the current config/);
  });

  it("writes the polling-rate index and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setPollingRate(500), 500);
    assert.equal(device.reportRate, 2);
  });

  it("exposes and writes the vendor sleep timeout choices", async () => {
    const device = new FakeKsnakeDevice();
    const client = fastClient(device);

    assert.deepEqual(client.getSleepOptions(), [60, 180, 300, 600, 1200, 1800, 3600]);
    assert.equal((await client.readStatus()).sleepTimeout, 600);
    assert.equal(await client.setSleepTimeout(180), 180);
    assert.equal(device.sleepLight, 3);
    assert.equal((await client.readStatus()).sleepTimeout, 180);
  });

  it("exposes and writes the vendor scroll direction and lighting mode", async () => {
    const device = new FakeKsnakeDevice();
    const client = fastClient(device);
    const status = await client.readStatus();
    assert.equal(status.scrollDirection, "Forward");
    assert.equal(status.lighting?.mode, "Neon");
    assert.equal(await client.setScrollDirection("Reverse"), "Reverse");
    assert.equal(device.scrollFlag, 1);
    const lighting = await client.setLighting({
      zone: "Mouse",
      modes: ["Off", "Neon"],
      mode: "Off",
      color: null,
      color2: null,
      colorModes: [],
      dualColorModes: [],
      reactiveModes: [],
      speeds: [],
      speed: null,
    });
    assert.equal(lighting.mode, "Off");
    assert.equal(device.lightMode, 0);
    const after = await client.readStatus();
    assert.equal(after.scrollDirection, "Reverse");
    assert.equal(after.lighting?.mode, "Off");
  });

  it("switches the active DPI stage and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setActiveDpiStage(4), 4);
    assert.equal(device.dpiIndex, 4);
    assert.deepEqual(device.sent, [0x0e, 0x0f, 0x0e]);
  });

  it("rejects out-of-range DPI stages without writing", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setActiveDpiStage(6), /between 1 and 6/);
    await assert.rejects(() => fastClient(device).setDpiStageValue(0, 100), /between 200 and 12000/);
    assert.ok(!device.sent.includes(0x0f), "no SET must be sent");
  });

  it("edits a single DPI stage value and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setDpiStageValue(0, 600), 600);
    assert.equal(device.stages[0], 600);
  });

  it("reads the optional macro store through report 6", async () => {
    const device = new FakeKsnakeDevice();
    const data = await fastClient(device).getMacroData();
    assert.deepEqual(data, device.macro);
  });

  it("reads and writes decoded onboard macro profiles", async () => {
    const device = new FakeKsnakeDevice();
    const client = fastClient(device);
    const profiles = [
      { steps: [
        { type: 2 as const, action: 1 as const, delayMs: 12, code: 4 },
        { type: 2 as const, action: 2 as const, delayMs: 34, code: 4 },
      ] },
      { steps: [{ type: 3 as const, action: 1 as const, delayMs: 2, code: 1 }] },
    ];

    await client.setMacros(profiles);
    const decoded = await client.getMacros();
    assert.deepEqual(decoded.slice(0, 2), profiles);
    assert.equal(decoded.slice(2).every((profile) => profile.steps.length === 0), true);
  });

  it("uploads macro chunks and waits for vendor acknowledgements", async () => {
    const device = new FakeKsnakeDevice();
    const data = Uint8Array.from({ length: 60 }, (_, index) => (255 - index) & 0xff);

    await fastClient(device).setMacroData(data);

    assert.deepEqual([...device.macro.slice(0, data.length)], [...data]);
    assert.deepEqual(device.sent.filter((command) => command === 0x0d || command === 0x10), [0x0d, 0x0d, 0x10]);
  });

  it("retries status reads that fail validation", async () => {
    const device = new FakeKsnakeDevice();
    device.badVersionOnce = true;
    device.badBatteryOnce = true;
    const status = await fastClient(device).readStatus();
    assert.deepEqual(status.firmware, ["X11 2.1.7"]);
    assert.equal(status.batteryPercent, 81);
    assert.equal(status.liftOffDistance, "Low");
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  });

  it("writes the lift-off distance and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    assert.equal(await fastClient(device).setLiftOffDistance("High"), "High");
    assert.equal(device.lodValue, 2);
  });

  it("does not write lift-off when the firmware reports an unknown value", async () => {
    const device = new FakeKsnakeDevice();
    device.lodValue = 0xff;
    await assert.rejects(
      () => fastClient(device).setLiftOffDistance("Low"),
      /did not report a readable lift-off/,
    );
    assert.ok(!device.sent.includes(0x0f));
  });

  it("rejects the unsupported medium lift-off distance", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setLiftOffDistance("Medium"), /does not support a medium/);
  });

  it("decodes all 8 wire key slots from a keys reply", () => {
    const reply = new Uint8Array(64);
    const slots = [
      [32, 1, 0, 0], [32, 2, 0, 0], [32, 4, 0, 0], [32, 8, 0, 0],
      [112, 0, 1, 3], [33, 85, 0, 0], [33, 56, 1, 0], [33, 56, 255, 0],
    ];
    slots.forEach(([type, c1, c2, c3], i) => {
      reply[8 + i * 4] = type;
      reply[9 + i * 4] = c1;
      reply[10 + i * 4] = c2;
      reply[11 + i * 4] = c3;
    });
    assert.deepEqual(ksnakeDecodeKeys(reply), slots.map(([type, code1, code2, code3]) => ({ type, code1, code2, code3 })));
    assert.equal(ksnakeDecodeKeys(new Uint8Array(10)), null);
  });

  it("rejects the M2-NEX all-0xff key-map sentinel", () => {
    const unavailable = Array.from({ length: 8 }, () => ({ type: 0xff, code1: 0xff, code2: 0xff, code3: 0xff }));
    assert.equal(ksnakeKeysLookPlausible(unavailable), false);
  });

  it("encodes setKeys with the vendor layout and fixed tail", () => {
    const req = ksnakeEncodeSetKeys([
      { type: 32, code1: 1, code2: 0, code3: 0 },
      { type: 32, code1: 2, code2: 0, code3: 0 },
      { type: 32, code1: 4, code2: 0, code3: 0 },
      { type: 32, code1: 8, code2: 0, code3: 0 },
      { type: 32, code1: 16, code2: 0, code3: 0 },
      { type: 33, code1: 85, code2: 0, code3: 0 },
    ]);
    assert.deepEqual([...req.slice(0, 5)], [0x55, 0x09, 0xa5, 0x22, 0x20]);
    // Wire offsets (vendor t[9..] minus the t[0] report-id placeholder):
    // slot 0 type at data[8], slot 5 at data[28..31], wheel slots at data[32..39].
    assert.deepEqual([...req.slice(8, 12)], [32, 1, 0, 0]);
    assert.deepEqual([...req.slice(28, 32)], [33, 85, 0, 0]);
    assert.deepEqual([...req.slice(32, 40)], [33, 56, 1, 0, 33, 56, 255, 0]);
    assert.deepEqual([...req.slice(40)], new Array(24).fill(0));
  });

  it("keeps the verified vendor-control bindings byte-for-byte", () => {
    assert.equal(ksnakeIsKnownKeyType(16), true);
    assert.deepEqual(ksnakeFindButtonAction("Escape"), { type: 16, code1: 0, code2: 41, code3: 0 });
    assert.deepEqual(ksnakeFindButtonAction("DPI +"), { type: 240, code1: 1, code2: 1, code3: 0 });
    assert.deepEqual(ksnakeFindButtonAction("DPI -"), { type: 240, code1: 1, code2: 2, code3: 0 });
    assert.deepEqual(ksnakeFindButtonAction("Report Rate +"), { type: 240, code1: 2, code2: 1, code3: 0 });
    assert.deepEqual(ksnakeFindButtonAction("Web refresh"), { type: 48, code1: 39, code2: 2, code3: 0 });
    assert.deepEqual(ksnakeFindButtonAction("Macro 4"), { type: 112, code1: 3, code2: 0, code3: 0 });
    assert.equal(ksnakeBindingLabel({ type: 112, code1: 3, code2: 1, code3: 3 }), "Macro 4");
  });

  it("frames and round-trips the vendor macro memory format", () => {
    const profiles = [
      {
        steps: [
          { type: 2 as const, action: 1 as const, delayMs: 10, code: 4 },
          { type: 2 as const, action: 2 as const, delayMs: 25, code: 4 },
        ],
      },
      { steps: [] },
      {
        steps: [{ type: 3 as const, action: 1 as const, delayMs: 2, code: 1 }],
      },
    ];
    const data = ksnakeEncodeMacroData(profiles);
    assert.equal(data.length, 68 + 12);
    assert.deepEqual([...data.slice(0, 8)], [68, 0, 64, 0, 76, 0, 64, 0]);
    assert.deepEqual([...data.slice(64, 72)], [0, 0, 0x80, 0, 10, 0, 0x42, 4]);
    assert.deepEqual([...data.slice(72, 80)], [25, 0, 0x82, 4, 2, 0, 0xc3, 1]);
    assert.deepEqual(ksnakeDecodeMacroData(data)?.slice(0, 3), profiles);

    const modifier = ksnakeEncodeMacroData([{
      steps: [{ type: 1 as const, action: 1 as const, delayMs: 5, code: 2 }],
    }]);
    assert.deepEqual([...modifier.slice(68, 72)], [5, 0, 0xc1, 2]);
    assert.deepEqual(ksnakeDecodeMacroData(modifier)?.[0], {
      steps: [{ type: 1, action: 1, delayMs: 5, code: 2 }],
    });

    const request = ksnakeGetMacroChunkRequest(56, 12);
    assert.equal(request.reportId, KSNAKE_MACRO_REPORT_ID);
    assert.deepEqual([...request.body.slice(0, 4)], [0x0c, 12, 56, 0]);
    const reply = new Uint8Array(64);
    reply.set(data.slice(56, 68), 8);
    assert.deepEqual([...ksnakeDecodeMacroChunk(reply, 12)!], [...data.slice(56, 68)]);

    const chunk = ksnakeEncodeMacroChunk(64, data.slice(64, 76));
    assert.deepEqual([...chunk.slice(0, 8)], [0x55, 0x0d, 0, 0, 12, 64, 0, 0]);
    assert.deepEqual([...chunk.slice(8, 20)], [...data.slice(64, 76)]);
    assert.deepEqual([...ksnakeEncodeMacroCommit().slice(0, 9)], [0x55, 0x10, 0xa5, 0x22, 0, 0, 0, 0, 5]);
  });

  it("writes a button map and confirms it", async () => {
    const device = new FakeKsnakeDevice();
    device.keys = [
      { type: 32, code1: 1, code2: 0, code3: 0 },
      { type: 32, code1: 2, code2: 0, code3: 0 },
      { type: 32, code1: 4, code2: 0, code3: 0 },
      { type: 32, code1: 8, code2: 0, code3: 0 },
      { type: 32, code1: 16, code2: 0, code3: 0 },
      { type: 33, code1: 85, code2: 0, code3: 0 },
      { type: 33, code1: 56, code2: 1, code3: 0 },
      { type: 33, code1: 56, code2: 255, code3: 0 },
    ];
    const next = device.keys.map((key) => ({ ...key }));
    next[4] = { type: 48, code1: 233, code2: 0, code3: 0 }; // Forward -> Volume+
    const returned = await fastClient(device).setKeys(next);
    assert.deepEqual(returned, next);
    assert.deepEqual(device.keys[4], { type: 48, code1: 233, code2: 0, code3: 0 });
    assert.ok(device.sent.includes(0x09));
  });

  it("preserves macro bindings while remapping another button", async () => {
    const device = new FakeKsnakeDevice();
    await fastClient(device).setButtonMapping("Backward", "Volume +");
    assert.deepEqual(device.keys[3], { type: 48, code1: 233, code2: 0, code3: 0 });
    assert.deepEqual(device.keys[4], { type: 112, code1: 0, code2: 1, code3: 3 });
    assert.ok(device.sent.includes(0x09));
  });

  it("remaps a wheel slot without touching the fixed DPI or opposite wheel slot", async () => {
    const device = new FakeKsnakeDevice();
    await fastClient(device).setButtonMapping("Scroll up", "DPI +");
    assert.deepEqual(device.keys[5], { type: 33, code1: 85, code2: 0, code3: 0 });
    assert.deepEqual(device.keys[6], { type: 240, code1: 1, code2: 1, code3: 0 });
    assert.deepEqual(device.keys[7], { type: 33, code1: 56, code2: 255, code3: 0 });
  });

  it("skips stray zeroed reports when reading the button map", async () => {
    const device = new FakeKsnakeDevice();
    device.badKeysOnce = true;
    const keys = await fastClient(device).getKeys();
    assert.deepEqual(keys, device.keys);
  });

  it("ignores a plausible stray until two reads agree", async () => {
    const device = new FakeKsnakeDevice();
    device.garbageKeysOnce = true;
    const keys = await fastClient(device).getKeys();
    assert.deepEqual(keys, device.keys);
  });

  it("publishes the generic button map on readStatus", async () => {
    const status = await fastClient(new FakeKsnakeDevice()).readStatus();
    assert.deepEqual(status.buttonMappings, {
      Left: "Left click",
      Right: "Right click",
      Middle: "Middle click",
      Backward: "Backward",
      // The fake ships a macro reference here: opaque slots surface as-is.
      Forward: "Macro 1",
      "Scroll up": "Scroll up",
      "Scroll down": "Scroll down",
    });
    assert.ok(status.buttonOptions?.includes("Backward"));
    assert.ok(status.buttonOptions?.includes("DPI loop"));
    assert.ok(status.buttonOptions?.includes("DPI +"));
    assert.ok(status.buttonOptions?.includes("Escape"));
  });

  it("identifies M2-NEX as Noir Gear, exposes verified lift-off, and hides its unreadable key map", async () => {
    const device = new FakeKsnakeDevice();
    device.vendorId = 0xa8a4;
    device.productName = "M2-NEX";
    // M2-NEX replies with lodValue 1 (Low); the adjacent tail bytes are the
    // 0xff sentinels. Keep the fixture aligned with the live receiver dump.
    device.lodValue = 1;
    device.keys = Array.from({ length: 8 }, () => ({ type: 0xff, code1: 0xff, code2: 0xff, code3: 0xff }));
    const status = await fastClient(device).readStatus();
    assert.equal(status.brand, "Noir Gear");
    assert.equal(status.name, "M2-NEX");
    assert.equal(status.connectionDetail, "Wired USB");
    assert.equal(status.liftOffDistance, "Low");
    assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
    assert.equal(status.buttonMappings, undefined);
    assert.equal(status.ui?.showAdvancedSection, false);
    assert.deepEqual(status.firmware, ["M2-NEX 2.1.7"]);

    const receiver = new FakeKsnakeDevice();
    receiver.productName = "M2-NEX";
    receiver.lodValue = 1;
    receiver.keys = Array.from({ length: 8 }, () => ({ type: 0xff, code1: 0xff, code2: 0xff, code3: 0xff }));
    const wirelessStatus = await fastClient(receiver).readStatus();
    assert.equal(wirelessStatus.brand, "Noir Gear");
    assert.equal(wirelessStatus.connectionDetail, "2.4 GHz receiver");
  });

  it("opens the shared Buttons tab when M2-NEX returns a readable key map", async () => {
    const device = new FakeKsnakeDevice();
    device.productName = "M2-NEX";
    device.keys = [
      { type: 32, code1: 1, code2: 0, code3: 0 },
      { type: 32, code1: 2, code2: 0, code3: 0 },
      { type: 32, code1: 4, code2: 0, code3: 0 },
      { type: 32, code1: 8, code2: 0, code3: 0 },
      { type: 32, code1: 16, code2: 0, code3: 0 },
      { type: 33, code1: 85, code2: 0, code3: 0 },
      { type: 33, code1: 56, code2: 1, code3: 0 },
      { type: 33, code1: 56, code2: 255, code3: 0 },
    ];
    const status = await fastClient(device).readStatus();
    assert.equal(status.ui?.showAdvancedSection, true);
    assert.equal(status.buttonMappings?.Forward, "Forward");
  });

  it("remaps one button by label through setButtonMapping", async () => {
    const device = new FakeKsnakeDevice();
    device.keys = [
      { type: 32, code1: 1, code2: 0, code3: 0 },
      { type: 32, code1: 2, code2: 0, code3: 0 },
      { type: 32, code1: 4, code2: 0, code3: 0 },
      { type: 32, code1: 8, code2: 0, code3: 0 },
      { type: 32, code1: 16, code2: 0, code3: 0 },
      { type: 33, code1: 85, code2: 0, code3: 0 },
      { type: 33, code1: 56, code2: 1, code3: 0 },
      { type: 33, code1: 56, code2: 255, code3: 0 },
    ];
    await fastClient(device).setButtonMapping("Forward", "Backward");
    assert.deepEqual(device.keys[4], { type: 32, code1: 8, code2: 0, code3: 0 });
    assert.ok(device.sent.includes(0x09));
  });

  it("locks Left and rejects unknown buttons and actions", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setButtonMapping("Left", "Backward"), /fixed/);
    await assert.rejects(() => fastClient(device).setButtonMapping("Side", "Backward"), /no "Side" button/);
    await assert.rejects(() => fastClient(device).setButtonMapping("Forward", "Turbo"), /Unknown button action/);
    assert.ok(!device.sent.includes(0x09));
  });

  it("reuses the last good config when a poll read fails", async () => {
    const device = new FakeKsnakeDevice();
    const client = fastClient(device);
    const first = await client.readStatus();
    assert.deepEqual(first.dpiStages?.slice(0, 3), [800, 1200, 1600]);
    device.dropReplies = 99;
    const second = await client.readStatus();
    assert.deepEqual(second.dpiStages?.slice(0, 3), [800, 1200, 1600]);
    assert.equal(second.dpi, first.dpi);
  });

  it("rejects out-of-range DPI without touching the mouse", async () => {
    const device = new FakeKsnakeDevice();
    await assert.rejects(() => fastClient(device).setDpi(100), /between 200 and 12000/);
    await assert.rejects(() => fastClient(device).setDpi(26000), /between 200 and 12000/);
    assert.deepEqual(device.sent, []);
  });
});
