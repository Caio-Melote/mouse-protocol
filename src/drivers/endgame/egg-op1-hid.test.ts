import assert from "node:assert/strict";
import test from "node:test";

import { EggOp1HidClient } from "./egg-op1-hid.ts";

if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  Object.defineProperty(globalThis, "window", { value: globalThis, configurable: true });
}

// Config blob from a cabled OP1w 4K v2 (firmware V1.07) diagnostics report:
// 1000 Hz, slamclick + multiclick flags, LOD 1.7 mm, one 1600 CPI stage.
const REPORTED_BLOB = [
  0x00, 0x00, 0x00, 0x03, 0x01, 0x08, 0x21, 0x00, 0x01, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x01, 0xff,
  0xff, 0x00, 0x01, 0x01, 0x00, 0x00, 0xff, 0x01, 0x02, 0xff, 0x00, 0x00, 0x01, 0x03, 0x00, 0xff,
  0x00, 0x01, 0x04, 0x00, 0x40, 0x06, 0x40, 0x06, 0x00, 0x20, 0x03, 0x20, 0x03, 0x00, 0x40, 0x06,
  0x40, 0x06, 0x00, 0x80, 0x0c, 0x80, 0x0c, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x02,
  0x00, 0x00, 0x00, 0x00, 0xf0, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x08, 0x00, 0x10, 0x00, 0x00,
  0x00, 0x00, 0x08, 0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x08, 0x09, 0xf1, 0x00, 0x00, 0x00, 0x00,
  0x08, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x08, 0x01, 0xff, 0x00, 0x00, 0x00, 0x00, 0x08,
];

const hex = (bytes: ArrayLike<number>): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(" ");

/**
 * A 4K v2 that behaves like the real one: rejects the 8K whole-blob store with
 * 0x07 and applies block writes using the layout in johanneszab/endgame-op1w
 * re/PROTOCOL.md section 4, written out independently of eggBlockWrites.
 */
function fake4kV2({ productId = 0x1984, pairedPid = productId as number | null } = {}) {
  const state = { pairedPid };
  const blob = new Uint8Array(1024);
  blob.set(REPORTED_BLOB);
  const writes: string[] = [];
  let reply = new Uint8Array(63);
  let stores = 0;
  const answer = (status: number, extra: number[] = []): void => {
    reply = new Uint8Array(63);
    reply.set([status, ...extra]);
  };
  const device = {
    vendorId: 0x3367,
    productId,
    productName: "OP1w 4k v2 Wireless Gaming Mouse",
    opened: true,
    collections: [{
      usagePage: 0xff01,
      usage: 2,
      children: [],
      inputReports: [],
      outputReports: [],
      featureReports: [
        { reportId: 0xa0, items: [{ reportSize: 8, reportCount: 1040 }] },
        { reportId: 0xa1, items: [{ reportSize: 8, reportCount: 63 }] },
      ],
    }],
    async open() {},
    async close() {},
    addEventListener() {},
    removeEventListener() {},
    async sendFeatureReport(reportId: number, data: BufferSource) {
      const bytes = new Uint8Array(data as ArrayBuffer);
      if (reportId === 0xa0) {
        stores += 1;
        return answer(0x07);
      }
      const [command, , , , , chunk] = bytes;
      const payload = bytes.subarray(15);
      if (command === 0x12) return answer(0x01);
      if (command === 0x02) return answer(0x01, [...new Array(15).fill(0), 0x07, 0x01]);
      if (command === 0x0e) {
        // Mouse asleep behind the dongle: status 0x08, no identity.
        if (state.pairedPid === null) return answer(0x08);
        return answer(0x01, [...new Array(14).fill(0), 0x67, 0x33, state.pairedPid & 0xff, state.pairedPid >> 8]);
      }
      writes.push(`${hex(bytes.subarray(0, 6))} | ${hex(payload.subarray(0, command === 0x15 ? 11 : 28))}`);
      if (command === 0x14) {
        [0x07, 0x08, 0x09, 0x0a, 0x0b, 0x01, 0x0e, 0x0d].forEach((offset, index) => { blob[offset] = payload[index]; });
        blob.set(payload.subarray(8, 28), 0x23);
      } else if (command === 0x15) {
        [0x0c, 0x05, 0x06, 0x04, 0x3d, 0x44, 0x4b, 0x52, 0x59, 0x03, 0x6f]
          .forEach((offset, index) => { blob[offset] = payload[index]; });
      } else if (command === 0x16) {
        blob.set(payload.subarray(0, 28), 0x37 + (chunk - 1) * 28);
      }
      answer(0x01);
    },
    async receiveFeatureReport(reportId: number) {
      if (reportId === 0xa1) return new DataView(reply.slice().buffer);
      const config = new Uint8Array(1040);
      config[0] = 0x01;
      config.set(blob, 15);
      return new DataView(config.buffer);
    },
  };
  return {
    device: device as unknown as HIDDevice,
    blob,
    state,
    writes,
    stores: () => stores,
  };
}

test("the OP1w 4K v2 writes settings through the vendor's block commands, never the whole-blob store", async () => {
  const mouse = fake4kV2();
  const client = new EggOp1HidClient(mouse.device);

  // Byte for byte what the vendor tool sends for 1000 -> 2000 Hz (capture 07), on this mouse's state.
  assert.equal(await client.setPollingRate(2000), 2000);
  assert.deepEqual(mouse.writes, ["15 0f 0a 00 00 00 | 00 04 21 01 f0 f0 08 08 08 03 00"]);

  mouse.writes.length = 0;
  await client.setDpi(800);
  assert.deepEqual(mouse.writes, [
    "14 0f 1c 00 00 00 | 00 01 0a 00 00 00 01 00 00 20 03 20 03 00 20 03 20 03 00 40 06 40 06 00 80 0c 80 0c",
  ]);

  mouse.writes.length = 0;
  await client.setSensorAngleTuning(-10);
  await client.setForceMaxSensorFps(true);
  assert.equal(mouse.writes.length, 2);
  assert.equal(mouse.blob[0x01], 0xf6);
  assert.equal(mouse.blob[0x06], 0x61);

  const status = await client.readStatus();
  assert.equal(status.eggAngleTuning, -10);
  assert.equal(status.eggForceMaxFps, true);
  assert.equal(status.motionJitterFilter, null);
  assert.equal(status.firmware[0], "Firmware V1.07");
  assert.equal(mouse.stores(), 0);
});

test("OP1w 4K v2 glass mode rescales lift-off like the vendor tool and sends both sensor blocks", async () => {
  const mouse = fake4kV2();
  const client = new EggOp1HidClient(mouse.device);

  await client.setGlassMode(true);
  // Sensor block first with LOD 1.7 mm rewritten to 2 (whole mm), then glass on in byte 11.
  assert.deepEqual(mouse.writes.map((write) => write.slice(0, 2)), ["14", "15"]);
  assert.equal(mouse.blob[0x09], 2);
  assert.equal(mouse.blob[0x6f], 1);

  let status = await client.readStatus();
  assert.equal(status.eggSupportsGlassMode, true);
  assert.equal(status.eggGlassMode, true);
  assert.deepEqual(status.eggLodOptions, ["1.0 mm", "2.0 mm"]);
  assert.equal(status.eggLodIndex, 1);
  assert.equal(status.liftOffDistance, "High");

  await client.setLiftOffDistance("Medium");
  assert.equal(mouse.blob[0x09], 1);

  await client.setGlassMode(false);
  assert.equal(mouse.blob[0x09], 3);
  status = await client.readStatus();
  assert.equal(status.eggGlassMode, false);
  assert.equal(status.liftOffDistance, "Medium");
  assert.equal(mouse.stores(), 0);
});

test("OP1w 4K v2 polling follows the vendor enum: 0x80 reads as 1000 Hz and free dividers are refused", async () => {
  const mouse = fake4kV2();
  mouse.blob[0x05] = 0x80; // 1000 Hz with wireless power saving
  const client = new EggOp1HidClient(mouse.device);

  const status = await client.readStatus();
  assert.equal(status.pollingRateHz, 1000);
  assert.deepEqual(status.supportedPollingRates, [125, 1000, 2000, 4000]);
  assert.equal(status.eggPollingDivider, undefined);
  await assert.rejects(client.setPollingRate(500), /Unsupported/);
  await assert.rejects(client.setCustomPollingDivider(16), /listed polling rates/);
  assert.deepEqual(mouse.writes, []);
});

test("over the shared 0x1970 dongle, the mouse-info reply names the paired 4K v2", async () => {
  const xm2w = fake4kV2({ productId: 0x1970, pairedPid: 0x1982 });
  assert.equal((await new EggOp1HidClient(xm2w.device).readStatus()).name, "Endgame Gear XM2w 4K v2");

  // Asleep: keep the neutral name, then pick up the model once the mouse answers.
  const sleepy = fake4kV2({ productId: 0x1970, pairedPid: null });
  const client = new EggOp1HidClient(sleepy.device);
  assert.equal((await client.readStatus()).name, "Endgame Gear OP1w/XM2w 4K v2");
  sleepy.state.pairedPid = 0x1984;
  assert.equal((await client.readStatus()).name, "Endgame Gear OP1w 4K v2");
});
