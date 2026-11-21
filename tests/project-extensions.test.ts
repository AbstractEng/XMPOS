import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  exportPortable,
  exportSong,
  importPortable,
  inspectSong,
} from "../packages/core/src/assets.ts";
import { installSample, toggleStep } from "../packages/core/src/edits.ts";
import { ProjectSchema, parseProject } from "../packages/core/src/index.ts";
import { preservedProjectExtensions } from "../packages/core/src/project-extensions.ts";
import { openProject, saveBundle, saveSong } from "../packages/core/src/project-io.ts";
import { ProjectSession } from "../packages/core/src/session.ts";
import { extensibleProject, invalidProjectExtensions } from "./project-extension-fixtures.ts";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

describe("forward-compatible project extensions", () => {
  it("preserves future feature data, unavailable machine versions, automation and assets in every file form", async () => {
    const project = extensibleProject();
    expect(await saveSong(project)).toBe(await exportSong(project));
    expect(await saveBundle(project)).toBe(await exportPortable(project));
    for (const text of [
      JSON.stringify(project),
      await saveBundle(project),
      await saveSong(project),
    ]) {
      expect(await openProject(text)).toEqual(project);
      expect(await importPortable(text)).toEqual(project);
    }
    expect(parseProject(JSON.stringify(project))).toEqual(project);
    expect((await inspectSong(await saveSong(project))).preservedExtensions).toEqual(
      preservedProjectExtensions(project),
    );
  });

  it("keeps opaque data through native edits, undo/redo and referenced saves", async () => {
    const project = extensibleProject(),
      session = new ProjectSession(project, true);
    session.edit((p) => toggleStep(p, "drums", "clip-0", 0, 3));
    expect(session.project.extensions).toEqual(project.extensions);
    expect(session.undo()).toBe(true);
    expect(session.project).toEqual(project);
    expect(session.redo()).toBe(true);
    const edited = session.project;
    const text = await saveSong(edited, { packageSamples: false });
    expect(text).toBe(await exportSong(edited, { packageSamples: false }));
    const resolveAsset = async (sample: { id: string }) =>
      project.samples.find((s) => s.id === sample.id);
    expect(await openProject(text, { resolveAsset })).toEqual(edited);
    expect(await importPortable(text, { resolveAsset })).toEqual(edited);
    expect((await openProject(await saveSong(edited))).extensions).toEqual(project.extensions);
  });

  it("checksums extension data and refuses unsupported required semantics before resolver I/O or session replacement", async () => {
    const project = extensibleProject(),
      session = new ProjectSession(project, true);
    const wire = JSON.parse(await saveSong(project, { packageSamples: false }));
    wire.project.extensions["com.example.motion"].required = true;
    wire.projectHash = `sha256-${createHash("sha256").update(canonical(wire.project)).digest("hex")}`;
    const resolveAsset = vi.fn(async () => project.samples[0]);
    for (const open of [openProject, importPortable])
      await expect(open(JSON.stringify(wire), { resolveAsset })).rejects.toThrow(
        "Required project extension",
      );
    await expect(session.open(JSON.stringify(wire), { resolveAsset })).rejects.toThrow(
      "com.example.motion v7",
    );
    expect(resolveAsset).not.toHaveBeenCalled();
    expect(session.project).toEqual(project);
    expect(session.dirty).toBe(false);
    expect(session.historyDepth).toBe(0);
    const corrupt = JSON.parse(await saveSong(project));
    corrupt.project.extensions["xmp.workspace"].data.label = "Changed";
    for (const open of [openProject, importPortable])
      await expect(open(JSON.stringify(corrupt))).rejects.toThrow("Corrupt song metadata");
  });

  it("enforces bounded plain JSON and descriptor shape in TypeScript and Wasm", async () => {
    const project = extensibleProject();
    for (const extensions of invalidProjectExtensions()) {
      const input = { ...project, extensions };
      expect(ProjectSchema.safeParse(input).success).toBe(false);
      for (const open of [openProject, importPortable])
        await expect(open(JSON.stringify(input))).rejects.toThrow();
    }
    for (const value of [undefined, NaN, Infinity, 1n, () => {}, new Date(), new Array(2)])
      expect(
        ProjectSchema.safeParse({
          ...project,
          extensions: {
            "com.example": { version: 1, data: { value } },
          },
        }).success,
      ).toBe(false);
  });

  it("keeps incompatible core changes and unnamespaced fields explicit", async () => {
    const project = extensibleProject();
    await expect(openProject(JSON.stringify({ ...project, version: 9 }))).rejects.toThrow(
      "Unsupported project version",
    );
    await expect(
      openProject(JSON.stringify({ ...project, futureCoreField: true })),
    ).rejects.toThrow();
  });
  it("retains sounds referenced only by opaque state when a pad sample is replaced", async () => {
    const project = extensibleProject();
    const edited = installSample(
      project,
      0,
      "New sound",
      48000,
      new Float32Array([0.125, 0]),
      "drums",
    );
    for (const old of project.samples)
      expect(edited.samples.find((s) => s.id === old.id)).toEqual(old);
    expect((await openProject(await saveSong(edited))).extensions).toEqual(project.extensions);
  });
});
