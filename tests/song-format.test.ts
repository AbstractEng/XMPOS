import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Shared executable fixture.
import { songFixture } from "../acceptance/lib/portable-song-fixture.mjs";
import { SongFiles } from "../apps/studio/src/song-files.ts";
import {
  exportPortable,
  exportSong,
  hashSample,
  importPortable,
  inspectSong,
  MissingSongAssetsError,
} from "../packages/core/src/assets.ts";
import { loadCore, renderProjectScene } from "../packages/core/src/edits.ts";
import type { Project } from "../packages/core/src/index.ts";
import { ProjectSession } from "../packages/core/src/session.ts";

// Renders and files run in the C++ core (WebAssembly).
await loadCore();

afterEach(() => vi.unstubAllGlobals());
const fixture = (): { project: Project; wav: Buffer } => songFixture();
describe("portable song version 2", () => {
  it("matches fixed float32/float64 little-endian interchange vectors", async () => {
    for (const [value, encoding, chunk, hash] of [
      [
        1,
        "pcm-f32le",
        "AACAPw==",
        "61deb4deb19120f57491c61a1e86102035c9313ab7cb42827e8c3e46df9866a8",
      ],
      [
        0.1,
        "pcm-f64le",
        "mpmZmZmZuT8=",
        "1de5d7eb33c0f11480db42df1917b1385ee66f76765a020468e4d572b46b22fe",
      ],
    ] as const) {
      const { project } = fixture();
      project.samples.forEach((s) => {
        s.pcm = [value];
      });
      project.pads.forEach((p) => {
        delete p.slice;
      });
      const wire = JSON.parse(await exportSong(project));
      expect(wire.assets[0]).toMatchObject({
        encoding,
        chunks: [chunk],
        hash: `sha256-${hash}`,
        frames: 1,
        sampleRate: 48000,
      });
      expect(await importPortable(JSON.stringify(wire))).toEqual(project);
    }
  });
  it("packs lossless little-endian audio once and preserves musical state and unknown machines", async () => {
    const { project } = fixture(),
      text = await exportSong(project),
      wire = JSON.parse(text),
      opened = await importPortable(text);
    expect(wire.version).toBe(2);
    expect(wire.sampleMode).toBe("embedded");
    expect(wire.assets).toHaveLength(1);
    expect(wire.assets[0].encoding).toBe("pcm-f32le");
    expect(wire.project.samples[0].pcm).toBeUndefined();
    expect(opened).toEqual(project);
    expect(opened.tracks[2]?.machine).toEqual(project.tracks[2]?.machine);
    expect(new Uint8Array(renderProjectScene(opened, "scene-0"))).toEqual(
      new Uint8Array(renderProjectScene(project, "scene-0")),
    );
    expect(text.length).toBeLessThan((await exportPortable(project)).length * 0.75);
    expect(text).not.toMatch(/\/Users\/|\/Volumes\/|file:\/\//);
    // Renders a full scene twice to prove a bit-exact round trip; give it CPU headroom.
  }, 30_000);
  it("uses float64 only when float32 would change authored values and has stable hashes", async () => {
    const { project } = fixture();
    project.samples.forEach((s) => {
      s.pcm = [Math.PI / 8, 1e-30, 0];
    });
    project.pads.forEach((p) => {
      delete p.slice;
    });
    const text = await exportSong(project);
    expect(JSON.parse(text).assets[0].encoding).toBe("pcm-f64le");
    expect(await importPortable(text)).toEqual(project);
    expect(await exportSong(project)).toBe(text);
    expect(await hashSample(48000, [Math.PI / 8])).not.toBe(await hashSample(24000, [Math.PI / 8]));
  });
  it("can omit samples and resolves them by verified content rather than file names or paths", async () => {
    const { project } = fixture(),
      text = await exportSong(project, { packageSamples: false });
    expect(JSON.parse(text).assets).toEqual([]);
    expect((await inspectSong(text)).sampleMode).toBe("referenced");
    await expect(importPortable(text)).rejects.toBeInstanceOf(MissingSongAssetsError);
    let calls = 0;
    expect(
      await importPortable(text, {
        resolveAsset: async () => {
          calls++;
          return project.samples[0];
        },
      }),
    ).toEqual(project);
    expect(calls).toBe(1);
    await expect(
      importPortable(text, { resolveAsset: async () => ({ sampleRate: 48000, pcm: [0] }) }),
    ).rejects.toThrow("content does not match");
  });
  it("keeps legacy JSON and bundle files readable and refuses unsupported versions", async () => {
    const { project } = fixture();
    expect(await importPortable(JSON.stringify(project))).toEqual(project);
    expect(await importPortable(await exportPortable(project))).toEqual(project);
    const value = JSON.parse(await exportSong(project));
    value.version = 999;
    await expect(importPortable(JSON.stringify(value))).rejects.toThrow();
  });
  it("rejects noncanonical padding even when it decodes to the same PCM", async () => {
    const { project } = fixture();
    project.samples.forEach((s) => {
      s.pcm = [0];
    });
    project.pads.forEach((p) => {
      delete p.slice;
    });
    const value = JSON.parse(await exportSong(project));
    expect(value.assets[0].chunks[0]).toBe("AAAAAA==");
    value.assets[0].chunks[0] = "AAAAAB==";
    await expect(importPortable(JSON.stringify(value))).rejects.toThrow("Noncanonical");
  });
  it("rejects metadata/audio corruption, surplus assets, malformed chunks and declared amplification atomically", async () => {
    const { project } = fixture(),
      session = new ProjectSession(project),
      original = await exportSong(project);
    for (const mutate of [
      (v: ReturnType<typeof JSON.parse>) => {
        v.project.bpm = 121;
      },
      (v: ReturnType<typeof JSON.parse>) => {
        v.assets[0].chunks[0] =
          (v.assets[0].chunks[0][0] === "A" ? "B" : "A") + v.assets[0].chunks[0].slice(1);
      },
      (v: ReturnType<typeof JSON.parse>) => {
        v.assets.push(v.assets[0]);
      },
      (v: ReturnType<typeof JSON.parse>) => {
        v.assets = [];
      },
      (v: ReturnType<typeof JSON.parse>) => {
        v.assets[0].chunks = new Array(20000).fill("AAAA");
      },
      (v: ReturnType<typeof JSON.parse>) => {
        v.project.samples[0].frames = 480001;
      },
      (v: ReturnType<typeof JSON.parse>) => {
        v.project.samples[0].assetHash = "../sample.wav";
      },
    ]) {
      const value = JSON.parse(original);
      mutate(value);
      await expect(session.open(JSON.stringify(value))).rejects.toThrow();
      expect(session.project).toEqual(project);
      expect(session.revision).toBe(0);
    }
  });
  it("does not adopt a linked song if the user edits during asynchronous resolution", async () => {
    const { project } = fixture(),
      session = new ProjectSession(project),
      text = await exportSong(project, { packageSamples: false });
    let release: (v: Project["samples"][number] | undefined) => void = () => {};
    let begin = () => {};
    const started = new Promise<void>((resolve) => {
      begin = resolve;
    });
    const opening = session.open(text, {
      resolveAsset: () =>
        new Promise((r) => {
          release = r;
          begin();
        }),
    });
    await started;
    session.edit((p) => ({ ...p, name: "Newer edit" }));
    release(project.samples[0]);
    await expect(opening).rejects.toThrow("changed during import");
    expect(session.project.name).toBe("Newer edit");
  });
});
describe("browser song library and relinking", () => {
  it("does not replace a song edited while its missing audio was being located", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const { project, wav } = fixture();
    const other = structuredClone(project);
    other.samples.forEach((s) => {
      s.pcm = s.pcm.map(() => 0);
    });
    const io = new SongFiles(new ProjectSession(other));
    await expect(
      io.open(await exportSong(project, { packageSamples: false })),
    ).rejects.toBeInstanceOf(MissingSongAssetsError);
    io.session.edit((p) => ({ ...p, name: "Keep this later edit" }));
    await expect(io.relink([new File([new Uint8Array(wav)], "original.wav")])).rejects.toThrow(
      "changed",
    );
    expect(io.session.project.name).toBe("Keep this later edit");
    expect(io.missing).toEqual([]);
  });
  it("retains referenced assets across sessions and opens a packaged file with an empty library", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const { project } = fixture(),
      io = new SongFiles(new ProjectSession(project));
    io.packageSamples = false;
    const linked = await io.save();
    const other = structuredClone(project);
    other.samples.forEach((s) => {
      s.pcm = s.pcm.map(() => 0);
    });
    other.name = "Other song";
    const recipient = new SongFiles(new ProjectSession(other));
    await recipient.open(linked);
    expect(recipient.session.project).toEqual(project);
    vi.stubGlobal("indexedDB", new IDBFactory());
    const fresh = new SongFiles(new ProjectSession(other));
    await fresh.open(await exportSong(project));
    expect(fresh.session.project).toEqual(project);
  });
  it("keeps the current song until exact matching WAV audio is located, regardless of the file name", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const { project, wav } = fixture(),
      other = structuredClone(project);
    other.samples.forEach((s) => {
      s.pcm = s.pcm.map(() => 0);
    });
    other.name = "Keep me";
    const io = new SongFiles(new ProjectSession(other)),
      text = await exportSong(project, { packageSamples: false });
    await expect(io.open(text)).rejects.toBeInstanceOf(MissingSongAssetsError);
    expect(io.missing.length).toBe(1);
    const wrong = Buffer.from(wav);
    wrong[44] = (wrong[44] ?? 0) ^ 255;
    await expect(io.relink([new File([wrong], "Kick café.wav")])).rejects.toThrow("No matching");
    expect(io.session.project).toEqual(other);
    await io.relink([new File([new Uint8Array(wav)], "completely-renamed.wav")]);
    expect(io.session.project).toEqual(project);
    expect(io.missing).toEqual([]);
  });
});
