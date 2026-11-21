import { describe, expect, it } from "vitest";
import {
  exportPortable,
  exportSong,
  hashSample,
  importPortable,
  MissingSongAssetsError,
  type SongAsset,
  type SongSample,
} from "../packages/core/src/assets.ts";
import { createDemoProject, type Project, ProjectSchema } from "../packages/core/src/index.ts";
import { openProject, saveBundle, saveSong } from "../packages/core/src/project-io.ts";
import { performedProject, richProject, rng } from "./project-fixtures.ts";

// The browser's project files through the C++ core in WebAssembly
// (packages/core/src/project-io.ts) against the TypeScript it replaces:
// the same projects opened, the same refusals, byte-identical files saved,
// and the same handling of songs saved without their samples.

// Smaller samples keep the test quick; some float32-exact (saved as f32), some not (f64).
function small(p: Project, r: () => number): Project {
  const next = structuredClone(p);
  next.samples = next.samples.map((s, i) => ({
    ...s,
    pcm: s.pcm
      .slice(0, 40 + Math.floor(r() * 200))
      .map((v) => (i % 2 ? Math.fround(v) : v + 1e-12 * (v > 0 ? -1 : 1))),
  }));
  for (const pad of next.pads) delete pad.slice;
  return ProjectSchema.parse(next);
}
function projects(): Project[] {
  const out: Project[] = [];
  for (let seed = 1; seed <= 9; seed++) {
    const r = rng(seed * 104729);
    out.push(
      small(
        seed % 3 === 0
          ? richProject(r)
          : seed % 3 === 1
            ? performedProject(seed)
            : createDemoProject(),
        r,
      ),
    );
  }
  return out;
}
// One random change to a file's text.
function damage(text: string, r: () => number): string {
  const roll = r();
  if (roll < 0.2) return text.replace(/"version":(\d)/, (_m, v) => `"version":${Number(v) + 2}`);
  if (roll < 0.4) {
    const at = text.indexOf("sha256-");
    if (at >= 0) {
      const i = at + 7 + Math.floor(r() * 64);
      return text.slice(0, i) + (text[i] === "a" ? "b" : "a") + text.slice(i + 1);
    }
  }
  if (roll < 0.6) return text.replace('"sampleMode":"embedded"', '"sampleMode":"referenced"');
  if (roll < 0.8) return text.replace(/"bpm":\d+/, '"bpm":999');
  return `${text.slice(0, Math.floor(text.length / 2))}`;
}
const outcome = async (open: () => Promise<Project>) => {
  try {
    return { ok: true as const, text: JSON.stringify(await open()) };
  } catch (error) {
    const e = error as Error;
    return { ok: false as const, error: e };
  }
};

function linkedProject(name: string, amplitude: number): Project {
  const project = createDemoProject();
  project.name = name;
  project.samples = [
    { id: "first", name: "First", sampleRate: 48000, pcm: [amplitude, 0] },
    { id: "second", name: "Second", sampleRate: 48000, pcm: [-amplitude, 0] },
  ];
  project.pads.forEach((pad, i) => {
    pad.sampleId = i % 2 ? "second" : "first";
    delete pad.slice;
  });
  return ProjectSchema.parse(project);
}

function signal() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function pausedImport(project: Project) {
  const text = await saveSong(project, { packageSamples: false });
  const waiting = signal(),
    resume = signal();
  const opened = outcome(() =>
    openProject(text, {
      resolveAsset: async (sample) => {
        if (sample.id === "second") {
          waiting.resolve();
          await resume.promise;
        }
        return project.samples.find((s) => s.id === sample.id);
      },
    }),
  );
  await waiting.promise;
  return { opened, resume: resume.resolve };
}

describe("isolated asynchronous song imports", () => {
  it("keeps resolved audio while another project opens without waiting for the first import", async () => {
    const project = linkedProject("Waiting song", 0.25);
    const pending = await pausedImport(project);
    const other = linkedProject("Other song", 0.5);
    expect(await openProject(JSON.stringify(other))).toEqual(other);
    pending.resume();
    expect(await pending.opened).toEqual({ ok: true, text: JSON.stringify(project) });
  });

  it("opens overlapping referenced songs with their own complete audio", async () => {
    const a = linkedProject("Song A", 0.125),
      b = linkedProject("Song B", 0.5);
    const first = await pausedImport(a),
      second = await pausedImport(b);
    first.resume();
    const openedA = await first.opened;
    second.resume();
    const openedB = await second.opened;
    expect(openedA).toEqual({ ok: true, text: JSON.stringify(a) });
    expect(openedB).toEqual({ ok: true, text: JSON.stringify(b) });
  });

  it("allows a resolver to open another project without losing earlier samples", async () => {
    const project = linkedProject("Linked song", 0.25);
    const other = linkedProject("Resolver preview", 0.5);
    const text = await saveSong(project, { packageSamples: false });
    expect(
      await openProject(text, {
        resolveAsset: async (sample): Promise<SongAsset | undefined> => {
          expect(await openProject(JSON.stringify(other))).toEqual(other);
          return project.samples.find((s) => s.id === sample.id);
        },
      }),
    ).toEqual(project);
  });

  it("snapshots resolved typed-array audio before the next resolver reuses its buffer", async () => {
    const project = linkedProject("Linked song", 0.25);
    const text = await saveSong(project, { packageSamples: false });
    const pcm = new Float32Array([0.25, 0]);
    expect(
      await openProject(text, {
        resolveAsset: async (sample) => {
          if (sample.id === "first") return { sampleRate: 48000, pcm };
          pcm.fill(0);
          return project.samples.find((s) => s.id === sample.id);
        },
      }),
    ).toEqual(project);
  });
});

describe("project files through the C++ core (WebAssembly)", () => {
  it("open the same projects as the TypeScript, and refuse the same files", async () => {
    const r = rng(7);
    let opened = 0,
      refused = 0,
      same = 0;
    for (const p of projects()) {
      const files = [
        JSON.stringify(p),
        await exportPortable(p),
        await exportSong(p, { packageSamples: true }),
        await exportSong(p, { packageSamples: false }),
      ];
      for (const f of files)
        for (const text of [f, damage(f, r), damage(f, r)]) {
          const [ts, cpp] = await Promise.all([
            outcome(() => importPortable(text)),
            outcome(() => openProject(text)),
          ]);
          expect(cpp.ok, `${text.slice(0, 100)}\n${cpp.ok ? "" : cpp.error.message}`).toBe(ts.ok);
          if (ts.ok && cpp.ok) {
            expect(cpp.text).toBe(ts.text);
            opened++;
          } else if (!ts.ok && !cpp.ok) {
            refused++;
            // XMP's own messages are the same; zod's issue lists and JSON.parse's wording are not reproduced.
            const own =
              ts.error.name !== "ZodError" &&
              ts.error.name !== "SyntaxError" &&
              !/^(Could not open project: )?\[/.test(ts.error.message);
            if (own) {
              expect(cpp.error.message).toBe(ts.error.message);
              expect(cpp.error.name).toBe(ts.error.name);
              same++;
            }
          }
        }
    }
    expect(opened).toBeGreaterThan(30);
    expect(refused).toBeGreaterThan(20);
    expect(same).toBeGreaterThan(10);
  }, 600000);

  it("save byte-identical songs (packaged and referenced) and legacy bundles", async () => {
    for (const p of projects()) {
      expect(await saveSong(p)).toBe(await exportSong(p, { packageSamples: true }));
      expect(await saveSong(p, { packageSamples: false })).toBe(
        await exportSong(p, { packageSamples: false }),
      );
      expect(await saveBundle(p)).toBe(await exportPortable(p));
    }
  }, 600000);

  it("refuse an invalid project when saving", async () => {
    const bad = { ...createDemoProject(), bpm: 9999 } as Project;
    await expect(saveSong(bad)).rejects.toThrow();
    await expect(exportSong(bad)).rejects.toThrow();
  });

  it("open a song saved without its samples from a library, as the TypeScript does", async () => {
    const p = projects()[1] as Project;
    const text = await exportSong(p, { packageSamples: false });
    const library = new Map<string, { sampleRate: number; pcm: number[] }>();
    for (const s of p.samples)
      library.set(await hashSample(s.sampleRate, s.pcm), { sampleRate: s.sampleRate, pcm: s.pcm });
    const resolveAsset = async (sample: SongSample) => library.get(sample.assetHash);
    expect(JSON.stringify(await openProject(text, { resolveAsset }))).toBe(
      JSON.stringify(await importPortable(text, { resolveAsset })),
    );
    // Nothing in the library: the same missing samples.
    const missing = async (open: typeof openProject) => {
      try {
        await open(text);
      } catch (error) {
        expect(error).toBeInstanceOf(MissingSongAssetsError);
        return {
          message: (error as Error).message,
          missing: (error as MissingSongAssetsError).missing,
        };
      }
      throw new Error("expected missing samples");
    };
    expect(await missing(openProject)).toEqual(await missing(importPortable));
    // Part of the library: only the rest is missing.
    const first = p.samples[0];
    if (!first) throw new Error("no samples");
    const firstHash = await hashSample(first.sampleRate, first.pcm);
    const partial = async (sample: SongSample) =>
      sample.assetHash === firstHash ? library.get(sample.assetHash) : undefined;
    const message = async (open: typeof openProject) =>
      open(text, { resolveAsset: partial }).then(
        () => "",
        (e: Error) => `${e.name}: ${e.message}`,
      );
    expect(await message(openProject)).toBe(await message(importPortable));
    // Wrong audio for a hash: refused with the TypeScript's message.
    const wrong = async (sample: SongSample) => {
      const a = library.get(sample.assetHash);
      return a ? { sampleRate: a.sampleRate, pcm: a.pcm.map((v) => v / 2) } : undefined;
    };
    expect(await message((t, o) => openProject(t, { ...o, resolveAsset: wrong }))).toBe(
      await message((t, o) => importPortable(t, { ...o, resolveAsset: wrong })),
    );
  }, 600000);
});
