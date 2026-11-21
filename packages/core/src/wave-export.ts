import { decodeBase64 } from "./engine.ts";
import type { Project } from "./index.ts";
import { saveSong } from "./project-io.ts";

interface Renderer {
  memory: WebAssembly.Memory;
  _initialize(): void;
  input_buffer(bytes: number): number;
  begin(bytes: number, song: number, sceneBytes: number, tail: number): number;
  next(): number;
  output(): number;
  error_bytes(): number;
  error_size(): number;
  close(): void;
}
/** Stereo 48 kHz / 16-bit WAV: header, then bounded 4096-frame blocks.
 * A fresh isolated engine preserves playback and is released on failure/cancel.
 * Song duration is bounded to thirty minutes, including the effect tail.
 */
export async function* exportWave(
  project: Project,
  mode: "scene" | "song",
  scene = project.scenes[0]?.id ?? "",
  tailSeconds = 2,
): AsyncGenerator<Uint8Array<ArrayBuffer>> {
  const { WAVE_EXPORT_WASM_BASE64 } = await import("./generated/xmp-wave-export-wasm.ts");
  const { instance } = await WebAssembly.instantiate(decodeBase64(WAVE_EXPORT_WASM_BASE64), {
    wasi_snapshot_preview1: { random_get: () => 0 },
  });
  const renderer = instance.exports as unknown as Renderer;
  renderer._initialize();
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  const songBytes = encoder.encode(await saveSong(project));
  const sceneBytes = encoder.encode(scene);
  const error = () =>
    new Error(
      decoder.decode(
        new Uint8Array(renderer.memory.buffer, renderer.error_bytes(), renderer.error_size()),
      ) || "WAV export failed",
    );
  try {
    const at = renderer.input_buffer(songBytes.length + sceneBytes.length);
    if (!at) throw new Error("Project exceeds 96 MiB export input limit");
    new Uint8Array(renderer.memory.buffer, at, songBytes.length).set(songBytes);
    new Uint8Array(renderer.memory.buffer, at + songBytes.length, sceneBytes.length).set(
      sceneBytes,
    );
    if (!renderer.begin(songBytes.length, mode === "song" ? 1 : 0, sceneBytes.length, tailSeconds))
      throw error();
    let blocks = 0;
    for (;;) {
      const length = renderer.next();
      if (length < 0) throw error();
      if (!length) break;
      yield new Uint8Array(renderer.memory.buffer, renderer.output(), length).slice();
      // Let controls, progress messages and cancellation run during long exports.
      if (++blocks % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  } finally {
    renderer.close();
  }
}
