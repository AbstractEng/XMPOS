import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyHardwareEvent,
  type HardwareTarget,
  parseHardwareEvent,
} from "../apps/studio/src/device/hardware-link.ts";
import { panelButtons } from "../apps/studio/src/device/navigation.ts";

// Phase 3: the XMP Device app on the MPC Live Mk1 (AGENTS.md authorizations 2-4).
const root = join(import.meta.dirname, "..");
const input = readFileSync(join(root, "native/src/live_input.cpp"), "utf8");
const service = readFileSync(join(root, "os/guest/live.ts"), "utf8");
const init = readFileSync(join(root, "os/live-mk1/live-init"), "utf8");
const hw = JSON.parse(readFileSync(join(root, "os/live-mk1/hardware.json"), "utf8"));

describe("the Live's controls reach the Device app", () => {
  it("maps every front-panel button the app knows, in the Live's physical order", () => {
    const pairs = [...input.matchAll(/\{0x([0-9A-F]{2}), "([a-z0-9-]+)"\}/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(pairs.map(([, name]) => name)).toEqual([...panelButtons]);
    const note = (name: string) => pairs.find(([, n]) => n === name)?.[0];
    // Confirmed by the owner (hardware.json): Rec 2nd, Stop 4th, Play 5th of the second row.
    expect([note("rec"), note("stop"), note("play")]).toEqual(["49", "51", "52"]);
    expect(hw.controller.map.screenRow2).toEqual(["35", "49", "50", "51", "52", "53", "37"]);
    expect(hw.controller.map.screenRow1).toEqual(["31", "7B", "34", "43", "7A", "36"]);
    expect(["bank-a", "bank-b", "bank-c", "bank-d"].map(note)).toEqual(["23", "24", "25", "26"]);
  });

  it("accepts only bounded, known events", () => {
    expect(parseHardwareEvent('{"t":"pad","index":3,"velocity":90,"down":true}')).toEqual({
      t: "pad",
      index: 3,
      velocity: 90,
      down: true,
    });
    expect(parseHardwareEvent('{"t":"button","name":"play","down":true}')).toBeTruthy();
    for (const bad of [
      '{"t":"pad","index":16,"velocity":90,"down":true}',
      '{"t":"button","name":"format-disk","down":true}',
      '{"t":"dial","delta":500}',
      '{"t":"eval","code":"alert(1)"}',
      "not json",
      `{"t":"pad","index":1,"velocity":1,"down":true,"pad":"${"x".repeat(300)}"}`,
    ])
      expect(parseHardwareEvent(bad)).toBeUndefined();
  });

  it("turns events into the same calls as the on-screen controls", () => {
    const calls: string[] = [];
    const target: HardwareTarget = {
      button: (name, shift) => calls.push(`button ${name}${shift ? " +shift" : ""}`),
      dispatch: (a) =>
        calls.push(
          a.type === "pad"
            ? `pad ${a.index}${a.edit ? " +shift" : ""}`
            : a.type === "focus"
              ? `focus ${a.delta}`
              : `parameter ${a.index}`,
        ),
    };
    const state = { shift: false };
    for (const e of [
      { t: "button", name: "play", down: true },
      { t: "button", name: "play", down: false },
      { t: "button", name: "shift", down: true },
      { t: "pad", index: 4, velocity: 100, down: true },
      { t: "button", name: "shift", down: false },
      { t: "pad", index: 4, velocity: 0, down: false },
      { t: "dial", delta: -2 },
    ] as const)
      applyHardwareEvent(target, e, state);
    expect(calls).toEqual(["button play", "pad 4 +shift", "focus -1", "focus -1"]);
  });

  it("turns Q-Link knob clicks into parameter values, 1% per click, bounded", () => {
    const values = [0.8, 0.55, 0.995, 0.01];
    const set: string[] = [];
    const target: HardwareTarget = {
      button: () => {},
      dispatch: (a) => {
        if (a.type === "parameter") set.push(`${a.index}=${a.value.toFixed(3)}`);
      },
      qlinkValue: (i) => values[i],
    };
    const state = { shift: false };
    for (const [knob, delta] of [
      [1, -5],
      [2, 3],
      [3, 4],
      [4, -2],
    ] as const)
      applyHardwareEvent(target, { t: "knob", knob, delta }, state);
    expect(set).toEqual(["0=0.750", "1=0.580", "2=1.000", "3=0.000"]);
  });
});

describe("phase 3 hardware boundary", () => {
  it("the input service sends the controller only the two authorized messages", () => {
    const writes = [
      ...input.matchAll(
        /snd_rawmidi_write\(out, xmp::live::(\w+)\.data\(\), xmp::live::(\w+)\.size\(\)\)/g,
      ),
    ];
    expect(writes.map((m) => m[1])).toEqual(["kIdentityRequest", "kStartupSequence"]);
    expect(input.match(/snd_rawmidi_write\(/g)).toHaveLength(2);
    expect(input).toMatch(/if \(!xmp::live::is_live_mk1\(compatible\)\)/);
    expect(input).toMatch(/live_audio_card_allowed\(identity, compatible\)/);
    expect(input).not.toMatch(/EVIOCGRAB|AF_INET/);
  });

  it("the app server is loopback only and the page has no MIDI, USB or HID", () => {
    expect(service).toMatch(/server\.listen\(8080, "127\.0\.0\.1"/);
    expect(service).toMatch(/"Permissions-Policy": "midi=\(\), usb=\(\), hid=\(\), serial=\(\)/);
    expect(service).toMatch(/req\.headers\.origin === origin/); // the WebSocket only for the app itself
    expect(service).not.toMatch(/0\.0\.0\.0|listen\(\d+\)/);
    expect(service).toMatch(/is not the MPC Live Mk1/);
  });

  it("everything the app plays is capped at -12 dB, and only on the allowed card", () => {
    expect(init).toMatch(/type softvol[\s\S]*max_dB -12\.0[\s\S]*resolution 2/);
    expect(init).toMatch(/pcm\.!default \{ type null \}/);
    expect(init).toMatch(/card=\$\(cat \/tmp\/xmp-audio-card/);
    expect(init).toMatch(/\*ff0f0000\*\|\*ff0c0000\*/); // internal storage refused
    expect(init).toMatch(/\*force\*\|\*ada2\*\) off "refusing/);
  });
});
