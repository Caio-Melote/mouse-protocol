import assert from "node:assert/strict";
import test from "node:test";

import {
  COOLERMASTER_CMD_HANDSHAKE_1,
  COOLERMASTER_CMD_HANDSHAKE_2,
  COOLERMASTER_CMD_READ,
  COOLERMASTER_CMD_WRITE,
  COOLERMASTER_DPI_MAX,
  COOLERMASTER_DPI_MIN,
  COOLERMASTER_DPI_STAGE_COUNT,
  COOLERMASTER_MM711_PRODUCT_ID,
  COOLERMASTER_PAYLOAD_SIZE,
  COOLERMASTER_POLLING_RATES,
  COOLERMASTER_PRODUCT_NAMES,
  COOLERMASTER_REPORT_ID,
  COOLERMASTER_REPORT_SIZE,
  COOLERMASTER_SUB_DEBOUNCE,
  COOLERMASTER_SUB_DPI_LEVEL,
  COOLERMASTER_SUB_PERFORMANCE,
  COOLERMASTER_SUB_POLLING,
  COOLERMASTER_USAGE,
  COOLERMASTER_USAGE_PAGE,
  COOLERMASTER_VENDOR_ID,
  coolermasterDecodeDebounce,
  coolermasterDecodeDpi,
  coolermasterDecodeDpiLevel,
  coolermasterDecodePerformance,
  coolermasterDecodePollingRate,
  coolermasterDecodePollingRateCode,
  coolermasterEncodeDebounce,
  coolermasterEncodeDpi,
  coolermasterEncodeGetDebounce,
  coolermasterEncodeGetDpiLevel,
  coolermasterEncodeGetPerformance,
  coolermasterEncodeGetPollingRate,
  coolermasterEncodeHandshake,
  coolermasterEncodePollingCode,
  coolermasterEncodeSetDebounce,
  coolermasterEncodeSetPerformance,
  coolermasterEncodeSetPollingRate,
} from "./index.ts";

function fromHex(text: string): Uint8Array {
  const clean = text.replace(/#.*$/gm, "").trim().replace(/\s+/g, "");
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = Number.parseInt(clean.slice(i, i + 2), 16);
  }
  return bytes;
}

// Captured fixtures from physical MM711
const FIXTURE_HANDSHAKE = fromHex(
  "41800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
);
const FIXTURE_GET_POLLING_WITH_REPORT_ID = fromHex(
  "0052f00000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
);
const FIXTURE_GET_PERFORMANCE_WITH_REPORT_ID = fromHex(
  "0052400000010303070f0b1f3f9f03070f0b1f3f9f0000000000000000020a06000000000000000000000000000000000000000000000000000000000000000000",
);
const FIXTURE_GET_DEBOUNCE_WITH_REPORT_ID = fromHex(
  "0052100000000000000000000005000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
);
const FIXTURE_GET_DPI_LEVEL_WITH_REPORT_ID = fromHex(
  "00529b0000000103020405060000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
);

test("Cooler Master constants match hardware and MasterPlus specifications", () => {
  assert.equal(COOLERMASTER_VENDOR_ID, 0x2516);
  assert.equal(COOLERMASTER_MM711_PRODUCT_ID, 0x0101);
  assert.equal(COOLERMASTER_USAGE_PAGE, 0xff00);
  assert.equal(COOLERMASTER_USAGE, 0x0001);
  assert.equal(COOLERMASTER_REPORT_ID, 0x00);
  assert.equal(COOLERMASTER_PAYLOAD_SIZE, 64);
  assert.equal(COOLERMASTER_REPORT_SIZE, 65);
  assert.equal(COOLERMASTER_PRODUCT_NAMES.get(0x0101), "Cooler Master MM711");
  assert.deepEqual(COOLERMASTER_POLLING_RATES, [125, 250, 500, 1000]);
});

test("DPI encoding and decoding follows (code + 1) * 100 formula", () => {
  assert.equal(coolermasterEncodeDpi(100), 0x00);
  assert.equal(coolermasterEncodeDpi(400), 0x03);
  assert.equal(coolermasterEncodeDpi(800), 0x07);
  assert.equal(coolermasterEncodeDpi(1200), 0x0b);
  assert.equal(coolermasterEncodeDpi(1600), 0x0f);
  assert.equal(coolermasterEncodeDpi(3200), 0x1f);
  assert.equal(coolermasterEncodeDpi(6400), 0x3f);
  assert.equal(coolermasterEncodeDpi(16000), 0x9f);

  assert.equal(coolermasterDecodeDpi(0x00), 100);
  assert.equal(coolermasterDecodeDpi(0x03), 400);
  assert.equal(coolermasterDecodeDpi(0x07), 800);
  assert.equal(coolermasterDecodeDpi(0x0b), 1200);
  assert.equal(coolermasterDecodeDpi(0x0f), 1600);
  assert.equal(coolermasterDecodeDpi(0x1f), 3200);
  assert.equal(coolermasterDecodeDpi(0x3f), 6400);
  assert.equal(coolermasterDecodeDpi(0x9f), 16000);

  // Clamping
  assert.equal(coolermasterEncodeDpi(50), 0x00);
  assert.equal(coolermasterEncodeDpi(20000), 0x9f);
  assert.throws(() => coolermasterEncodeDpi(Number.NaN));
});

test("polling rate codes map to 1000, 500, 250, and 125 Hz", () => {
  assert.equal(coolermasterEncodePollingCode(1000), 1);
  assert.equal(coolermasterEncodePollingCode(500), 2);
  assert.equal(coolermasterEncodePollingCode(250), 4);
  assert.equal(coolermasterEncodePollingCode(125), 8);
  assert.throws(() => coolermasterEncodePollingCode(2000));

  assert.equal(coolermasterDecodePollingRateCode(1), 1000);
  assert.equal(coolermasterDecodePollingRateCode(2), 500);
  assert.equal(coolermasterDecodePollingRateCode(4), 250);
  assert.equal(coolermasterDecodePollingRateCode(8), 125);
  assert.throws(() => coolermasterDecodePollingRateCode(3));
});

test("handshake packet builds correctly", () => {
  const packet = coolermasterEncodeHandshake();
  assert.equal(packet.length, COOLERMASTER_PAYLOAD_SIZE);
  assert.equal(packet[0], COOLERMASTER_CMD_HANDSHAKE_1);
  assert.equal(packet[1], COOLERMASTER_CMD_HANDSHAKE_2);
  assert.deepEqual(packet, FIXTURE_HANDSHAKE);
});

test("polling rate read and write commands match protocol", () => {
  const getReq = coolermasterEncodeGetPollingRate();
  assert.equal(getReq[0], COOLERMASTER_CMD_READ);
  assert.equal(getReq[1], COOLERMASTER_SUB_POLLING);

  const setReq = coolermasterEncodeSetPollingRate(500);
  assert.equal(setReq[0], COOLERMASTER_CMD_WRITE);
  assert.equal(setReq[1], COOLERMASTER_SUB_POLLING);
  assert.equal(setReq[4], 2);

  // Decode from fixture with report ID
  assert.equal(coolermasterDecodePollingRate(FIXTURE_GET_POLLING_WITH_REPORT_ID), 1000);

  // Decode from payload without report ID
  const payloadOnly = FIXTURE_GET_POLLING_WITH_REPORT_ID.subarray(1);
  assert.equal(coolermasterDecodePollingRate(payloadOnly), 1000);
});

test("performance packet decodes correctly from captured MM711 fixture", () => {
  const perf = coolermasterDecodePerformance(FIXTURE_GET_PERFORMANCE_WITH_REPORT_ID);

  assert.equal(perf.activeDpiStage, 1);
  assert.equal(perf.currentDpi, 800);
  assert.equal(perf.currentDpiY, 800);
  assert.deepEqual(perf.dpiStages, [400, 800, 1600, 1200, 3200, 6400, 16000]);
  assert.deepEqual(perf.dpiStagesY, [400, 800, 1600, 1200, 3200, 6400, 16000]);
  assert.equal(perf.angleTuning, 0);
  assert.equal(perf.angleSnapping, false);
  assert.equal(perf.liftOffDistance, "Low");
  assert.equal(perf.pixelThreshold, 10);
  assert.equal(perf.minSqRun, 6);
});

test("set performance packet updates active stage, stages, and LOD", () => {
  const base = FIXTURE_GET_PERFORMANCE_WITH_REPORT_ID.subarray(1);
  const updated = coolermasterEncodeSetPerformance(
    {
      activeDpiStage: 0,
      dpiStages: [800, 1600, 2400, 3200, 4800, 6400, 12000],
      liftOffDistance: "High",
      angleSnapping: true,
      angleTuning: 5,
    },
    base,
  );

  assert.equal(updated[0], COOLERMASTER_CMD_WRITE);
  assert.equal(updated[1], COOLERMASTER_SUB_PERFORMANCE);
  assert.equal(updated[4], 0); // active stage
  assert.equal(coolermasterDecodeDpi(updated[6]!), 800);
  assert.equal(coolermasterDecodeDpi(updated[7]!), 1600);
  assert.equal(coolermasterDecodeDpi(updated[12]!), 12000);
  assert.equal(updated[27], 5); // angle tuning
  assert.equal((updated[28]! & 0x01) === 0x01, true); // angle snap on
  assert.equal((updated[28]! & 0x06) === 0x06, true); // high LOD
});

test("debounce read and write packets decode and encode correctly", () => {
  const getReq = coolermasterEncodeGetDebounce();
  assert.equal(getReq[0], COOLERMASTER_CMD_READ);
  assert.equal(getReq[1], COOLERMASTER_SUB_DEBOUNCE);

  assert.equal(coolermasterDecodeDebounce(FIXTURE_GET_DEBOUNCE_WITH_REPORT_ID), 5);

  const setReq = coolermasterEncodeSetDebounce(12);
  assert.equal(setReq[0], COOLERMASTER_CMD_WRITE);
  assert.equal(setReq[1], COOLERMASTER_SUB_DEBOUNCE);
  assert.equal(setReq[12], 12);
  assert.equal(setReq[16], 12);

  assert.throws(() => coolermasterEncodeSetDebounce(0));
  assert.throws(() => coolermasterEncodeSetDebounce(50));
});

test("DPI level packet decodes correctly", () => {
  const req = coolermasterEncodeGetDpiLevel();
  assert.equal(req[0], COOLERMASTER_CMD_READ);
  assert.equal(req[1], COOLERMASTER_SUB_DPI_LEVEL);

  const level = coolermasterDecodeDpiLevel(FIXTURE_GET_DPI_LEVEL_WITH_REPORT_ID);
  assert.equal(level.activeDpiStage, 1);
  assert.deepEqual(level.stageOrder, [3, 2, 4, 5, 6, 0, 0]);
});
