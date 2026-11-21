// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { DeviceController } from "../apps/studio/src/device/controller.ts";
import { NativeSampler } from "../apps/studio/src/device/native-sampler.ts";
import { NativeTouchscreen } from "../packages/core/src/device-ui.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { sampleEdit } from "../packages/core/src/sample-edit.ts";
import { ContractAudio } from "./helpers/device-audio.ts";

afterEach(() => vi.unstubAllGlobals());
it("routes browser pads, destination changes and kit conversion through the native sampler", async () => {
  vi.stubGlobal(
    "ImageData",
    class {
      data: Uint8ClampedArray;
      constructor(w: number, h: number) {
        this.data = new Uint8ClampedArray(w * h * 4);
      }
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(
    () => ({ putImageData: () => {} }) as unknown as CanvasRenderingContext2D,
  );
  const audio = new ContractAudio(),
    c = new DeviceController(createDemoProject(), audio);
  const preview = vi.fn(async (_rate?: number, _pcm?: Float32Array) => {});
  audio.audition = preview;
  const ui = await NativeTouchscreen.create(),
    sampler = new NativeSampler(c, ui);
  c.sampler = sampler;
  const pcm = [0.1, 0.2, 0.3, 0.4, -0.1, -0.2, -0.3, -0.4];
  c.workbench.sample = {
    name: "Fixture",
    rate: 48000,
    pcm,
    edit: sampleEdit(8),
    track: c.trackId,
    pad: 0,
    revision: c.session.revision,
  };
  c.show("sample");
  document.body.innerHTML =
    '<div id="app"><canvas id="native-sampler" width="1280" height="800"></canvas><div id="native-sampler-controls"></div></div>';
  const root = document.getElementById("app");
  if (!root) throw new Error("Missing fixture surface");
  sampler.mount(root);
  ui.button("Shift", true);
  ui.knob(3, 3);
  ui.button("Shift", false);
  sampler.pad(2);
  expect(preview.mock.calls[0]?.[1]).toEqual(new Float32Array([-0.1, -0.2]));
  const before = c.project;
  const make = [...root.querySelectorAll("button")].find(
    (b) => b.textContent === "Chop to drum kit",
  );
  if (!make) throw new Error("Missing native kit action");
  make.click();
  expect(c.project.tracks[0]?.pads?.slice(0, 4).map((p) => p.slice)).toEqual([
    { start: 0, end: 2 },
    { start: 2, end: 4 },
    { start: 4, end: 6 },
    { start: 6, end: 8 },
  ]);
  expect(c.project.tracks.slice(1)).toEqual(before.tracks.slice(1));
  expect(c.nav.page).toBe("sound");
  expect(c.session.historyDepth).toBe(1);
  c.session.undo();
  expect(c.project).toEqual(before);
});
