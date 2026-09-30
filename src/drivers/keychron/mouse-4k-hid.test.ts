import assert from "node:assert/strict";
import { test } from "node:test";
import { Keychron4kHidClient } from "./mouse-4k-hid.ts";

/**
 * Answers Launcher's "4k" mouse protocol: 64-byte report 0 packets whose byte
 * 63 is 0xA1 minus the sum of the rest. As a receiver it expects 0x40 on byte
 * 0 for anything meant for the mouse and adds 0x40 to those replies.
 */
class Fake4kMouse {
  vendorId = 0x3434;
  opened = false;
  readonly sent: Uint8Array[] = [];
  readonly collections = [{ usagePage: 0xff0a, usage: 0x01, inputReports: [], outputReports: [], featureReports: [] }];
  private listener: ((event: unknown) => void) | null = null;
  /** Bytes 4-54 of the settings block, as the mouse stores it. */
  settings = new Uint8Array(64);
  power = { state: 0, percent: 87, profile: 1 };
  /** Bytes 6-7 of the unrouted handshake; Keychron's vendor ID here marks the 8K Nordic variant. */
  handshakeTail = [87, 1];
  constructor(readonly productId: number, private readonly receiver = false) {
    const s = this.settings;
    s[4] = 0x20 | 0x80; // motion sync on, wheel direction bit set
    s[5] = 3; // 1000 Hz
    s[6] = 0x07; // three stages
    s[7] = 1;
    [400, 800, 1600, 3200, 6400].forEach((dpi, stage) => {
      s.set([dpi & 0xff, dpi >> 8, dpi & 0xff, dpi >> 8], 8 + stage * 4);
    });
    s[43] = 1;
    s.set([0x58, 0x02, 0x58, 0x02], 50); // 600 s sleep
    s[54] = 4;
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
    reply[0] = packet[0] ?? 0;
    reply[2] = packet[2] ?? 0;
    reply[3] = packet[3] ?? 0;
    if (this.receiver && !routed) {
      // The receiver answers only its own handshake; everything else needs the route bit.
      if (command !== 0x01) return;
      reply.set([2, 100, ...this.handshakeTail], 4);
      return this.emit(reply);
    }
    switch (`${command}/${packet[3]}`) {
      case "0/0":
        reply.set([0x21, 0x06, 1, 0, 0x16, 1], 4); // model 0x0621, firmware 1.1.6
        break;
      case "1/1":
        reply.set([0, this.power.state, ...(this.receiver ? [this.power.percent, this.power.profile] : this.handshakeTail)], 4);
        break;
      case "2/1":
        this.power.profile = packet[4] ?? 0;
        break;
      case "4/1":
        reply.set(this.settings.slice(4, 55), 4);
        break;
      case "4/2":
        this.settings.set(packet.slice(4, 55), 4);
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

test("reads a wired M4 4K", async () => {
  const mouse = new Fake4kMouse(0xd040);
  const client = new Keychron4kHidClient(mouse as unknown as HIDDevice);
  const status = await client.readStatus();

  assert.equal(status.name, "Keychron M4 4K");
  assert.equal(status.connectionType, "Wired");
  assert.deepEqual(status.dpiStages, [400, 800, 1600]);
  assert.equal(status.dpi, 800);
  assert.equal(status.pollingRateHz, 1000);
  assert.equal(status.liftOffDistance, "Low");
  assert.equal(status.motionSync, true);
  assert.equal(status.angleSnapping, false);
  assert.equal(status.debounceMs, 4);
  assert.equal(status.activeProfile, 2);
  assert.deepEqual(status.firmware, ["v1.1.6"]);
  assert.ok(mouse.sent.every((packet) => ((packet[0] ?? 0) & 0x40) === 0), "wired packets must not be routed");
});

test("writes the whole block like Launcher, saves, and keeps sleep", async () => {
  const mouse = new Fake4kMouse(0xd040);
  const client = new Keychron4kHidClient(mouse as unknown as HIDDevice);

  assert.equal(await client.setPollingRate(4000), 4000);
  assert.equal(await client.setDpiStageValue(2, 26_000), 26_000);
  assert.equal(await client.setAngleSnapping(true), true);
  assert.equal(await client.setLiftOffDistance("High"), "High");

  const write = mouse.sent.filter((packet) => packet[0] === 0x04 && packet[3] === 0x02).at(-1)!;
  assert.equal(write[2], 0xb5);
  assert.equal(write[4], 0x01 | 0x20 | 0x80, "flags keep motion sync and wheel direction");
  assert.equal(write[5], 5, "4000 Hz is index 4, sent as 5");
  assert.equal(write[6], 0x07);
  assert.deepEqual([...write.slice(16, 20)], [0x90, 0x65, 0x90, 0x65], "stage 3 X and Y are both 26000");
  assert.equal(write[43], 2);
  assert.deepEqual([...write.slice(50, 55)], [0x58, 0x02, 0x58, 0x02, 4]);
  const saves = mouse.sent.filter((packet) => packet[0] === 0x0a).length;
  assert.equal(saves, 4, "every write is followed by a save");
  await assert.rejects(client.setPollingRate(8000), /does not support 8000 Hz/);
});

test("routes through the receiver and names the paired mouse", async () => {
  const receiver = new Fake4kMouse(0xd0ff, true);
  const client = new Keychron4kHidClient(receiver as unknown as HIDDevice);
  const status = await client.readStatus();

  assert.equal(status.name, "Keychron M4 4K");
  assert.equal(status.connectionType, "Wireless");
  assert.equal(status.batteryPercent, 87);
  assert.equal(status.activeProfile, 2);
  assert.equal(await client.setProfile(4), 4);
  const [handshake, ...rest] = receiver.sent;
  assert.equal(handshake?.[0], 0x01, "handshake goes to the receiver itself");
  assert.ok(rest.every((packet) => ((packet[0] ?? 0) & 0x40) !== 0), "everything else is routed");
});

test("refuses the 8K Nordic variant before writing anything", async () => {
  const mouse = new Fake4kMouse(0xd040);
  mouse.handshakeTail = [0x34, 0x34];
  const client = new Keychron4kHidClient(mouse as unknown as HIDDevice);
  await assert.rejects(client.setDpi(800), /8K Nordic/);
  await assert.rejects(client.readStatus(), /8K Nordic/);
  assert.ok(mouse.sent.every((packet) => packet[0] === 0x01), "only handshakes went out");
});
