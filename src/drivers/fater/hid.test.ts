import assert from "node:assert/strict";
import test from "node:test";
import { FaterHidClient } from "./hid.ts";
import {
  FATER_CMD,
  FATER_CONFIG_USAGE,
  FATER_CONFIG_USAGE_PAGE,
  FATER_MCR_9000B_PRODUCT_ID,
  FATER_VENDOR_ID,
  faterDecodeReply,
  faterDecodeValue,
  faterDividerToHz,
  faterEncodeCommand,
  faterEncodeGet,
  faterHzToDivider,
} from "../../fater/index.ts";

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");

// Frames hv-ms735-config puts on the wire (its report() helper, report id
// stripped): CmdPing = 0x82, CmdGetReportRateDivider = 0x83, and a divider
// write of 2 (500 Hz).
test("encodes the Holtek 8-byte frame with the 0xFF-minus-sum checksum", () => {
  assert.equal(hex(faterEncodeGet(FATER_CMD.blink)), "82 00 00 00 00 00 00 7d");
  assert.equal(hex(faterEncodeGet(FATER_CMD.reportRateDivider)), "83 00 00 00 00 00 00 7c");
  assert.equal(hex(faterEncodeCommand(FATER_CMD.reportRateDivider, [0, 2])), "03 00 02 00 00 00 00 fa");
});

test("decodes a GET reply with or without a leading report-id byte", () => {
  const bare = new Uint8Array([0x83, 0x00, 0x04, 0, 0, 0, 0, 0x78]);
  const numbered = new Uint8Array([0x00, ...bare]);
  assert.equal(faterDecodeValue(bare, FATER_CMD.reportRateDivider), 4);
  assert.equal(faterDecodeValue(numbered, FATER_CMD.reportRateDivider), 4);
  assert.equal(faterDecodeReply(bare, FATER_CMD.profile | 0x80), null);
  assert.equal(faterDecodeValue(new Uint8Array(3), FATER_CMD.reportRateDivider), null);
});

test("polling dividers are 1000 Hz over the byte", () => {
  assert.deepEqual([1, 2, 4, 8].map(faterDividerToHz), [1000, 500, 250, 125]);
  assert.equal(faterDividerToHz(0), null);
  assert.equal(faterHzToDivider(125), 8);
  assert.throws(() => faterHzToDivider(2000), RangeError);
});

function fakeDevice(replies: Record<number, number | undefined>, usagePage = FATER_CONFIG_USAGE_PAGE) {
  const sent: Uint8Array[] = [];
  let last = 0;
  const device = {
    vendorId: FATER_VENDOR_ID,
    productId: FATER_MCR_9000B_PRODUCT_ID,
    productName: "USB Gaming Mouse",
    opened: false,
    collections: [{ usagePage, usage: FATER_CONFIG_USAGE, featureReports: [], inputReports: [], outputReports: [], children: [] }],
    open: async () => { (device as { opened: boolean }).opened = true; },
    close: async () => {},
    sendFeatureReport: async (_id: number, data: Uint8Array) => {
      sent.push(new Uint8Array(data));
      last = data[0]! & 0x7f;
    },
    receiveFeatureReport: async () => {
      const value = replies[last];
      if (value === undefined) throw new Error("STALL");
      return new DataView(new Uint8Array([last | 0x80, 0, value, 0, 0, 0, 0, 0]).buffer);
    },
  } as unknown as HIDDevice;
  return { device, sent };
}

test("isSupported needs the Holtek VID, the MCR-9000B PID and the 0xFF00 collection", () => {
  assert.equal(FaterHidClient.isSupported(fakeDevice({}).device), true);
  assert.equal(FaterHidClient.isSupported(fakeDevice({}, 0x01).device), false);
  const other = fakeDevice({}).device as unknown as { productId: number };
  other.productId = 0xa100;
  assert.equal(FaterHidClient.isSupported(other as unknown as HIDDevice), false);
});

test("readStatus reports polling rate and profile from the two GET replies", async () => {
  const { device, sent } = fakeDevice({ [FATER_CMD.reportRateDivider]: 2, [FATER_CMD.profile]: 3 });
  const status = await new FaterHidClient(device).readStatus();
  assert.equal(status.name, "Fater MCR-9000B");
  assert.equal(status.pollingRateHz, 500);
  assert.equal(status.activeProfile, 3);
  assert.equal(status.ui?.settingsReady, false);
  assert.equal(status.ui?.valuesVerified, true);
  assert.deepEqual(status.firmware, []);
  assert.deepEqual(sent.map(hex), ["83 00 00 00 00 00 00 7c", "84 00 00 00 00 00 00 7b"]);
});

test("readStatus degrades to identity when the mouse never answers", async () => {
  const { device } = fakeDevice({});
  const status = await new FaterHidClient(device).readStatus();
  assert.equal(status.pollingRateHz, 0);
  assert.equal(status.activeProfile, null);
  assert.equal(status.ui?.valuesVerified, false);
});
