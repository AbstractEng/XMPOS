import { createDemoProject } from "../../packages/core/src/index.ts";
import { buildPackage } from "../../packages/sdk/src/community/package.ts";
import { template } from "../../tools/sdk/template.mjs";
export const sdkOracle = Object.freeze({
  version: 1,
  apiVersion: 2,
  dspAbi: 1,
  voices: 32,
  events: 256,
  packageBytes: 1048576,
  expressionNoteIds: [101, 102],
  expressionAt: 0.125,
  uiMemoryMiB: 64,
  physicalAccess: false,
  nativePackageLoader: false,
});
export function sdkProject() {
  const p = createDemoProject();
  p.samples = [
    { id: "sdk-impulse", name: "Original SDK fixture", sampleRate: 48000, pcm: [0.5, 0] },
  ];
  for (const pad of p.pads) pad.sampleId = "sdk-impulse";
  return p;
}
export async function sdkFixture(kind = "instrument") {
  const t = await template(kind, kind === "instrument" ? "fixture-tone" : "fixture-effect");
  return { ...t, pkg: await buildPackage(t.manifest, t.program, t.license) };
}
export async function sdkUpgrade(t) {
  const next = structuredClone(t);
  next.manifest.version = "1.1.0";
  next.manifest.stateVersion = 2;
  next.manifest.parameters[0].id = "gain";
  next.program.gain = { parameter: "gain" };
  next.program.migrations = [{ from: 1, to: 2, renames: { level: "gain" } }];
  return { ...next, pkg: await buildPackage(next.manifest, next.program, next.license) };
}
