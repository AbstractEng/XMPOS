// @vitest-environment happy-dom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDemoProject } from "@xmp/core";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, expect, it, vi } from "vitest";
import { cc0Kits, loadBundledDrumKit } from "../apps/studio/src/bundled-drum-kits.ts";
import { installDrumKitPanel } from "../apps/studio/src/drum-kit-panel.ts";
import { applyDrumKit } from "../packages/core/src/drum-kits.ts";
import { prepareInstruments, VoiceRack } from "../packages/core/src/instruments.ts";
import { ProjectSession } from "../packages/core/src/session.ts";

const publicRoot = resolve(import.meta.dirname, "../apps/studio/public");
const offlineFetch = async (url: string) => {
  expect(url.startsWith("/xmpos/kits/cc0/")).toBe(true);
  return new Response(
    new Uint8Array(readFileSync(resolve(publicRoot, url.slice("/xmpos/".length)))),
  );
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it.each(cc0Kits)(
  "loads the actual licensed assets for $name and renders every assigned pad",
  async (entry) => {
    expect(entry.license).toBe("CC0-1.0");
    for (const license of entry.licensePaths)
      expect(readFileSync(resolve(publicRoot, license), "utf8")).toContain("CC0 1.0 Universal");
    for (const file of entry.files) {
      const bytes = readFileSync(resolve(publicRoot, file.path));
      expect(bytes.length).toBe(file.bytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);
      expect(file.sourceUrl).toMatch(
        /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\//,
      );
      expect(file.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    }
    const kit = await loadBundledDrumKit(entry.id, "/xmpos/", offlineFetch);
    expect(kit.samples).toHaveLength(entry.files.length);
    expect(kit.samples.reduce((n, s) => n + s.pcm.length, 0)).toBe(entry.totalFrames);
    const session = new ProjectSession(createDemoProject()),
      before = session.project;
    session.edit((p) => applyDrumKit(p, kit));
    expect(session.project.tracks).toEqual(before.tracks);
    expect(session.project.scenes).toEqual(before.scenes);
    expect(session.project.pads.slice(0, 4).map((p) => p.name)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Kick/),
        expect.stringMatching(/^Snare/),
        expect.stringMatching(/^Closed Hat/),
        expect.stringMatching(/^Open Hat/),
      ]),
    );
    for (let pad = 0; pad < kit.samples.length; pad++) {
      const rack = new VoiceRack(prepareInstruments(session.project));
      const left = new Float32Array(128),
        right = new Float32Array(128);
      rack.noteOn(1, pad, 0, 60, 0.8);
      let peak = 0;
      for (let block = 0; block < 40; block++) {
        rack.process(left, right);
        expect(left.every(Number.isFinite) && right.every(Number.isFinite)).toBe(true);
        for (const value of left) peak = Math.max(peak, Math.abs(value));
      }
      expect(peak, `${entry.id} pad ${pad + 1} is silent`).toBeGreaterThan(0.00001);
    }
    session.undo();
    expect(session.project).toEqual(before);
  },
  // Decodes and renders every pad of a real kit; give it CPU headroom.
  30_000,
);

it("refuses corrupt, truncated, oversized or unavailable bundled assets before changing the song", async () => {
  const entry = cc0Kits[0];
  if (!entry) throw new Error("Missing CC0 kit");
  const first = entry.files[0];
  if (!first) throw new Error("Missing sample");
  const source = new Uint8Array(readFileSync(resolve(publicRoot, first.path)));
  const corrupt = source.slice();
  corrupt[corrupt.length - 1] = (corrupt[corrupt.length - 1] ?? 0) ^ 1;
  const session = new ProjectSession(createDemoProject()),
    before = session.project;
  for (const response of [
    new Response(corrupt),
    new Response(source.slice(0, -1)),
    new Response(new Uint8Array(source.length + 1)),
    new Response(null, { status: 404 }),
  ]) {
    await expect(
      loadBundledDrumKit(entry.id, "/xmpos/", async () => response).then((kit) =>
        session.edit((p) => applyDrumKit(p, kit)),
      ),
    ).rejects.toThrow();
    expect(session.project).toBe(before);
    expect(session.historyDepth).toBe(0);
  }
  const unknown = vi.fn();
  await expect(loadBundledDrumKit("../private", "/xmpos/", unknown)).rejects.toThrow("Unknown");
  expect(unknown).not.toHaveBeenCalled();
});

it("keeps song edits made while a CC0 kit is downloading", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const entry = cc0Kits[0];
  if (!entry) throw new Error("Missing CC0 kit");
  const session = new ProjectSession(createDemoProject());
  document.body.innerHTML = '<div id="kit-tools"></div>';
  const panel = installDrumKitPanel(document, {
    project: () => session.project,
    revision: () => session.revision,
    mutate: (change) => {
      session.edit(change);
    },
  });
  await panel.initialized;
  let release: () => void = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.stubGlobal("fetch", async (url: string) => {
    if (first) {
      first = false;
      await blocked;
    }
    return offlineFetch(url.replace(/^\/(?!xmpos\/)/, "/xmpos/"));
  });
  const choice = document.getElementById("kit-choice") as HTMLSelectElement;
  choice.value = entry.id;
  document.getElementById("kit-load")?.click();
  session.edit((p) => ({ ...p, name: "Keep this edit" }));
  release();
  await vi.waitFor(() =>
    expect(document.getElementById("kit-status")?.textContent).toContain(
      "Project changed while loading kit",
    ),
  );
  expect(session.project.name).toBe("Keep this edit");
  expect(session.project.pads[0]?.name).toBe("Kick");
  expect(session.historyDepth).toBe(1);
});
