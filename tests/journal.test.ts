import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectJournal, savePoints } from "../os/guest/journal.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { saveSong } from "../packages/core/src/project-io.ts";
import { extensibleProject } from "./project-extension-fixtures.ts";

const directories: string[] = [];
async function journal() {
  const directory = await mkdtemp(join(tmpdir(), "xmp-journal-"));
  directories.push(directory);
  return new ProjectJournal(directory);
}
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
describe("committed project recovery", () => {
  it("saves the shared version-2 song and retains unknown feature and machine state", async () => {
    const store = await journal(),
      project = extensibleProject();
    await store.commit(project);
    const text = await readFile(join(store.directory, "project.xmp.json"), "utf8");
    expect(text).toBe(await saveSong(project));
    expect(JSON.parse(text).version).toBe(2);
    expect((await store.inspect()).project).toEqual(project);
  });
  it("preserves an incompatible primary rather than recovering over it from an older snapshot", async () => {
    const store = await journal(),
      project = extensibleProject();
    await store.commit(project);
    await store.commit({ ...project, name: "Second" });
    const future = JSON.stringify({ ...project, version: 9 });
    await writeFile(join(store.directory, "project.xmp.json"), future);
    const state = await store.inspect();
    expect(state.project).toBeNull();
    expect(state.report.compatibilityError).toContain("Unsupported project version");
    await expect(store.commit(project)).rejects.toThrow("preserved");
    expect(await readFile(join(store.directory, "project.xmp.json"), "utf8")).toBe(future);
  });
  it("keeps a validated previous generation and records every durability boundary", async () => {
    const store = await journal(),
      project = createDemoProject();
    const old = await store.commit(project);
    project.name = "Next committed generation";
    const points: string[] = [];
    const next = await store.commit(project, async (point) => {
      points.push(point);
    });
    expect(points).toEqual([...savePoints]);
    const loaded = await store.inspect();
    expect(loaded.project?.name).toBe(project.name);
    expect(loaded.report.candidates[0]?.sha256).toBe(next);
    expect(loaded.report.candidates[1]?.sha256).toBe(old);
  });
  it("recovers the old committed generation when a save stops before publication", async () => {
    const store = await journal(),
      project = createDemoProject();
    const old = await store.commit(project);
    project.name = "Uncommitted edit";
    await expect(
      store.commit(project, async (point) => {
        if (point === "pending-fsynced") throw new Error("fixture interruption");
      }),
    ).rejects.toThrow();
    const loaded = await store.inspect();
    expect(loaded.report.candidates[0]?.sha256).toBe(old);
    expect(loaded.project?.name).not.toBe(project.name);
    expect(loaded.report.candidates[2]?.exists).toBe(true);
  });
  it("opens a valid previous generation read-only and preserves a corrupt primary", async () => {
    const store = await journal(),
      project = createDemoProject();
    await store.commit(project);
    project.name = "Second";
    await store.commit(project);
    store.corruptFixture(false);
    const original = await readFile(join(store.directory, "project.xmp.json"));
    const loaded = await store.inspect();
    expect(loaded.project).not.toBeNull();
    expect(loaded.report.readOnly).toBe(true);
    await expect(store.commit(project)).rejects.toThrow(/preserved/);
    expect(await readFile(join(store.directory, "project.xmp.json"))).toEqual(original);
  });
  it("never replaces wholly invalid recovery files with a default project", async () => {
    const store = await journal();
    store.corruptFixture(true);
    const before = await store.inspect();
    expect(before.project).toBeNull();
    expect(before.report.empty).toBe(false);
    expect(before.report.recoveryRequired).toBe(true);
    await expect(store.commit(createDemoProject())).rejects.toThrow(/preserved/);
    const exportResult = store.exportRecovery();
    expect(exportResult.files).toHaveLength(2);
    const exported = JSON.parse(
      await readFile(join(store.directory, "recovery-export.json"), "utf8"),
    );
    expect(Buffer.from(exported.files[0].base64, "base64").toString()).toContain("INVALID PRIMARY");
    expect((await store.inspect()).report.candidates).toEqual(before.report.candidates);
  });
  it("preserves a dangling primary symlink instead of creating a default song", async () => {
    const store = await journal();
    await symlink(join(store.directory, "missing"), join(store.directory, "project.xmp.json"));
    const state = await store.inspect();
    expect(state.report.empty).toBe(false);
    expect(state.report.recoveryRequired).toBe(true);
    await expect(store.commit(createDemoProject())).rejects.toThrow(/preserved/);
  });
  it("ignores an uncommitted pending file as a recovery candidate", async () => {
    const store = await journal();
    await writeFile(join(store.directory, "project.xmp.json.pending"), "uncommitted data");
    const state = await store.inspect();
    expect(state.report.empty).toBe(false);
    expect(state.report.recoveryRequired).toBe(true);
    expect(state.project).toBeNull();
  });
});
