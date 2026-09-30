import assert from "node:assert/strict";
import test from "node:test";

import {
  RAPOO_ADDRESS,
  RAPOO_CMD_BATTERY,
  RAPOO_CMD_READ,
  RAPOO_CMD_WRITE,
  RAPOO_CONFIG_REPORT_ID,
  RAPOO_DPI_STAGES,
  RAPOO_PRODUCT_IDS,
  RAPOO_STATUS_REPORT_ID,
  RAPOO_VENDOR_ID,
  decodeRapooActiveStage,
  decodeRapooAngle,
  decodeRapooAnswer,
  decodeRapooBatteryAnswer,
  decodeRapooDpiTable,
  decodeRapooNotification,
  decodeRapooPerformance,
  decodeRapooSensor,
  decodeRapooTiming,
  encodeRapooBatteryQuery,
  encodeRapooRead,
  encodeRapooWrite,
  rapooAnswerBlock,
  rapooLinkConnection,
  rapooPollingRateHz,
  rapooStatusBatteryPercent,
} from "./index.ts";

function fromHex(text: string): Uint8Array {
  return Uint8Array.from(text.trim().split(/\s+/).map((byte) => Number.parseInt(byte, 16)));
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

const zeros = (count: number): string => "00 ".repeat(count).trim();

/**
 * Register blocks exactly as the 2026-09-29 VT9 Pro capture returned them, on
 * the 2.4 GHz receiver and again on the cable. Both links agreed byte for byte.
 */
const PERF_BLOCK = fromHex("82 00 82 ff");
const SENSOR_BLOCK = fromHex("01 01 01 00");
const DPI_X_BLOCK = fromHex("90 01 20 03 b0 04 40 06 80 0c 00 19 90 65 02 00");
const ACTIVE_STAGE_BLOCK = fromHex("01 00 02 01");
const TIMING_BLOCK = fromHex("04 04 78 03");
const ANGLE_BLOCK = fromHex("00 00 01 00");

test("a read frame is the 31-byte 0xBA report the vendor driver sends", () => {
  assert.equal(
    toHex(encodeRapooRead(RAPOO_ADDRESS.performance, 4)),
    `a5 a4 04 80 08 00 00 ${zeros(24)}`,
  );
  assert.equal(
    toHex(encodeRapooRead(RAPOO_ADDRESS.dpiX, 16)),
    `a5 a4 10 88 08 00 00 ${zeros(24)}`,
  );
});

test("a write frame carries the block behind the address", () => {
  assert.equal(
    toHex(encodeRapooWrite(RAPOO_ADDRESS.performance, [...PERF_BLOCK])),
    `a5 a5 04 80 08 00 00 82 00 82 ff ${zeros(20)}`,
  );
});

test("the battery query has no address and no length", () => {
  assert.equal(
    toHex(encodeRapooBatteryQuery()),
    `a5 aa 00 00 00 00 00 ${zeros(24)}`,
  );
});

test("a frame hides the report id the transport may or may not keep", () => {
  const payload = "01 00 00 00 82 00 82 ff";
  const stripped = decodeRapooAnswer(fromHex(payload));
  const kept = decodeRapooAnswer(fromHex(`ba ${payload}`));

  assert.equal(stripped?.status, 0x01);
  assert.equal(stripped?.ok, true);
  assert.equal(stripped?.busy, false);
  assert.equal(stripped?.marker, 0);
  assert.equal(toHex(stripped!.payload), "82 00 82 ff");
  assert.deepEqual(kept, stripped);
});

test("an answer that is still busy is not mistaken for data", () => {
  const answer = decodeRapooAnswer(fromHex("02 00 00 00 82 00 82 ff"));
  assert.equal(answer?.ok, false);
  assert.equal(answer?.busy, true);
});

test("a short buffer is not an answer at all", () => {
  assert.equal(decodeRapooAnswer(Uint8Array.of()), null);
  assert.equal(decodeRapooAnswer(fromHex("01 00 00")), null);
});

test("a block is only taken from an answered frame of the right size", () => {
  const answer = decodeRapooAnswer(fromHex("01 00 00 00 82 00 82 ff"));
  assert.equal(toHex(rapooAnswerBlock(answer!, 4)!), "82 00 82 ff");
  // The mouse answers a 4-byte read with 4 bytes; asking for more than it sent
  // must not silently pad.
  assert.equal(rapooAnswerBlock(answer!, 16), null);
});

test("the performance block decodes both links and keeps what it cannot explain", () => {
  assert.deepEqual(decodeRapooPerformance(PERF_BLOCK), {
    receiverHz: 4000,
    wiredHz: 4000,
    reserved: [0x00, 0xff],
  });
  // An unknown rate code stays null instead of becoming a wrong number.
  assert.equal(decodeRapooPerformance(fromHex("7f 00 82 ff"))?.receiverHz, null);
  assert.equal(decodeRapooPerformance(fromHex("82 00")), null);
});

test("the vendor driver's polling table is carried in full", () => {
  assert.equal(rapooPollingRateHz(0x08), 125);
  assert.equal(rapooPollingRateHz(0x01), 1000);
  assert.equal(rapooPollingRateHz(0x84), 2000);
  assert.equal(rapooPollingRateHz(0x82), 4000);
  assert.equal(rapooPollingRateHz(0x81), 8000);
  assert.equal(rapooPollingRateHz(0x00), null);
});

test("the sensor block decodes lift-off and motion sync", () => {
  assert.deepEqual(decodeRapooSensor(SENSOR_BLOCK), { liftOffIndex: 1, motionSync: true });
  assert.deepEqual(decodeRapooSensor(fromHex("00 00 01 00")), {
    liftOffIndex: 0,
    motionSync: false,
  });
});

test("the DPI table decodes every stage and the count byte", () => {
  const table = decodeRapooDpiTable(DPI_X_BLOCK);
  assert.deepEqual(table?.stages, [400, 800, 1200, 1600, 3200, 6400, 26000]);
  // A stored byte of 2 means three stages are switched on.
  assert.equal(table?.countByte, 2);
  assert.equal(table?.enabledStages, 3);
  assert.equal(decodeRapooDpiTable(DPI_X_BLOCK)?.stages.length, RAPOO_DPI_STAGES);
  assert.equal(decodeRapooDpiTable(fromHex("90 01 20 03")), null);
});

test("a count byte past the end of the table is clamped, not wrapped", () => {
  const table = decodeRapooDpiTable(fromHex("90 01 20 03 b0 04 40 06 80 0c 00 19 90 65 ff 00"));
  assert.equal(table?.enabledStages, RAPOO_DPI_STAGES);
});

test("the active stage is decoded 0 based and bounded", () => {
  assert.equal(decodeRapooActiveStage(ACTIVE_STAGE_BLOCK), 1);
  assert.equal(decodeRapooActiveStage(fromHex("00 00 02 01")), 0);
  // Nothing beyond the table can be an active stage.
  assert.equal(decodeRapooActiveStage(fromHex("09 00 02 01")), null);
});

test("the timing block decodes debounce, sleep and the disable flags", () => {
  assert.deepEqual(decodeRapooTiming(TIMING_BLOCK), {
    pressDebounceMs: 16,
    releaseDebounceMs: 16,
    sleepMinutes: 120,
    angleSnapOff: true,
    rippleOff: true,
    flags: 0x03,
  });
  // Bit 0 clear means angle snap is on, and the same for ripple on bit 1.
  assert.deepEqual(decodeRapooTiming(fromHex("00 00 78 00")), {
    pressDebounceMs: 1,
    releaseDebounceMs: 1,
    sleepMinutes: 120,
    angleSnapOff: false,
    rippleOff: false,
    flags: 0x00,
  });
});

test("an unlisted debounce index is reported as unknown rather than guessed", () => {
  const timing = decodeRapooTiming(fromHex("09 04 78 03"));
  assert.equal(timing?.pressDebounceMs, null);
  assert.equal(timing?.releaseDebounceMs, 16);
});

test("the angle block decodes degrees", () => {
  assert.equal(decodeRapooAngle(ANGLE_BLOCK), 0);
  assert.equal(decodeRapooAngle(fromHex("05 00 01 00")), 5);
  assert.equal(decodeRapooAngle(Uint8Array.of()), null);
});

test("the battery answer is told apart from a block answer by its marker", () => {
  const answer = decodeRapooAnswer(fromHex("01 01 62 00 00 00 00 00"));
  assert.equal(answer?.marker, 1);
  assert.deepEqual(decodeRapooBatteryAnswer(answer!), { percent: 98, charging: false });

  const charging = decodeRapooAnswer(fromHex("01 02 45 00 00 00 00 00"));
  assert.deepEqual(decodeRapooBatteryAnswer(charging!), { percent: 69, charging: true });

  // A block answer has a zero marker and is not a battery reading.
  assert.equal(decodeRapooBatteryAnswer(decodeRapooAnswer(fromHex("01 00 00 00 82 00 82 ff"))!), null);
  // Nor is an unlisted marker.
  assert.equal(decodeRapooBatteryAnswer(decodeRapooAnswer(fromHex("01 07 62 00"))!), null);
  // Nor is an impossible percentage.
  assert.equal(decodeRapooBatteryAnswer(decodeRapooAnswer(fromHex("01 01 7f 00"))!), null);
});

test("the 0xBB notification decodes the link byte and the percentage", () => {
  assert.deepEqual(decodeRapooNotification(fromHex("b0 51 20 03 01 62")), {
    linkCode: 0x01,
    batteryPercent: 98,
  });
  assert.deepEqual(decodeRapooNotification(fromHex("b0 51 20 03 01 64")), {
    linkCode: 0x01,
    batteryPercent: 100,
  });

  // The header is checked, so another report on 0xBB cannot be read as status.
  assert.equal(decodeRapooNotification(fromHex("00 51 20 03 01 62")), null);
  assert.equal(decodeRapooNotification(fromHex("b0 51 20 03 01")), null);
  // A percentage outside 0-100 is dropped rather than shown.
  assert.equal(decodeRapooNotification(fromHex("b0 51 20 03 01 7f"))?.batteryPercent, null);
});

test("the notification link byte maps to a connection where it is known", () => {
  assert.equal(rapooLinkConnection(0x01), "Wireless");
  assert.equal(rapooLinkConnection(0x02), "Wired");
  assert.equal(rapooLinkConnection(0x03), null);
});

test("the 0x2A feature block yields the battery a browser can read", () => {
  // Windows' GET_REPORT(Feature) keeps the report id in front of the data.
  assert.equal(
    rapooStatusBatteryPercent(fromHex("2a 01 00 00 04 21 50 00 00 62 00")),
    98,
  );
  assert.equal(
    rapooStatusBatteryPercent(fromHex("2a 01 00 00 04 11 20 00 00 62 00")),
    98,
  );
  // WebHID's receiveFeatureReport may hand back the data with the id stripped.
  assert.equal(rapooStatusBatteryPercent(fromHex("01 00 00 04 21 50 00 00 62 00")), 98);
  assert.equal(rapooStatusBatteryPercent(fromHex("01 00 00 04 11 20 00 00 62 00")), 98);
  // Too short to hold the byte, and a percentage that cannot be one.
  assert.equal(rapooStatusBatteryPercent(fromHex("2a 01 00 00 04 21 50 00")), null);
  assert.equal(rapooStatusBatteryPercent(fromHex("2a 01 00 00 04 21 50 00 00 7f 00")), null);
});

test("the catalog names the two interfaces this mouse has been seen on", () => {
  assert.equal(RAPOO_VENDOR_ID, 0x24ae);
  assert.deepEqual([...RAPOO_PRODUCT_IDS].sort((a, b) => a - b), [0x1205, 0x4405]);
});

test("commands and report ids match the vendor driver's constants", () => {
  assert.equal(RAPOO_CMD_READ, 0xa4);
  assert.equal(RAPOO_CMD_WRITE, 0xa5);
  assert.equal(RAPOO_CMD_BATTERY, 0xaa);
  assert.equal(RAPOO_CONFIG_REPORT_ID, 0xba);
  assert.equal(RAPOO_STATUS_REPORT_ID, 0x2a);
});
