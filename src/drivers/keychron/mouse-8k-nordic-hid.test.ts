import assert from "node:assert/strict";
import { test } from "node:test";
import { Keychron4kHidClient } from "./mouse-4k-hid.ts";
import {
  Keychron8kNordicHidClient,
  keychronNordicButtonLabel,
  keychronNordicDecodeSensor,
  keychronNordicDecodeSystem,
  keychronNordicEncodeSensor,
  keychronNordicEncodeSystem,
} from "./mouse-8k-nordic-hid.ts";

/**
 * Answers Launcher's "8k_nordic" protocol with the byte layout its command
 * classes read and write (main.be11320b2a72b61b.js, module 20706); there is
 * no G3 Air capture yet. As a receiver it answers only its own status
 * unrouted and needs 0x40 on byte 0 for everything meant for the mouse.
 */
class FakeNordicMouse {
  vendorId = 0x3434;
  opened = false;
  readonly sent: Uint8Array[] = [];
  readonly collections = [{ usagePage: 0xff0a, usage: 0x01, inputReports: [], outputReports: [], featureReports: [] }];
  private listener: ((event: unknown) => void) | null = null;
  /** Each block as the mouse stores it, at packet offsets. */
  sensor = new Uint8Array(64);
  system = new Uint8Array(64);
  buttons = new Uint8Array(64);
  power = { state: 3, percent: 76, profile: 1 };
  /** Bytes 6-9 of the receiver's own status: Keychron's vendor ID, then the G3 Air's product ID. */
  paired = [0x34, 0x34, 0x77, 0xd0];
  firmware = [1, 5, 2];
  awake = true;
  /** Routed packets to ignore, as a lossy 2.4 GHz link would. */
  drop = 0;

  constructor(readonly productId: number, private readonly receiver = false) {
    const s = this.sensor;
    s.set([0, 1, 1, 0, 1, 1, 0], 4); // ripple, motion sync, 20K FPS and lift-down on
    s[11] = 1; // 1 mm
    s[12] = 0xfb; // -5°
    s[13] = 1;
    s[14] = 0x07; // three stages
    [[400, 400], [800, 800], [1600, 1600], [3200, 3000], [6400, 6400]].forEach(([x, y], stage) => {
      s.set([x! & 0xff, x! >> 8, y! & 0xff, y! >> 8], 15 + stage * 4);
    });
    s.set([0xff, 0, 0, 0, 0xff, 0], 43); // red, green
    const y = this.system;
    y.set([0x58, 0x02, 0x58, 0x02], 4); // 600 s, twice
    y[8] = 2; // USB gear 3
    y[9] = 8;
    y.set([1, 1, 1, 0, 0, 0, 0, 0, 0, 0], 10); // quick response, button and motion wake
    y[20] = 0x3f;
    y.set([0, 2, 3, 4, 5, 6], 21); // 125, 500, 1000, 2000, 4000, 8000
    y[28] = 3; // 2.4 GHz gear 4
    y[29] = 0x0f;
    y.set([3, 4, 5, 6, 0, 0], 30); // 1000, 2000, 4000, 8000
    [[1, 0, 0xf0, 0], [1, 0, 0xf1, 0], [1, 0, 0xf2, 0], [1, 0, 0xf4, 0], [1, 0, 0xf3, 0]]
      .forEach((code, index) => this.buttons.set(code, 4 + index * 4));
  }

  async open(): Promise<void> { this.opened = true; }
  async close(): Promise<void> { this.opened = false; }
  addEventListener(_type: string, listener: (event: unknown) => void): void { this.listener = listener; }
  removeEventListener(): void { this.listener = null; }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const packet = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer).slice();
    assert.equal(reportId, 0);
    assert.equal(packet.length, 64);
    const sum = packet.slice(0, 63).reduce((total, byte) => total + byte, 0);
    assert.equal(packet[63], (0xa1 - (sum & 0xff)) & 0xff, "bad checksum");
    this.sent.push(packet);
    const routed = ((packet[0] ?? 0) & 0x40) !== 0;
    const command = (packet[0] ?? 0) & 0xbf;
    const reply = new Uint8Array(64);
    reply.set(packet.slice(0, 4));
    if (this.receiver && !routed) {
      if (command !== 0x01) return;
      reply.set([1, 5, ...this.paired], 4);
      return this.emit(reply);
    }
    assert.equal(routed, this.receiver, "only a receiver takes routed packets");
    if (!this.awake) return;
    if (this.drop > 0) {
      this.drop -= 1;
      return;
    }
    // Writes land only as far as byte 2's payload length reaches.
    const payload = packet.slice(4, Math.min(4 + ((packet[2] ?? 0) & 0x7f), 63));
    switch (`${command}/${packet[3]}`) {
      case "0/0":
        reply[8] = (this.firmware[1]! << 4) | this.firmware[2]!;
        reply[9] = this.firmware[0]!;
        break;
      case "1/1":
        reply.set([1, 5, 0x34, 0x34, 0x77, 0xd0, this.power.state, this.power.percent, this.power.profile], 4);
        break;
      case "2/2":
        this.power.profile = packet[4] ?? 0;
        break;
      case "3/1":
        reply.set(this.buttons.slice(4, 63), 4);
        break;
      case "3/4":
        this.buttons.set(payload.slice(1, 5), 4 + (packet[4] ?? 0) * 4);
        break;
      case "4/1":
        reply.set(this.sensor.slice(4, 63), 4);
        break;
      case "4/2":
        this.sensor.set(payload, 4);
        break;
      case "4/3":
        reply.set(this.system.slice(4, 63), 4);
        break;
      case "4/4":
        this.system.set(payload, 4);
        break;
      case "10/1":
        break;
      default:
        return;
    }
    this.emit(reply);
  }

  private emit(bytes: Uint8Array): void {
    queueMicrotask(() => this.listener?.({ data: new DataView(bytes.buffer), reportId: 0 }));
  }
}

function connect(mouse: FakeNordicMouse): Keychron8kNordicHidClient {
  return new Keychron8kNordicHidClient(mouse as unknown as HIDDevice);
}

function lastWrite(mouse: FakeNordicMouse, command: number, sub: number): Uint8Array {
  const packet = mouse.sent.filter((sent) => ((sent[0] ?? 0) & 0xbf) === command && sent[3] === sub).at(-1);
  assert.ok(packet, `no ${command}/${sub} packet was sent`);
  return packet;
}

test("claims the G3 Air and its receivers, and the 4K driver lets them go", () => {
  for (const productId of [0xd077, 0xd05b, 0xd078]) {
    const device = new FakeNordicMouse(productId) as unknown as HIDDevice;
    assert.equal(Keychron8kNordicHidClient.isSupported(device), true);
    assert.equal(Keychron4kHidClient.isSupported(device), false);
  }
  const m4 = new FakeNordicMouse(0xd040) as unknown as HIDDevice;
  assert.equal(Keychron8kNordicHidClient.isSupported(m4), false);
  assert.equal(Keychron4kHidClient.isSupported(m4), true);
});

test("reads a wired G3 Air", async () => {
  const mouse = new FakeNordicMouse(0xd077);
  const status = await connect(mouse).readStatus();

  assert.equal(status.name, "Keychron G3 Air");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(status.angleTuning, -5);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.rippleControl, true);
  assert.equal(status.motionSync, true);
  assert.equal(status.performanceMode, true);
  assert.equal(status.debounceMs, 8);
  assert.equal(status.sleepTimeout, 600);
  assert.equal(status.activeProfile, 2);
  assert.equal(status.batteryPercent, 76);
  assert.equal(status.batteryState, "Discharging");
  assert.deepEqual(status.buttonMappings, {
    Left: "Left Click", Right: "Right Click", Middle: "Middle Click", Back: "Back", Forward: "Forward",
  });
  assert.deepEqual(status.firmware, ["v1.5.2"]);
  assert.ok(mouse.sent.every((packet) => ((packet[0] ?? 0) & 0x40) === 0), "wired packets must not be routed");
});

test("writes the sensor block the way Launcher builds it, then saves", async () => {
  const mouse = new FakeNordicMouse(0xd077);
  const client = connect(mouse);

  assert.equal(await client.setDpiStageValue(2, 30_000), 30_000);
  const write = lastWrite(mouse, 0x04, 0x02);
  assert.deepEqual([...write.slice(0, 15)], [0x04, 0, 0xbc, 0x02, 0, 1, 1, 0, 1, 1, 0, 1, 0xfb, 1, 0x07]);
  assert.deepEqual([...write.slice(23, 27)], [0x30, 0x75, 0x30, 0x75], "stage 3 is 30000 on both axes");
  assert.deepEqual([...write.slice(27, 31)], [0x80, 0x0c, 0xb8, 0x0b], "stage 4 keeps its own Y");
  assert.deepEqual([...write.slice(35, 43)], [0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual([...write.slice(43, 49)], [0xff, 0, 0, 0, 0xff, 0], "stage colours ride along");

  assert.equal(await client.setLiftOffDistance("Low"), "Low");
  assert.equal(await client.setAngleTuning(-30), -30);
  assert.equal(await client.setPerformanceMode(false), false);
  assert.equal(await client.setDpiStageCount(5), 5);
  assert.equal(await client.setActiveDpiStage(4), 4);
  assert.deepEqual([...mouse.sensor.slice(8, 15)], [0, 1, 0, 0, 0xe2, 4, 0x1f]);
  assert.equal(mouse.sent.filter((packet) => packet[0] === 0x0a).length, 6, "every write is followed by a save");
  await assert.rejects(client.setDpi(30_050), /multiple of 50/);
  await assert.rejects(client.setAngleTuning(91), /between -90 and 90/);
});

test("picks the gear that holds a rate, or rewrites the active gear", async () => {
  const mouse = new FakeNordicMouse(0xd077);
  const client = connect(mouse);

  assert.equal(await client.setPollingRate(8000), 8000);
  const write = lastWrite(mouse, 0x04, 0x04);
  assert.deepEqual([...write.slice(0, 4)], [0x04, 0, 0x98, 0x04], "no 2.4 GHz set before firmware 1.6.0");
  assert.deepEqual([...write.slice(4, 27)], [
    0x58, 0x02, 0x58, 0x02, 5, 8, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0,
    0x3f, 0, 2, 3, 4, 5, 6,
  ]);
  assert.deepEqual([...write.slice(27, 36)], [0, 0, 0, 0, 0, 0, 0, 0, 0]);

  mouse.system[20] = 0x07; // the button cycles 125, 500 and 1000 Hz only
  mouse.system[8] = 2;
  assert.equal(await client.setPollingRate(4000), 4000);
  assert.deepEqual([...mouse.system.slice(20, 27)], [0x07, 0, 2, 5, 4, 5, 6], "4000 Hz replaces the active gear");
  assert.equal(mouse.system[8], 2);
  await assert.rejects(client.setPollingRate(250), /does not support 250 Hz/);
});

test("debounce and sleep go through the system block", async () => {
  const mouse = new FakeNordicMouse(0xd077);
  const client = connect(mouse);

  assert.equal(await client.setDebounceTime(4), 4);
  assert.equal(await client.setSleepTimeout(1800), 1800);
  assert.deepEqual([...mouse.system.slice(4, 10)], [0x08, 0x07, 0x08, 0x07, 2, 4]);
  assert.deepEqual([...mouse.system.slice(10, 13)], [1, 1, 1], "quick response and wake sources are kept");
  await assert.rejects(client.setSleepTimeout(90), /whole minutes/);
  await assert.rejects(client.setDebounceTime(21), /between 0 and 20/);
});

test("routes through the receiver and uses its own gears on firmware 1.6.0", async () => {
  const receiver = new FakeNordicMouse(0xd05b, true);
  receiver.firmware = [1, 6, 0];
  const client = connect(receiver);
  const status = await client.readStatus();

  assert.equal(status.name, "Keychron G3 Air");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.pollingRateHz, 8000);
  assert.equal(await client.setPollingRate(2000), 2000);
  const write = lastWrite(receiver, 0x04, 0x04);
  assert.deepEqual([...write.slice(0, 4)], [0x44, 0, 0xa0, 0x04]);
  assert.equal(write[8], 2, "the USB gear stays");
  assert.deepEqual([...write.slice(28, 36)], [1, 0x0f, 3, 4, 5, 6, 0, 0]);
  assert.equal(await client.setProfile(5), 5);

  const [handshake, ...rest] = receiver.sent;
  assert.equal(handshake?.[0], 0x01, "the handshake goes to the receiver itself");
  assert.ok(rest.every((packet) => ((packet[0] ?? 0) & 0x40) !== 0), "everything else is routed");
});

test("resends an unanswered command through the receiver", async () => {
  const receiver = new FakeNordicMouse(0xd078, true);
  receiver.drop = 1;
  const status = await connect(receiver).readStatus();

  assert.equal(status.ui?.settingsReady, undefined);
  assert.equal(receiver.sent.filter((packet) => packet[0] === 0x40).length, 2, "the version query went out twice");
});

test("remaps buttons and keeps a Left Click", async () => {
  const mouse = new FakeNordicMouse(0xd077);
  const client = connect(mouse);

  await client.setButtonMapping("Forward", "DPI Loop");
  assert.deepEqual([...lastWrite(mouse, 0x03, 0x04).slice(0, 9)], [0x03, 0, 0x85, 0x04, 3, 0x07, 0, 0x03, 0]);
  assert.equal((await client.readStatus()).buttonMappings?.Forward, "DPI Loop");
  await assert.rejects(client.setButtonMapping("Left", "Right Click"), /Left Click/);
  await assert.rejects(client.setButtonMapping("Wheel", "Back"), /no "Wheel" button/);
});

test("refuses a receiver on another protocol before writing anything", async () => {
  const receiver = new FakeNordicMouse(0xd05b, true);
  receiver.paired = [87, 1, 0, 0]; // a 4K receiver keeps battery and profile here
  const client = connect(receiver);

  await assert.rejects(client.readStatus(), /8K Nordic/);
  await assert.rejects(client.setDpi(800), /8K Nordic/);
  assert.ok(receiver.sent.every((packet) => packet[0] === 0x01), "only handshakes went out");
});

test("reports an unreachable mouse without its settings", async () => {
  const mouse = new FakeNordicMouse(0xd077);
  mouse.awake = false;
  const status = await connect(mouse).readStatus();

  assert.equal(status.name, "Keychron G3 Air");
  assert.equal(status.ui?.settingsReady, false);
  assert.deepEqual(status.firmware, []);
});

test("codec round trips keep what Launcher does not edit", () => {
  const mouse = new FakeNordicMouse(0xd077);
  const sensor = keychronNordicDecodeSensor(mouse.sensor);
  assert.deepEqual(sensor.reserved, [0, 1, 0]);
  assert.deepEqual([...keychronNordicEncodeSensor(sensor).slice(4, 58)], [...mouse.sensor.slice(4, 58)]);

  mouse.system[22] = 1; // the unused raw value, which Launcher reads as 125 Hz
  const system = keychronNordicDecodeSystem(mouse.system);
  assert.deepEqual(system.gears[0].rates, [0, 0, 2, 3, 4, 5]);
  assert.deepEqual(system.gears[1], { level: 3, count: 4, rates: [2, 3, 4, 5, 0, 0] });
  const separate = keychronNordicEncodeSystem(system, true);
  assert.deepEqual([...separate.slice(28, 36)], [3, 0x0f, 3, 4, 5, 6, 0, 0]);
  assert.equal(separate[22], 0, "raw 1 goes back as 0, as Launcher writes it");

  assert.equal(keychronNordicButtonLabel([0x09, 0, 2, 0]), "Macro");
  assert.equal(keychronNordicButtonLabel([0x00, 0x01, 0x06, 0x00]), "Custom");
  assert.equal(keychronNordicButtonLabel([0, 0, 0, 0]), "Disabled");
});
