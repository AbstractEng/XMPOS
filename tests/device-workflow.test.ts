// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { DeviceController, deviceDemo } from "../apps/studio/src/device/controller.ts";
import { liveMk1 } from "../apps/studio/src/device/live-mk1.ts";
import { padOrder, panelButtons, slotCoordinates } from "../apps/studio/src/device/navigation.ts";
import { renderDevice } from "../apps/studio/src/device/view.ts";
import { ControlActionSchema } from "../packages/core/src/control-actions.ts";
import { encodeWav } from "../packages/core/src/index.ts";
import { resizeClip } from "../packages/core/src/sequencer.ts";
import { ContractAudio } from "./helpers/device-audio.ts";

const fixture = () => {
  const audio = new ContractAudio();
  return { audio, c: new DeviceController(deviceDemo(), audio) };
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("maps the Live Mk1 switches to validated shared actions and keeps pad 1 bottom left", async () => {
  const { c, audio } = fixture();
  for (const button of panelButtons)
    for (const shift of [false, true])
      expect(ControlActionSchema.safeParse(liveMk1.resolve(button, shift, "clips")).success).toBe(
        true,
      );
  document.body.innerHTML = renderDevice(c);
  expect(
    [...document.querySelectorAll("[data-panel]")]
      .map((b) => (b as HTMLElement).dataset.panel)
      .sort(),
  ).toEqual([...panelButtons].sort());
  expect(document.querySelectorAll("[data-panel]")).toHaveLength(22);
  const pads = [...document.querySelectorAll<HTMLElement>("[data-pad]")].map((b) =>
    Number(b.dataset.pad),
  );
  expect(pads).toEqual([12, 13, 14, 15, 8, 9, 10, 11, 4, 5, 6, 7, 0, 1, 2, 3]);
  expect(pads[12]).toBe(0);
  expect(slotCoordinates(0, 0)).toEqual({ track: 0, scene: 3 });
  expect(slotCoordinates(0, 12)).toEqual({ track: 0, scene: 0 });
  const slots = Array.from({ length: 8 }, (_, bank) =>
    padOrder.map((pad) => JSON.stringify(slotCoordinates(bank, pad))),
  ).flat();
  expect(new Set(slots).size).toBe(128);
  expect(document.querySelector("#device-screen")?.getAttribute("data-logical-height")).toBe("800");
  await c.button("menu", true);
  expect(c.nav.page).toBe("library");
  await c.button("main", true);
  expect(c.nav.page).toBe("play");
  await c.button("menu");
  await c.dispatch({ type: "focus", delta: 5 });
  await c.dispatch({ type: "activate" });
  expect(c.nav.page).toBe("song");
  await c.button("main");
  expect(c.nav.page).toBe("clips");
  expect(c.session.historyDepth).toBe(0);
  expect(audio.enabled).toBe(0);
  await c.button("bank-d", true);
  expect(c.trackId).toBe(c.project.tracks[7]?.id);
  expect(c.sceneId).toBe(c.project.scenes[0]?.id);
  const project = c.project;
  await c.dispatch({ type: "parameter", index: 20, value: 1 });
  expect(c.project).toBe(project);
});

it("creates and copies independent C-major loops without a confirmation detour", async () => {
  const { c } = fixture();
  c.select(13);
  c.setMachine("xmp.subtractive");
  c.nav.pad = 3;
  c.createClip();
  await c.pad(12);
  expect(c.clip?.steps).toContainEqual(expect.objectContaining({ step: 0, pad: 3, note: 53 }));
  c.edit((p) => resizeClip(p, c.trackId, c.clip?.id ?? "", 32));
  c.step = 16;
  await c.pad(12);
  expect(c.clip?.steps).toContainEqual(expect.objectContaining({ step: 16, note: 53 }));
  const before = c.project;
  await c.button("copy");
  await c.pad(9);
  expect(c.pending).toBeUndefined();
  expect(c.clip?.steps).toHaveLength(2);
  expect(c.track.machine?.id).toBe("xmp.subtractive");
  await c.button("undo");
  expect(c.project).toEqual(before);
  await c.button("undo", true);
  expect(c.clip?.steps).toHaveLength(2);
});

it("queues independent clip changes and empty stops on the next bar", async () => {
  const { c, audio } = fixture();
  await c.button("play-start");
  audio.advance(3);
  const bassAnchor = audio.transport?.slots.get(c.project.tracks[1]?.id ?? "")?.anchor;
  const first = c.trackId;
  await c.pad(8); // second scene, first track
  audio.advance(15);
  expect(audio.transport?.slots.get(first)?.clipId).toBe(c.project.scenes[0]?.clips[first]);
  audio.advance(16);
  expect(audio.transport?.slots.get(first)?.clipId).toBe(c.project.scenes[1]?.clips[first]);
  expect(audio.transport?.slots.get(c.project.tracks[1]?.id ?? "")?.anchor).toBe(bassAnchor);
  await c.pad(9); // empty second-track slot
  audio.advance(31);
  expect(audio.transport?.slots.get(c.trackId)?.clipId).toBeDefined();
  audio.advance(32);
  expect(audio.transport?.slots.get(c.trackId)?.clipId).toBeUndefined();
  await c.button("stop");
  expect(audio.playing).toBe(false);
  expect(audio.transport?.queuedClips.size).toBe(0);
});

it("indexes an entire selected folder without reading PCM until one sample is loaded", async () => {
  const { c } = fixture();
  const bytes = new Uint8Array(encodeWav([Float32Array.from([0, 0.5, -0.5, 0])], 48000));
  const reads = vi.fn(async () => bytes.buffer);
  const files = Array.from({ length: 40 }, (_, i) => ({
    name: `Hit ${i}.wav`,
    size: bytes.length,
    webkitRelativePath: `Library/Drums/Hit ${i}.wav`,
    arrayBuffer: reads,
  }));
  expect(c.library.addFolder(files)).toBe(40);
  expect(reads).not.toHaveBeenCalled();
  c.query = "Hit 39";
  expect(c.samples).toHaveLength(1);
  const before = c.project;
  await c.assignSample(c.samples[0]?.id ?? "");
  expect(reads).toHaveBeenCalledTimes(1);
  expect(c.track.pads?.[0]?.name).toBe("Hit 39");
  expect(c.project.pads).toEqual(before.pads);
  expect(c.project.tracks.slice(1)).toEqual(before.tracks.slice(1));
  expect(c.project.scenes).toEqual(before.scenes);
  await c.button("undo");
  expect(c.project).toEqual(before);
});

it("rejects stale sample loads and canceled auditions after changing context", async () => {
  const { c, audio } = fixture();
  let release: (value: {
    name: string;
    sampleRate: number;
    pcm: Float32Array<ArrayBuffer>;
  }) => void = () => {};
  const result = new Promise<{ name: string; sampleRate: number; pcm: Float32Array<ArrayBuffer> }>(
    (resolve) => {
      release = resolve;
    },
  );
  vi.spyOn(c.library, "decode").mockReturnValue(result);
  c.show("library");
  const assign = c.assignSample(c.samples[0]?.id ?? "");
  const preview = c.preview();
  c.nav.pad = 1;
  await c.button("main");
  const before = c.project;
  release({ name: "Late sound", sampleRate: 48000, pcm: Float32Array.from([0.5, 0]) });
  await Promise.all([assign, preview]);
  expect(c.project).toBe(before);
  expect(audio.auditions).toBe(0);
  expect(c.session.historyDepth).toBe(0);
});

it("STOP cancels a delayed audio start and REC commits one undoable pitched take", async () => {
  const { c, audio } = fixture();
  let release = () => {};
  vi.spyOn(audio, "enable").mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const pending = c.button("play");
  await c.button("stop");
  release();
  await pending;
  expect(audio.starts).toBe(0);
  c.select(13);
  c.setMachine("xmp.subtractive");
  await c.button("rec");
  await c.pad(1); // audition while armed must not enter take
  await c.button("play-start");
  const before = c.project;
  audio.advance(2);
  await c.pad(1);
  audio.advance(6);
  await c.pad(2);
  await c.button("stop");
  expect(c.clip?.steps).toHaveLength(2);
  expect(c.clip?.steps.map((s) => [s.step, s.note])).toEqual([
    [2, 50],
    [6, 52],
  ]);
  expect(c.record).toBe(false);
  expect(c.overdub).toBe(false);
  await c.button("undo");
  expect(c.project).toEqual(before);
  await c.button("rec");
  await c.button("play-start");
  audio.advance(1);
  await c.pad(3);
  c.show("sound"); // finish before choosing another destination
  expect(c.record).toBe(false);
  expect(c.clip?.steps).toHaveLength(1);
  const captured = c.project;
  c.trackId = c.project.tracks[2]?.id ?? "";
  c.show("play");
  await c.pad(4);
  await c.button("stop");
  expect(c.project).toBe(captured);
});

it("lights one panel LED for the active Q-Link page", async () => {
  const { c } = fixture();
  const expectPage = (number: number) => {
    document.body.innerHTML = renderDevice(c);
    const leds = document.querySelector(".q-link-leds");
    expect(leds?.getAttribute("aria-label")).toBe(`Q-Link page ${number}`);
    expect(Array.from(leds?.children ?? [], (led) => led.classList.contains("lit"))).toEqual(
      [1, 2, 3, 4].map((page) => page === number),
    );
  };
  expectPage(1);
  await c.button("q-link");
  expectPage(2);
  await c.button("q-link");
  expectPage(1);
  c.show("steps");
  for (const page of [2, 3, 4, 1]) {
    await c.button("q-link");
    expectPage(page);
  }
  await c.button("q-link", true);
  expectPage(4);
  c.show("clips");
  expectPage(2);
});

it("uses machine metadata for Q-Links and preserves unavailable machine state", async () => {
  const { c } = fixture();
  c.select(13);
  c.setMachine("xmp.subtractive");
  const drums = c.project.tracks[0];
  await c.button("q-link");
  await c.dispatch({ type: "parameter", index: 0, value: 1 });
  expect(c.track.machine?.state.cutoff).toBe(16000);
  expect(c.project.tracks[0]).toEqual(drums);
  c.edit((p) => {
    const t = p.tracks[1];
    if (t)
      t.machine = { id: "third.party", base: "audio", version: 1, state: { opaque: [1, 2, 3] } };
    return p;
  });
  const before = c.project;
  await c.dispatch({ type: "parameter", index: 0, value: 0 });
  expect(c.project).toBe(before);
  c.show("track");
  expect(renderDevice(c)).toContain("third.party");
});

it("keeps the highlighted clip aligned with track and scene selection from other pages", async () => {
  const { c } = fixture();
  c.show("track");
  c.trackId = c.project.tracks[5]?.id ?? "";
  c.sceneId = c.project.scenes[9]?.id ?? "";
  await c.button("main");
  expect(slotCoordinates(c.nav.bank, c.nav.cursor)).toEqual({ track: 5, scene: 9 });
  const drums = c.project.tracks[0];
  await c.dispatch({ type: "activate" });
  c.stepPress(0);
  expect(c.project.scenes[9]?.clips[c.trackId]).toBe(c.clip?.id);
  expect(c.project.tracks[0]).toEqual(drums);
  expect(c.clip?.steps).toHaveLength(1);
});

it("16 LEVEL opens Steps without changing the clip", async () => {
  const { c } = fixture();
  const before = c.project;
  await c.button("16-level");
  expect(c.nav.page).toBe("steps");
  expect(c.project).toBe(before);
});

it("overdubs the audible clip during playback and finishes with one undoable edit", async () => {
  const { c, audio } = fixture();
  const track = c.trackId;
  const originalClip = c.clip?.id;
  await c.button("play-start");
  audio.advance(3);
  await c.pad(8); // another clip is selected and queued, but is not audible yet
  const before = c.project;
  const selected = c.clip;
  await c.button("overdub");
  expect(c.record).toBe(true);
  expect(audio.starts).toBe(1);
  audio.advance(5);
  await c.pad(7);
  await c.button("overdub");
  expect(c.record).toBe(false);
  expect(audio.playing).toBe(true);
  expect(
    c.project.tracks.find((t) => t.id === track)?.clips.find((clip) => clip.id === originalClip)
      ?.steps,
  ).toContainEqual(expect.objectContaining({ step: 5, pad: 7 }));
  expect(
    c.project.tracks.find((t) => t.id === track)?.clips.find((clip) => clip.id === selected?.id),
  ).toEqual(selected);
  await c.button("undo");
  expect(c.project).toEqual(before);
});

it("records local clip time after a launch and preserves hits when REC ends a live overdub", async () => {
  const { c, audio } = fixture();
  await c.button("play-start");
  audio.advance(3);
  await c.pad(8);
  audio.advance(16);
  await c.button("overdub");
  audio.advance(18);
  await c.pad(6);
  await c.button("rec");
  expect(c.record).toBe(false);
  expect(audio.playing).toBe(true);
  expect(c.clip?.steps).toContainEqual(expect.objectContaining({ step: 2, pad: 6 }));
});

it("copying onto a reused slot leaves the source and other scenes' clips unchanged", async () => {
  const { c } = fixture();
  c.edit((p) => {
    const scene = p.scenes[2];
    if (scene) scene.clips[c.trackId] = p.scenes[1]?.clips[c.trackId] ?? "";
    return p;
  });
  const before = c.project;
  const reused = c.track.clips.find((clip) => clip.id === before.scenes[1]?.clips[c.trackId]);
  await c.button("copy");
  await c.pad(8);
  c.confirm();
  expect(c.clip?.id).not.toBe(reused?.id);
  expect(c.project.scenes[2]?.clips[c.trackId]).toBe(reused?.id);
  expect(c.track.clips.find((clip) => clip.id === reused?.id)).toEqual(reused);
  expect(c.clip?.steps).toEqual(before.tracks[0]?.clips[0]?.steps);
  await c.button("undo");
  expect(c.project).toEqual(before);
});

it("refuses a copy into a full track without overwriting a clip or adding history", async () => {
  const { c } = fixture();
  c.edit((p) => {
    const track = p.tracks[0];
    if (track)
      while (track.clips.length < 16)
        track.clips.push({ id: `full-${track.clips.length}`, name: "Kept", length: 16, steps: [] });
    return p;
  });
  const before = c.project;
  const depth = c.session.historyDepth;
  await c.button("copy");
  await c.pad(8);
  expect(c.message).toContain("sixteen clips");
  expect(c.project).toBe(before);
  expect(c.session.historyDepth).toBe(depth);
});

it("finishes the old overdub when its audible clip changes and never adds hits to the next clip", async () => {
  const { c, audio } = fixture();
  const track = c.trackId;
  const original = c.clip?.id;
  await c.button("play-start");
  await c.button("overdub");
  audio.advance(2);
  await c.pad(6);
  audio.queueClip(track, c.project.scenes[1]?.clips[track] ?? null);
  audio.advance(16);
  const next = c.track.clips.find((clip) => clip.id === c.project.scenes[1]?.clips[track]);
  await c.pad(7);
  expect(c.record).toBe(false);
  expect(c.track.clips.find((clip) => clip.id === original)?.steps).toContainEqual(
    expect.objectContaining({ step: 2, pad: 6 }),
  );
  expect(c.track.clips.find((clip) => clip.id === next?.id)).toEqual(next);
});

it("keeps an overdub when the same drum cell is played repeatedly", async () => {
  const { c, audio } = fixture();
  await c.button("play-start");
  const before = c.project;
  await c.button("overdub");
  audio.advance(0);
  await c.pad(0);
  await c.pad(0);
  audio.advance(1);
  await c.pad(6);
  await c.button("stop");
  expect(c.clip?.steps.filter((s) => s.step === 0 && s.pad === 0)).toHaveLength(1);
  expect(c.clip?.steps).toContainEqual(expect.objectContaining({ step: 1, pad: 6 }));
  await c.button("undo");
  expect(c.project).toEqual(before);
});

it("restarting a stopped recording uses the new clip origin instead of the previous launch", async () => {
  const { c, audio } = fixture();
  c.select(8);
  c.edit((p) => resizeClip(p, c.trackId, c.clip?.id ?? "", 32));
  c.select(12);
  await c.button("play-start");
  audio.advance(3);
  await c.pad(8);
  audio.advance(16);
  await c.button("stop");
  await c.button("rec");
  await c.button("play-start");
  audio.advance(2);
  await c.pad(6);
  await c.button("stop");
  expect(c.clip?.steps).toContainEqual(expect.objectContaining({ step: 2, pad: 6 }));
});
