import { describe, expect, it } from "vitest";
import { NativeTouchscreen } from "../packages/core/src/device-ui.ts";
import { createDemoProject } from "../packages/core/src/index.ts";

describe("the native sampler touchscreen in WebAssembly", () => {
  it("arms a next-bar take while transport keeps playing, with four bars and monitoring by default", async () => {
    const ui = await NativeTouchscreen.create();
    ui.setProject(createDemoProject(), 0, 0);
    ui.transport(17, true);
    expect(ui.state.bars).toBe(4);
    expect(ui.state.monitor).toBe(true);
    ui.button("Rec", true);
    ui.button("Rec", false);
    expect(ui.actions()).toContainEqual({ kind: "record", track: 0, pad: 0 });
    ui.button("Rec", true);
    ui.button("Rec", false);
    expect(ui.actions()).toContainEqual({ kind: "stop-record", track: 0, pad: -1 });
  });
  it("uses native pad actions and exact displayed chop boundaries for audition", async () => {
    const ui = await NativeTouchscreen.create();
    ui.setProject(createDemoProject(), 0, 0);
    ui.setTake(new Float32Array([0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4]));
    ui.button("Shift", true);
    ui.knob(3, 3);
    ui.button("Shift", false);
    expect(ui.state.edit.boundaries).toEqual([0, 2, 4, 6, 8]);
    ui.pad(2);
    expect(ui.actions()).toContainEqual({ kind: "audition", track: 0, pad: 2 });
    expect(ui.preview(2)).toEqual(new Float32Array([-0.1, -0.2]));
    const make = ui.controls().find((c) => c.name === "Chop to drum kit");
    expect(make?.enabled).toBe(true);
    if (!make) throw new Error("Missing shared native control");
    ui.touch("down", make.x + make.width / 2, make.y + make.height / 2);
    ui.touch("up", make.x + make.width / 2, make.y + make.height / 2);
    expect(ui.actions()).toContainEqual({ kind: "chop", track: 0, pad: 0 });
    const pixels = new Uint8ClampedArray(1280 * 800 * 4);
    ui.paintRGBA(pixels);
    expect(pixels[3]).toBe(255);
    expect(new Set(pixels).size).toBeGreaterThan(8);
  });
});
