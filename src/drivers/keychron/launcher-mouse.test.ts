import assert from "node:assert/strict";
import { test } from "node:test";
import { KEYCHRON_4K_MICE, KEYCHRON_LAUNCHER_MICE, KEYCHRON_RECEIVERS } from "@openmouse/protocol/keychron";
import {
  keychronButtonOptions,
  keychronButtons,
  keychronDecodeButton,
  keychronDecodeConnectedMouse,
  keychronDecodeSettings,
  keychronEncodeButton,
  keychronEncodeDpi,
  keychronEncodeLighting,
  keychronEncodeSensor,
  keychronLauncherMouse,
  keychronLighting,
  keychronLiftOff,
} from "./launcher-mouse.ts";

const record = (bytes: number[]): Uint8Array => new Uint8Array([0x62, 0, 0, ...bytes]);

test("button codes follow Launcher's EFunKey and EBasicKey packing", () => {
  assert.deepEqual(keychronEncodeButton("Left Click", "8k"), [1, 0x01, 0x00, 0x00]);
  assert.deepEqual(keychronEncodeButton("Scroll Down", "8k"), [1, 0x00, 0xfe, 0x00]);
  assert.deepEqual(keychronEncodeButton("Scroll Left", "8k"), [1, 0x00, 0x00, 0xfe]);
  assert.deepEqual(keychronEncodeButton("Double Click", "8k"), [1, 0x80, 0x00, 0x00]);
  assert.deepEqual(keychronEncodeButton("DPI -", "8k"), [5, 3]);
  assert.deepEqual(keychronEncodeButton("Play/Pause", "8k"), [3, 0xcd, 0x00]);
  assert.deepEqual(keychronEncodeButton("Disabled", "8k"), [9]);
  assert.deepEqual(keychronEncodeButton("Default", "8k"), [0]);
  assert.equal(keychronEncodeButton("Macro", "8k"), null);
  // Module 8596 ("1k") has Back and Forward the other way round from module 75994 ("8k").
  assert.deepEqual(keychronEncodeButton("Back", "8k"), [1, 0x08, 0x00, 0x00]);
  assert.deepEqual(keychronEncodeButton("Back", "1k"), [1, 0x10, 0x00, 0x00]);
  assert.equal(keychronDecodeButton(record([1, 0x10, 0x00, 0x00]), "8k"), "Forward");
  assert.equal(keychronDecodeButton(record([1, 0x10, 0x00, 0x00]), "1k"), "Back");
  assert.equal(keychronDecodeButton(record([0]), "8k"), null);
  assert.equal(keychronDecodeButton(record([3, 0xea, 0x00]), "8k"), "Volume Down");
  assert.equal(keychronDecodeButton(record([4, 0, 2, 0]), "8k"), "Macro");
  assert.equal(keychronDecodeButton(record([2, 0x01, 0x04, 0]), "8k"), "Custom");
  assert.equal(keychronButtonOptions("8k").length, new Set(keychronButtonOptions("8k")).size);
});

test("status bytes 1-17 decode the same for both protocols", () => {
  const bytes = new Uint8Array(20);
  bytes.set([0x07, 1, 0x12, 0x00, 0x00, 0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0, 0, 0, 0, 0x5d, 3, 6]);
  assert.deepEqual(keychronDecodeSettings(bytes), {
    profile: 1,
    levels: [0x12, 0, 0],
    dpiStages: [400, 800, 1600, 0, 0],
    stageCount: 3,
    lod: 1,
    rippleControl: true,
    angleSnapping: true,
    motionSync: true,
    scrollReversed: true,
    debounceMs: 6,
  });
  assert.deepEqual(Array.from(keychronEncodeDpi(2, [400, 800, 1600, 3200, 6400], 5)), [0x40, 2, 2, 2, 0x90, 0x01, 0x20, 0x03, 0x40, 0x06, 0x80, 0x0c, 0x00, 0x19, 5, 0, 0, 0, 0, 0]);
  const sensor = keychronEncodeSensor({ lod: 3, rippleControl: false, angleSnapping: true, motionSync: false, scrollReversed: true, maxSpeed: true, lodLevel: 4 });
  assert.deepEqual(Array.from(sensor.slice(0, 12)), [0x42, 3, 2, 1, 2, 0, 2, 0, 2, 0, 0, 4]);
});

test("a receiver's 0x03 list gives the connected mouse", () => {
  const list = new Uint8Array(20);
  list.set([0x03, 2, 0x34, 0x34, 0x60, 0xd0, 0, 0x34, 0x34, 0x50, 0xd0, 1]);
  assert.equal(keychronDecodeConnectedMouse(list), 0xd050);
  list[11] = 0;
  assert.equal(keychronDecodeConnectedMouse(list), null);
});

test("lift-off maps three heights to stops and more to the slider", () => {
  assert.deepEqual(keychronLiftOff([[3, 0.7], [1, 1], [2, 2]], 3), {
    liftOffDistance: "Low",
    supportedLiftOffDistances: ["Low", "Medium", "High"],
    note: "Lift-off: Low is 0.7 mm, Medium is 1 mm, High is 2 mm.",
  });
  assert.equal(keychronLiftOff([[1, 1], [2, 2]], 2).liftOffDistance, "High");
  assert.deepEqual(keychronLiftOff([], 1), { liftOffDistance: null });
  const levels = keychronLauncherMouse(0xd09d)!.lodLevels!;
  assert.deepEqual(keychronLiftOff(levels, 11).liftOffScale, { value: 11, min: 1, max: 11, millimetres: 1.7, minMillimetres: 0.7, maxMillimetres: 1.7 });
});

test("lighting round-trips between Launcher's 0-255 sliders and the panel's steps", () => {
  const offered = [1, 2, 3];
  const lighting = keychronLighting({ mode: 2, brightness: 64, speed: 255, rgb: [18, 255, 0] }, offered);
  assert.deepEqual(lighting.modes, ["Off", "Static", "Breathing single", "Spectrum"]);
  assert.equal(lighting.mode, "Breathing single");
  assert.equal(lighting.color, "#12ff00");
  assert.equal(lighting.brightness, 25);
  assert.equal(lighting.speed, 5);
  assert.deepEqual(keychronEncodeLighting({ ...lighting, mode: "Spectrum", brightness: 75, speed: 2 }, offered), {
    mode: 3,
    brightness: 191,
    speed: 102,
    rgb: [18, 255, 0],
  });
  assert.throws(() => keychronEncodeLighting({ ...lighting, mode: "Wave" }, offered), /no Wave lighting/);
  // Effects the panel has no name for read as unknown rather than as a wrong one.
  assert.equal(keychronLighting({ mode: 6, brightness: 0, speed: 0, rgb: [0, 0, 0] }, [1, 6]).mode, null);
});

test("the model table leaves other drivers' mice alone and names every button", () => {
  const ids = KEYCHRON_LAUNCHER_MICE.map((mouse) => mouse.productId);
  assert.equal(new Set(ids).size, ids.length, "one row per product ID");
  for (const { productId } of KEYCHRON_4K_MICE) assert.equal(ids.includes(productId), false, `0x${productId.toString(16)} is a 4K mouse`);
  assert.equal(ids.includes(0xd077), false, "the G3 Air speaks 8k_nordic");
  for (const id of KEYCHRON_RECEIVERS.keys()) assert.equal(ids.includes(id), false, `0x${id.toString(16)} is a receiver`);
  for (const mouse of KEYCHRON_LAUNCHER_MICE) {
    const buttons = keychronButtons(mouse);
    assert.equal(new Set(buttons.map(({ name }) => name)).size, buttons.length, `${mouse.name} button names are unique`);
    assert.equal(new Set(buttons.map(({ index }) => index)).size, buttons.length, `${mouse.name} button indexes are unique`);
    assert.ok(mouse.dpi[0] < mouse.dpi[1], `${mouse.name} DPI range`);
    assert.ok((mouse.lod ?? []).every(([code]) => code >= 1 && code <= 3), `${mouse.name} lift-off codes fit two bits`);
  }
  assert.deepEqual(keychronButtons(keychronLauncherMouse(0xd059)).map(({ name }) => name).slice(3, 7), ["Forward", "Back", "Forward 2", "Back 2"]);
});
