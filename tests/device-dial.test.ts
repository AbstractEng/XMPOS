// @vitest-environment happy-dom
// The data dial moves through each Device page's items by default (the Live's
// Ui::wheel), and ENTER acts on the highlighted one.
import { beforeAll, expect, it } from "vitest";
import { DeviceController, deviceDemo } from "../apps/studio/src/device/controller.ts";
import { workbenchContent } from "../apps/studio/src/device/workbench-view.ts";
import { loadCore } from "../packages/core/src/edits.ts";
import { machines } from "../packages/core/src/machines.ts";
import { ContractAudio } from "./helpers/device-audio.ts";

beforeAll(async () => {
  await loadCore();
});

it("moves between tracks on the mixer and on Play", () => {
  const c = new DeviceController(deviceDemo(), new ContractAudio());
  for (const page of ["mix", "play"] as const) {
    c.trackId = c.project.tracks[0]?.id ?? "";
    c.show(page);
    c.turn(1);
    expect(c.trackId).toBe(c.project.tracks[1]?.id);
    c.turn(-5);
    expect(c.trackId).toBe(c.project.tracks[0]?.id);
  }
});

it("moves through a synth's presets and controls, and ENTER chooses the preset", async () => {
  const c = new DeviceController(deviceDemo(), new ContractAudio());
  c.trackId = c.project.tracks[1]?.id ?? "";
  c.edit((p) => {
    const t = p.tracks[1];
    if (t) t.machine = machines.instantiate("xmp.subtractive");
    return p;
  });
  c.show("sound");
  c.turn(9);
  expect(c.workbench.soundFocus).toBe(9);
  expect(c.workbench.presetPage).toBe(1);
  expect(workbenchContent(c)).toContain("dial");
  c.enter();
  await Promise.resolve();
  expect(c.track.machine?.state.name).toBeDefined();
  const chosen = c.track.machine?.state.name;
  c.turn(1);
  c.enter();
  await Promise.resolve();
  expect(c.track.machine?.state.name).not.toBe(chosen);
  c.workbench.soundTab = "controls";
  c.workbench.soundFocus = 0;
  c.turn(2);
  expect(c.workbench.soundFocus).toBe(2);
  expect(workbenchContent(c)).toContain('data-dial="true"');
});

it("moves through a kit's pads on Sound", () => {
  const c = new DeviceController(deviceDemo(), new ContractAudio());
  c.trackId = c.project.tracks[0]?.id ?? "";
  c.show("sound");
  c.nav.pad = 0;
  c.turn(3);
  expect(c.nav.pad).toBe(3);
});
