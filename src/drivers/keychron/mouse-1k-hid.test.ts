import assert from "node:assert/strict";
import { test } from "node:test";
import type { MouseLighting } from "../mouse-types.ts";
import { Keychron1kHidClient } from "./mouse-1k-hid.ts";

/**
 * Speaks Launcher's "1k" protocol: every command is a feature report (20
 * bytes on 0x51, 64 on 0x52 for buttons) and its answer is fetched with a
 * feature read of the same report, which starts with the report ID.
 */
class FakeKeychron1kMouse {
  vendorId = 0x3434;
  productId = 0xd033;
  opened = false;
  readonly sent: Array<{ reportId: number; packet: Uint8Array }> = [];
  private answers = new Map<number, Uint8Array>();
  workMode = 0;
  reportedProductId = 0xd033;
  paired: Array<[number, boolean]> = [];
  failStatus = false;
  levels = [0x20, 0x11, 0x00];
  dpiStages = [400, 800, 1600, 3200, 5000];
  stageCount = 4;
  lod = 2;
  ripple = true;
  angleSnap = false;
  motion = false;
  scrollReversed = false;
  debounce = 4;
  battery = 80;
  power = 1;
  buttons = new Map<number, number[]>();
  light = { mode: 3, brightness: 191, speed: 51, rgb: [255, 128, 0] };
  readonly collections = [{
    usagePage: 0x8c,
    usage: 0x01,
    featureReports: [{ reportId: 0x51 }, { reportId: 0x52 }],
    inputReports: [],
    outputReports: [],
  }];

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    const packet = new Uint8Array(data as ArrayBuffer);
    this.sent.push({ reportId, packet });
    this.answers.set(reportId, reportId === 0x52 ? this.button(packet) : this.settings(packet));
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    const answer = this.answers.get(reportId) ?? new Uint8Array(reportId === 0x52 ? 64 : 20);
    const bytes = new Uint8Array(answer.length + 1);
    bytes[0] = reportId;
    bytes.set(answer, 1);
    return new DataView(bytes.buffer);
  }

  private settings(packet: Uint8Array): Uint8Array {
    const answer = new Uint8Array(20);
    answer[0] = packet[0] ?? 0;
    switch (packet[0]) {
      case 0x06:
        answer.set([0x06, 2, 0, 0x34, 0x34, this.reportedProductId & 0xff, this.reportedProductId >> 8, 0x12, 0x01, this.workMode, this.battery, this.power]);
        break;
      case 0x04:
        answer.set([0x04, 5, ...Array.from("1.1.2", (c) => c.charCodeAt(0))]);
        break;
      case 0x03:
        answer[1] = this.paired.length;
        this.paired.forEach(([pid, connected], index) => answer.set([0x34, 0x34, pid & 0xff, pid >> 8, connected ? 1 : 0], 2 + index * 5));
        break;
      case 0x07:
        if (this.failStatus) return new Uint8Array(20);
        answer.set(this.levels, 2);
        this.dpiStages.forEach((dpi, index) => answer.set([dpi & 0xff, dpi >> 8], 5 + index * 2));
        answer[15] = this.lod | (this.ripple ? 0x04 : 0) | (this.angleSnap ? 0x08 : 0) | (this.motion ? 0x10 : 0) | (this.scrollReversed ? 0x40 : 0);
        answer[16] = this.stageCount;
        answer[17] = this.debounce;
        break;
      case 0x40:
        this.levels = this.levels.map((level, index) => (level & 0xf0) | (packet[1 + index] ?? 0));
        this.dpiStages = this.dpiStages.map((_, index) => (packet[4 + index * 2] ?? 0) | ((packet[5 + index * 2] ?? 0) << 8));
        this.stageCount = packet[14] ?? 0;
        break;
      case 0x41:
        this.levels = this.levels.map((level) => (level & 0x0f) | ((packet[1] ?? 0) << 4));
        break;
      case 0x42:
        this.lod = packet[1] || this.lod;
        this.ripple = packet[2] === 1;
        this.angleSnap = packet[3] === 1;
        this.motion = packet[4] === 1;
        this.scrollReversed = packet[6] === 2;
        break;
      case 0x43:
        this.debounce = packet[1] ?? 0;
        break;
      case 0x12:
        answer[3] = this.light.mode;
        break;
      case 0x18:
        answer.set([0x18, packet[1] ?? 0, ...this.light.rgb, this.light.brightness, this.light.speed]);
        break;
      case 0x22:
        this.light.mode = packet[2] ?? 0;
        break;
      case 0x23:
        this.light.brightness = packet[3] ?? 0;
        break;
      case 0x27:
        this.light.speed = packet[3] ?? 0;
        break;
      case 0x28:
        this.light.rgb = Array.from(packet.slice(3, 6));
        break;
      default:
    }
    return answer;
  }

  private button(packet: Uint8Array): Uint8Array {
    const answer = new Uint8Array(64);
    const index = packet[1] ?? 0;
    if (packet[0] === 0x62) answer.set([0x62, index, 0, ...(this.buttons.get(index) ?? [0])]);
    if (packet[0] === 0x52) {
      const record = Array.from(packet.slice(3, 7));
      if (record[0] === 0) this.buttons.delete(index);
      else this.buttons.set(index, record);
      answer.set([0xe4, 0, 0x52]);
    }
    return answer;
  }
}

const client = (fake: FakeKeychron1kMouse): Keychron1kHidClient => new Keychron1kHidClient(fake as unknown as HIDDevice);
const lastSent = (fake: FakeKeychron1kMouse, command: number, reportId = 0x51) =>
  [...fake.sent].reverse().find((entry) => entry.reportId === reportId && entry.packet[0] === command)?.packet;

test("claims usage page 0x8c only when the device has no 0xffc1 interface", () => {
  const fake = new FakeKeychron1kMouse();
  assert.equal(Keychron1kHidClient.isSupported(fake as unknown as HIDDevice), true);
  const both = { ...fake, collections: [...fake.collections, { usagePage: 0xffc1, usage: 1, featureReports: [], inputReports: [], outputReports: [] }] };
  assert.equal(Keychron1kHidClient.isSupported(both as unknown as HIDDevice), false);
  const noReport = { ...fake, collections: [{ ...fake.collections[0]!, featureReports: [{ reportId: 0x10 }] }] };
  assert.equal(Keychron1kHidClient.isSupported(noReport as unknown as HIDDevice), false);
  assert.equal(Keychron1kHidClient.isSupported({ ...fake, vendorId: 0x1d57 } as unknown as HIDDevice), false);
});

test("reads identity, the 0x07 status, buttons and lighting", async () => {
  const fake = new FakeKeychron1kMouse();
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron M3");
  assert.equal(status.ui?.family, "keychron-1k");
  assert.equal(status.ui?.hideSleepCard, true);
  assert.deepEqual(status.dpiStages, [400, 800, 1600, 3200]);
  assert.equal(status.activeDpiStage, 0);
  assert.equal(status.dpi, 400);
  // USB slot: polling gear 2 of the fixed 125/500/1000 table.
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 500, 1000]);
  assert.equal(status.liftOffDistance, "High");
  assert.deepEqual(status.supportedLiftOffDistances, ["Low", "High"]);
  assert.equal(status.rippleControl, true);
  assert.equal(status.motionSync, false);
  assert.equal(status.debounceMs, 4);
  assert.equal(status.batteryPercent, 80);
  assert.equal(status.batteryState, "Charging");
  assert.equal(status.activeProfile, null);
  assert.equal(status.sleepTimeout, undefined);
  assert.deepEqual(status.firmware, ["v1.1.2"]);
  assert.equal(status.buttonMappings?.Lighting, "Default");
  assert.equal(status.buttonMappings?.Forward, "Forward");
  assert.equal(status.lighting?.mode, "Spectrum");
  assert.equal(status.lighting?.color, "#ff8000");
  assert.equal(status.lighting?.brightness, 75);
  assert.equal(status.lighting?.speed, 1);
  assert.deepEqual(Array.from(lastSent(fake, 0x62, 0x52)!.slice(0, 2)), [0x62, 14]);
  assert.equal(lastSent(fake, 0x62, 0x52)!.length, 64);
});

test("DPI writes reuse the 0x40 layout on feature report 0x51", async () => {
  const fake = new FakeKeychron1kMouse();
  const m3 = client(fake);
  assert.equal(await m3.setDpiStageValue(1, 1200), 1200);
  assert.deepEqual(Array.from(lastSent(fake, 0x40)!.slice(0, 15)), [0x40, 0, 0, 0, 0x90, 0x01, 0xb0, 0x04, 0x40, 0x06, 0x80, 0x0c, 0x88, 0x13, 4]);
  assert.equal(lastSent(fake, 0x40)!.length, 20);
  assert.equal(await m3.setActiveDpiStage(2), 2);
  assert.equal(await m3.setDpiStageCount(2), 2);
  const status = await m3.readStatus();
  assert.deepEqual(status.dpiStages, [400, 1200]);
  assert.equal(status.activeDpiStage, 1);
  await assert.rejects(m3.setDpiStageValue(0, 26_050), /between 100 and 26000/);
});

test("polling goes out as a gear with Launcher's fixed table", async () => {
  const fake = new FakeKeychron1kMouse();
  const m3 = client(fake);
  assert.equal(await m3.setPollingRate(500), 500);
  assert.deepEqual(Array.from(lastSent(fake, 0x41)!.slice(0, 7)), [0x41, 1, 1, 0, 1, 2, 0]);
  await assert.rejects(m3.setPollingRate(2000), /does not support 2000 Hz/);
});

test("sensor writes leave out the 8k-only bytes", async () => {
  const fake = new FakeKeychron1kMouse();
  const m3 = client(fake);
  assert.equal(await m3.setMotionSync(true), true);
  assert.equal(await m3.setLiftOffDistance("Low"), "Low");
  const packet = lastSent(fake, 0x42)!;
  assert.deepEqual(Array.from(packet.slice(0, 12)), [0x42, 1, 1, 2, 1, 0, 1, 0, 0, 0, 0, 0]);
  assert.equal(fake.lod, 1);
  assert.equal(await m3.setDebounceTime(12), 12);
  assert.deepEqual(Array.from(lastSent(fake, 0x43)!.slice(0, 2)), [0x43, 12]);
});

test("button records go on report 0x52 with the 1k Back and Forward codes", async () => {
  const fake = new FakeKeychron1kMouse();
  const m3 = client(fake);
  await m3.setButtonMapping("Forward", "Back");
  // The "1k" enum swaps them: Back is 0x100000.
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0x52)!.slice(0, 7)), [0x52, 3, 0, 1, 0x10, 0x00, 0x00]);
  assert.equal(lastSent(fake, 0x52, 0x52)!.length, 64);
  assert.equal((await m3.readStatus()).buttonMappings?.Forward, "Back");
  await m3.setButtonMapping("Lighting", "DPI +");
  assert.deepEqual(Array.from(lastSent(fake, 0x52, 0x52)!.slice(0, 5)), [0x52, 7, 0, 5, 2]);
  await assert.rejects(m3.setButtonMapping("Left", "Scroll Up"), /at least one button as Left Click/);
});

test("lighting is written the way Launcher's 1k panel does, one field at a time", async () => {
  const fake = new FakeKeychron1kMouse();
  const m3 = client(fake);
  const lighting = (await m3.readStatus()).lighting!;
  const next: MouseLighting = { ...lighting, mode: "Static", color: "#ff0000", brightness: 100, speed: 5 };
  const confirmed = await m3.setLighting(next);
  assert.deepEqual(Array.from(lastSent(fake, 0x22)!.slice(0, 3)), [0x22, 1, 1]);
  assert.deepEqual(Array.from(lastSent(fake, 0x23)!.slice(0, 4)), [0x23, 1, 1, 255]);
  assert.deepEqual(Array.from(lastSent(fake, 0x27)!.slice(0, 4)), [0x27, 1, 1, 255]);
  assert.deepEqual(Array.from(lastSent(fake, 0x28)!.slice(0, 6)), [0x28, 1, 1, 255, 0, 0]);
  assert.equal(confirmed.mode, "Static");
  assert.equal(confirmed.color, "#ff0000");
  const writes = fake.sent.length;
  await m3.setLighting({ ...confirmed, mode: "Off" });
  assert.equal(fake.light.mode, 0);
  assert.equal(fake.sent.slice(writes).filter(({ packet }) => [0x23, 0x27, 0x28].includes(packet[0] ?? 0)).length, 0);
});

test("budget models hide the sensor toggles and lift-off", async () => {
  const fake = new FakeKeychron1kMouse();
  fake.productId = 0xd058;
  fake.reportedProductId = 0xd058;
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron BM22");
  assert.equal(status.ui?.hideProcessingCard, true);
  assert.equal(status.rippleControl, undefined);
  assert.equal(status.liftOffDistance, null);
  assert.equal(status.ui?.dpiStageEditor?.maxDpi, 2400);
  assert.equal(status.buttonMappings?.DPI, "DPI Loop");
  assert.equal(status.lighting, undefined);
});

test("behind a receiver the 0x03 list names the connected mouse", async () => {
  const fake = new FakeKeychron1kMouse();
  fake.productId = 0xd024;
  fake.reportedProductId = 0xd024;
  fake.workMode = 1;
  fake.paired = [[0xd063, true]];
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron BM26");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.connectionDetail, "2.4 GHz (CANDYSIGN Link)");
});

test("a mouse that stops answering falls back to its name alone", async () => {
  const fake = new FakeKeychron1kMouse();
  fake.failStatus = true;
  const status = await client(fake).readStatus();
  assert.equal(status.name, "Keychron M3");
  assert.equal(status.ui?.settingsReady, false);
});
