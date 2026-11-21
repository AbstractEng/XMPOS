import { describe, expect, it } from "vitest";
import { chopSampleToKit, expandSong } from "../packages/core/src/edits.ts";
import { openProject, saveSong } from "../packages/core/src/project-io.ts";
import { ProjectSession } from "../packages/core/src/session.ts";
import { extensibleProject } from "./project-extension-fixtures.ts";

describe("chop to drum kit", () => {
  it("creates playable independent one-shot slices, silences unused pads and persists as one undoable edit", async () => {
    const original = expandSong(extensibleProject()),
      session = new ProjectSession(original, true);
    const pcm = new Float32Array([0.25, 0.5, -0.25, -0.5]);
    session.edit((project) =>
      chopSampleToKit(project, "drums", "Chopped take", 48000, pcm, [0, 1, 4]),
    );
    const edited = session.project,
      kit = edited.tracks[0]?.pads;
    expect(kit?.[0]?.slice).toEqual({ start: 0, end: 1 });
    expect(kit?.[1]?.slice).toEqual({ start: 1, end: 4 });
    expect(kit?.[0]?.playback?.mode).toBe("one-shot");
    expect(kit?.[1]?.sampleId).toBe(kit?.[0]?.sampleId);
    const empty = edited.samples.find((s) => s.id === kit?.[2]?.sampleId);
    expect(empty?.pcm).toEqual([0]);
    expect(edited.tracks.slice(1)).toEqual(original.tracks.slice(1));
    expect(edited.extensions).toEqual(original.extensions);
    expect(await openProject(await saveSong(edited))).toEqual(edited);
    expect(session.historyDepth).toBe(1);
    expect(session.undo()).toBe(true);
    expect(session.project).toEqual(original);
  });
  it("rejects invalid chop boundaries without changing the song", () => {
    const project = extensibleProject(),
      before = JSON.stringify(project);
    expect(() => chopSampleToKit(project, "drums", "Bad", 48000, [0.25, 0], [0, 2, 1])).toThrow();
    expect(JSON.stringify(project)).toBe(before);
  });
});
