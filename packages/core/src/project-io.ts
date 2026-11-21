// Opening and saving projects with XMP's C++ core in WebAssembly (phase 9 of
// docs/cpp-port.md; native/src/project_wasm.cpp). The browser's project
// files go through here: a plain project, a version 1 bundle or a song, and
// songs and legacy bundles out.
//
// The project crosses as compact JSON with each sample's pcm empty, and the
// audio as Float64 arrays, so no sample is written or parsed as JSON text on
// the way. The results are the TypeScript's own (tests/parity/project-io-parity.test.ts
// compares them byte for byte); a refusal names the first problem found.
import {
  MissingSongAssetsError,
  type SongAsset,
  type SongImportOptions,
  type SongSample,
} from "./assets.ts";
import { decodeBase64 } from "./engine.ts";
import type { Project } from "./index.ts";
import { MAX_SONG_BYTES, preflightProjectText } from "./input.ts";
import { projectReadError } from "./project-errors.ts";

export interface ProjectCore {
  memory: WebAssembly.Memory;
  _initialize?: () => void;
  xp_alloc(bytes: number): number;
  xp_free(pointer: number): void;
  xp_result(): number;
  xp_result_size(): number;
  xp_error(): number;
  xp_error_size(): number;
  xp_library_clear(): void;
  xp_library_add(hash: number, hashSize: number, rate: number, pcm: number, frames: number): number;
  xp_open(text: number, size: number): number;
  xp_open_snapshot(text: number, size: number, edits: number, editsSize: number): number;
  xp_missing(): number;
  xp_lean(handle: number): number;
  xp_sample_count(handle: number): number;
  xp_sample_frames(handle: number, index: number): number;
  xp_sample_pcm(handle: number, index: number, out: number): number;
  xp_build(text: number, size: number): number;
  xp_set_pcm(handle: number, index: number, pcm: number, frames: number): number;
  xp_check(handle: number): number;
  xp_save_song(handle: number, packageSamples: number): number;
  xp_save_bundle(handle: number): number;
  xp_close(handle: number): void;
  xp_release(): void;
  xp_reuse_pcm(handle: number, index: number, base: number, from: number): number;
  xp_shares_pcm(a: number, i: number, b: number, j: number): number;
  xp_edit(handle: number, text: number, size: number): number;
  xp_query(handle: number, text: number, size: number): number;
  xp_register_machine(text: number, size: number): number;
  xp_blob_count(): number;
  xp_blob(i: number): number;
  xp_blob_size(i: number): number;
  xp_blobs_release(): void;
  xp_files(text: number, size: number, data: number, dataSize: number): number;
  xp_project_files(handle: number, text: number, size: number): number;
  xp_import_midi(
    handle: number,
    text: number,
    size: number,
    data: number,
    dataSize: number,
  ): number;
  xp_perf_new(handle: number): number;
  xp_perf_close(id: number): void;
  xp_perf_set_project(id: number, handle: number): number;
  xp_perf(id: number, text: number, size: number): number;
  xp_controls(handle: number, text: number, size: number): number;
}

let loading: Promise<ProjectCore> | undefined, loaded: ProjectCore | undefined;
// One instance, compiled asynchronously (a browser refuses large synchronous compiles on its main thread).
export function core(): Promise<ProjectCore> {
  // The module's bytes (0.9 MB as text) are imported here, not at the top: a
  // bundler then keeps them out of the script the page needs to start, and
  // fetches them alongside it.
  loading ??= import("./generated/xmp-project-wasm.ts")
    .then(({ PROJECT_WASM_BASE64 }) =>
      WebAssembly.instantiate(decodeBase64(PROJECT_WASM_BASE64), {
        wasi_snapshot_preview1: { random_get: () => 0 },
      }),
    )
    .then(({ instance }) => {
      const exports = instance.exports as unknown as ProjectCore;
      exports._initialize?.();
      loaded = exports;
      return exports;
    });
  return loading;
}

/** The core, once loaded (edits.ts calls it synchronously; the app awaits loadCore() first). */
export function loadedCore(): ProjectCore | undefined {
  return loaded;
}

export const encoder = new TextEncoder(),
  decoder = new TextDecoder();
// Calls `use` with `bytes` copied into the module's memory, then frees them.
export function withBytes<T>(c: ProjectCore, bytes: Uint8Array, use: (pointer: number) => T): T {
  const pointer = c.xp_alloc(bytes.length);
  new Uint8Array(c.memory.buffer, pointer, bytes.length).set(bytes);
  try {
    return use(pointer);
  } finally {
    c.xp_free(pointer);
  }
}
export function withDoubles<T>(
  c: ProjectCore,
  values: ArrayLike<number>,
  use: (pointer: number) => T,
): T {
  const pointer = c.xp_alloc(values.length * 8);
  new Float64Array(c.memory.buffer, pointer, values.length).set(values);
  try {
    return use(pointer);
  } finally {
    c.xp_free(pointer);
  }
}
export const resultText = (c: ProjectCore) =>
  decoder.decode(new Uint8Array(c.memory.buffer, c.xp_result(), c.xp_result_size()));
export const errorText = (c: ProjectCore) =>
  decoder.decode(new Uint8Array(c.memory.buffer, c.xp_error(), c.xp_error_size()));

// A project handle's contents as the browser's Project object.
function readProject(c: ProjectCore, handle: number): Project {
  c.xp_lean(handle);
  const project = JSON.parse(resultText(c)) as Project;
  c.xp_release();
  const count = c.xp_sample_count(handle);
  for (let i = 0; i < count; i++) {
    const frames = c.xp_sample_frames(handle, i);
    const pointer = c.xp_alloc(frames * 8);
    try {
      c.xp_sample_pcm(handle, i, pointer);
      const sample = project.samples[i];
      if (sample) sample.pcm = Array.from(new Float64Array(c.memory.buffer, pointer, frames));
    } finally {
      c.xp_free(pointer);
    }
  }
  return project;
}

// The browser's project, into a checked handle (the caller closes it).
function writeProject(c: ProjectCore, project: Project): number {
  const lean = JSON.stringify({
    ...project,
    samples: project.samples.map((s) => ({ ...s, pcm: [] })),
  });
  const bytes = encoder.encode(lean);
  const handle = withBytes(c, bytes, (p) => c.xp_build(p, bytes.length));
  if (!handle) throw new Error(errorText(c));
  for (const [i, s] of project.samples.entries())
    withDoubles(c, s.pcm, (p) => c.xp_set_pcm(handle, i, p, s.pcm.length));
  if (!c.xp_check(handle)) {
    c.xp_close(handle);
    throw new Error(errorText(c));
  }
  return handle;
}

/** importPortable, in C++: a project, bundle or song file's text to a Project. */
export async function openProject(text: string, options: SongImportOptions = {}): Promise<Project> {
  preflightProjectText(text, true);
  const c = await core();
  const bytes = encoder.encode(text);
  c.xp_library_clear();
  const open = () => withBytes(c, bytes, (p) => c.xp_open(p, bytes.length));
  let handle = open();
  if (!handle) {
    // A song saved without its audio: ask the library for what it lacks, then open again.
    c.xp_missing();
    const wanted = JSON.parse(resultText(c)) as SongSample[];
    if (!wanted.length || !options.resolveAsset) {
      if (wanted.length) throw new MissingSongAssetsError(wanted);
      throw projectReadError(errorText(c));
    }
    const missing: SongSample[] = [];
    const resolved: { hash: string; sampleRate: number; pcm: Float64Array }[] = [];
    for (const sample of wanted) {
      const asset: SongAsset | undefined = await options.resolveAsset(sample);
      if (!asset) {
        missing.push(sample);
        continue;
      }
      if (
        asset.sampleRate !== sample.sampleRate ||
        !(
          Array.isArray(asset.pcm) ||
          asset.pcm instanceof Float32Array ||
          asset.pcm instanceof Float64Array
        ) ||
        asset.pcm.length !== sample.frames
      )
        throw new Error(`Sample content does not match ${sample.name}; project was not changed`);
      resolved.push({
        hash: sample.assetHash,
        sampleRate: asset.sampleRate,
        pcm: Float64Array.from(asset.pcm),
      });
    }
    if (missing.length) throw new MissingSongAssetsError(missing);
    // Resolvers may suspend or open other projects. Keep each import's audio
    // private until it is complete, then populate/use/clear the shared library
    // synchronously so another import cannot replace it between samples.
    c.xp_library_clear();
    try {
      for (const asset of resolved) {
        const hash = encoder.encode(asset.hash);
        withBytes(c, hash, (h) =>
          withDoubles(c, asset.pcm, (p) =>
            c.xp_library_add(h, hash.length, asset.sampleRate, p, asset.pcm.length),
          ),
        );
      }
      handle = open();
    } finally {
      c.xp_library_clear();
    }
    if (!handle) throw projectReadError(errorText(c));
  }
  try {
    return readProject(c, handle);
  } finally {
    c.xp_close(handle);
  }
}

/** The native Live/emulator snapshot: packaged base plus its bound referenced autosave. */
export async function openSongSnapshot(text: string, edits = ""): Promise<Project> {
  preflightProjectText(text, true);
  const bytes = encoder.encode(text),
    changes = encoder.encode(edits);
  if (changes.length > MAX_SONG_BYTES + 128) throw new Error("Song edits exceed import budget");
  const c = await core();
  const handle = withBytes(c, bytes, (p) =>
    withBytes(c, changes, (e) => c.xp_open_snapshot(p, bytes.length, e, changes.length)),
  );
  if (!handle) throw projectReadError(errorText(c));
  try {
    return readProject(c, handle);
  } finally {
    c.xp_close(handle);
  }
}

/** exportSong, in C++: the project as a version 2 song. */
export async function saveSong(project: Project, { packageSamples = true } = {}): Promise<string> {
  if (typeof packageSamples !== "boolean") throw new Error("Invalid sample packaging option");
  const c = await core();
  const handle = writeProject(c, project);
  try {
    if (c.xp_save_song(handle, packageSamples ? 1 : 0) < 0) throw new Error(errorText(c));
    const text = resultText(c);
    c.xp_release();
    preflightProjectText(text, true);
    return text;
  } finally {
    c.xp_close(handle);
  }
}

/** exportPortable, in C++: the legacy version 1 bundle (project.xmp.json). */
export async function saveBundle(project: Project): Promise<string> {
  const c = await core();
  const handle = writeProject(c, project);
  try {
    if (c.xp_save_bundle(handle) < 0) throw new Error(errorText(c));
    const text = resultText(c);
    c.xp_release();
    preflightProjectText(text, true);
    return text;
  } finally {
    c.xp_close(handle);
  }
}
