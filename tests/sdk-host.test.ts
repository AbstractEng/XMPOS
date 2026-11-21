import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { createDemoProject } from "../packages/core/src/index.ts";
import { buildPackage, canonical } from "../packages/sdk/src/community/package.ts";
import { bindCommunity } from "../packages/sdk/src/community/project.ts";
// @ts-expect-error Host tool is executable ESM.
import { openPackageStore } from "../tools/sdk/store.mjs";
// @ts-expect-error Host tool is executable ESM.
import { CommunityUiSupervisor } from "../tools/sdk/supervisor.mjs";
// @ts-expect-error Host tool is executable ESM.
import { template } from "../tools/sdk/template.mjs";

it("atomically upgrades package/project state and automation and rolls back the original snapshot", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmp-sdk-store-"));
  try {
    const t = await template(),
      pkg = await buildPackage(t.manifest, t.program, t.license),
      store = await openPackageStore(directory, { create: true });
    let saved = await store.install(pkg, 0);
    const initial = createDemoProject();
    initial.samples = [{ id: "s", name: "Fixture", sampleRate: 48000, pcm: [0.5, 0] }];
    for (const pad of initial.pads) pad.sampleId = "s";
    const p = await bindCommunity(initial, "drums", pkg),
      track = p.project.tracks[0];
    if (!track?.machine) throw Error("Missing bound track");
    track.machine.state.level = 0.7;
    p.project.parameters = [
      { id: "track.drums.machine.community.example-tone.v1.level", base: 0.7 },
    ];
    saved = await store.setProject(p, saved.generation);
    const before = canonical(saved.active);
    t.manifest.version = "1.1.0";
    t.manifest.stateVersion = 2;
    t.manifest.parameters[0].id = "gain";
    t.program.gain = { parameter: "gain" };
    t.program.migrations = [{ from: 1, to: 2, renames: { level: "gain" } }];
    const upgrade = await buildPackage(t.manifest, t.program, t.license);
    saved = await store.install(upgrade, saved.generation);
    expect(saved.active.project.project.tracks[0].machine.state.gain).toBe(0.7);
    expect(saved.active.project.project.parameters[0].id).toContain(".v2.gain");
    saved = await store.rollback(saved.generation);
    expect(canonical(saved.active)).toBe(before);
    expect((await openPackageStore(directory)).root).toBe(store.root);
    await expect(store.install(upgrade, saved.generation - 1)).rejects.toThrow("Stale");
    const bytes = await readFile(join(directory, "state.json"));
    await expect(
      store.install(upgrade, saved.generation, async () => {
        throw Error("ENOSPC");
      }),
    ).rejects.toThrow("ENOSPC");
    expect(await readFile(join(directory, "state.json"))).toEqual(bytes);
    expect(
      (await readdir(directory)).some((p) => p.endsWith(".partial") || p.includes("lock")),
    ).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("rejects symlink stores, tampering and incompatible unit upgrades before changing any file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmp-sdk-invalid-"));
  try {
    const root = join(directory, "store"),
      store = await openPackageStore(root, { create: true }),
      t = await template(),
      pkg = await buildPackage(t.manifest, t.program, t.license);
    const current = await store.install(pkg, 0);
    const before = await readFile(join(root, "state.json"));
    const corrupt = structuredClone(pkg);
    if (corrupt.files[0]) corrupt.files[0].content += "tampered";
    await expect(store.install(corrupt, current.generation)).rejects.toThrow("Integrity");
    expect(await readFile(join(root, "state.json"))).toEqual(before);
    t.manifest.version = "1.1.0";
    t.manifest.parameters[0].max = 0.5;
    const incompatible = await buildPackage(t.manifest, t.program, t.license);
    await expect(store.install(incompatible, current.generation)).rejects.toThrow("range/unit");
    const link = join(directory, "linked");
    await symlink(root, link);
    await expect(openPackageStore(link)).rejects.toThrow("real directory");
    const sentinel = join(directory, "outside");
    await writeFile(sentinel, "untouched");
    await rm(join(root, "state.json"));
    await symlink(sentinel, join(root, "state.json"));
    await expect(openPackageStore(root)).rejects.toThrow("store file");
    expect(await readFile(sentinel, "utf8")).toBe("untouched");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
it("runs the clean developer instrument/effect quickstart with real package and WAV outputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "xmp-sdk-cli-"));
  try {
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [resolve("tools/sdk/cli.mjs"), ...args], {
        encoding: "utf8",
      });
      expect(r.status, r.stderr).toBe(0);
      return JSON.parse(r.stdout);
    };
    for (const kind of ["instrument", "effect"]) {
      const folder = join(directory, kind),
        pkg = join(directory, `${kind}.xmpkg`),
        wav = join(directory, `${kind}.wav`);
      run("new", kind, `test-${kind}`, folder);
      run("build", folder, pkg);
      expect(run("test", pkg).passed).toBe(true);
      expect(run("preview", pkg, wav).physicalAccess).toBe(false);
      const bytes = await readFile(wav);
      expect(bytes.toString("ascii", 0, 4)).toBe("RIFF");
      expect(bytes.readUInt32LE(24)).toBe(48000);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
it("supervises an actual UI child with denied writes/spawns and restores only acknowledged state", async () => {
  const t = await template(),
    supervisor = new CommunityUiSupervisor(t.manifest, { level: 0.25, cutoff: 8000 }),
    directory = await mkdtemp(join(tmpdir(), "xmp-ui-permissions-"));
  try {
    await supervisor.open();
    const pid = supervisor.pid;
    expect(pid).not.toBe(process.pid);
    await supervisor.set("level", 0.7);
    const saved = supervisor.snapshot;
    expect(await supervisor.permissionProbe(join(directory, "forbidden"))).toEqual({
      writeDenied: true,
      spawnDenied: true,
    });
    expect(await readdir(directory)).toEqual([]);
    await expect(supervisor.set("device-write", 1)).rejects.toThrow("denied");
    await supervisor.injectCrash();
    expect(supervisor.faults[0].nativeHostFault).toBe(false);
    await supervisor.open();
    expect(supervisor.pid).not.toBe(pid);
    expect(supervisor.snapshot).toEqual(saved);
  } finally {
    await supervisor.close();
    await rm(directory, { recursive: true, force: true });
  }
});
