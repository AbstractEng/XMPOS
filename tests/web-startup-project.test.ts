import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import demo from "../apps/studio/src/demo-night-shift.json";
import { DEVICE_UI_WASM_BASE64 } from "../packages/core/src/generated/xmp-device-ui-wasm.ts";
import { createDemoProject } from "../packages/core/src/index.ts";
import { openProject, saveSong } from "../packages/core/src/project-io.ts";

const text = readFileSync(`apps/studio/public/demo/${demo.file}`, "utf8");
const bytes = Buffer.from(text);
async function setup() {
  vi.resetModules();
  vi.stubGlobal("indexedDB", new IDBFactory());
  const fetcher = vi.fn(async () => new Response(text));
  vi.stubGlobal("fetch", fetcher);
  const store = await import("../apps/studio/src/storage.ts");
  const { loadWebStartupProject } = await import("../apps/studio/src/startup-project.ts");
  return { store, loadWebStartupProject, fetcher };
}
async function raw(autosave: string, previous?: string) {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const r = indexedDB.open("xmp-studio-v1", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("projects");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("projects", "readwrite"),
      s = tx.objectStore("projects");
    s.put(autosave, "autosave");
    if (previous !== undefined) s.put(previous, "previous");
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error);
  });
  db.close();
}
afterEach(() => vi.unstubAllGlobals());
it("loads and saves the verified Night Shift song once on a fresh visit", async () => {
  const { store, loadWebStartupProject, fetcher } = await setup();
  expect(bytes.length).toBe(demo.bytes);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(demo.sha256);
  const first = await loadWebStartupProject();
  expect(first.firstVisit).toBe(true);
  expect(first.project.name).toBe("Night Shift");
  expect(first.project.bpm).toBe(124);
  expect(first.project.tracks).toHaveLength(6);
  expect(first.project.performance?.chain.map((b) => b.repeats)).toEqual([1, 2, 1, 2, 1, 2]);
  expect(await store.loadProjectText()).toBe(text);
  const next = await loadWebStartupProject();
  expect(next.firstVisit).toBe(false);
  expect(next.text).toBe(first.text);
  expect(fetcher).toHaveBeenCalledOnce();
});
it("restores a user's new project, including an intentionally empty song, without fetching the demo", async () => {
  const { store, loadWebStartupProject, fetcher } = await setup();
  await loadWebStartupProject();
  const mine = createDemoProject();
  mine.name = "My new project";
  for (const t of mine.tracks) t.clips = [];
  for (const s of mine.scenes) s.clips = {};
  await store.saveProject(mine);
  fetcher.mockClear();
  const next = await loadWebStartupProject();
  expect(next.project).toEqual(mine);
  expect(next.firstVisit).toBe(false);
  expect(fetcher).not.toHaveBeenCalled();
  expect(next.project.tracks.every((t) => !t.clips.length)).toBe(true);
});
it("uses a recovered save and refuses incompatible/corrupt saves without replacing them with Night Shift", async () => {
  const { loadWebStartupProject, fetcher } = await setup();
  const mine = createDemoProject();
  mine.name = "Recovered work";
  const previous = await saveSong(mine);
  await raw("damaged", previous);
  const recovered = await loadWebStartupProject();
  expect(recovered.project.name).toBe(mine.name);
  expect(recovered.recovered).toBe(true);
  expect(fetcher).not.toHaveBeenCalled();
  await raw(JSON.stringify({ ...mine, version: 999 }), previous);
  await expect(loadWebStartupProject()).rejects.toThrow(/Unsupported/);
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects a missing or altered starter without creating an autosave", async () => {
  const { store, loadWebStartupProject, fetcher } = await setup();
  fetcher.mockImplementationOnce(async () => new Response("missing", { status: 404 }));
  await expect(loadWebStartupProject()).rejects.toThrow(/Could not load/);
  fetcher.mockImplementationOnce(async () => new Response("x".repeat(demo.bytes + 1)));
  await expect(loadWebStartupProject()).rejects.toThrow(/verified size/);
  fetcher.mockImplementationOnce(async () => new Response("x".repeat(demo.bytes)));
  await expect(loadWebStartupProject()).rejects.toThrow(/integrity/);
  expect(await store.loadProjectText()).toBeUndefined();
});
it("preserves a project saved by another tab while the starter is downloading", async () => {
  const { loadWebStartupProject, fetcher, store } = await setup();
  const mine = createDemoProject();
  mine.name = "Other tab's work";
  fetcher.mockImplementationOnce(async () => {
    await raw(await saveSong(mine));
    return new Response(text);
  });
  const loaded = await loadWebStartupProject();
  expect(loaded.project.name).toBe(mine.name);
  expect(loaded.firstVisit).toBe(false);
  expect((await store.loadProjectState()).project).toEqual(mine);
});
it("a single PLAY runs Night Shift's whole arrangement through the shared touchscreen and stops at its end", async () => {
  let d: Record<string, (...args: number[]) => number> & { memory: WebAssembly.Memory };
  const { instance } = await WebAssembly.instantiate(Buffer.from(DEVICE_UI_WASM_BASE64, "base64"), {
    xmp: { read_file: () => 0 },
    wasi_snapshot_preview1: {
      clock_time_get: (_clock: number, _precision: bigint, address: number) => {
        new DataView(d.memory.buffer).setBigUint64(address, 1000000000n, true);
        return 0;
      },
    },
  });
  d = instance.exports as unknown as typeof d;
  d._initialize!();
  const address = d.input_buffer!(bytes.length);
  new Uint8Array(d.memory.buffer, address, bytes.length).set(bytes);
  expect(d.initialize!(bytes.length)).toBe(1);
  const quiet = d.audio_block!(512);
  expect(new Float32Array(d.memory.buffer, quiet, 512).every((n) => n === 0)).toBe(true);
  d.button!(0x52, 1);
  d.button!(0x52, 0);
  let peak = 0;
  for (let n = 0; n < Math.ceil((72 * 48000) / 512); ++n) {
    const p = d.audio_block!(512);
    for (const v of new Float32Array(d.memory.buffer, p, 512)) peak = Math.max(peak, Math.abs(v));
  }
  expect(peak).toBeGreaterThan(0.01);
  expect(new Uint8Array(d.memory.buffer, d.panel_lights!(), 17)[11]).toBe(0);
  const project = await openProject(text);
  expect(project.performance?.end).toBe("stop");
}, 120000);
