import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { encodeWav, parseProject } from "../../packages/core/src/index.ts";
import { command, root } from "./workspace.mjs";

/** @typedef {'offline-render'|'project-persistence'|'simulated-pads'|'os-boot'|'physical-pad-sensor'|'usb-session'} Capability */
/** @typedef {{profile:string, synthetic:boolean, capabilities:readonly Capability[], interfaceVersion:1}} TargetIdentity */
const capabilities = Object.freeze({
  desktop: Object.freeze(["offline-render", "project-persistence", "simulated-pads"]),
  native: Object.freeze(["offline-render", "project-persistence"]),
});
export class UnsupportedTarget extends Error {
  constructor(profile, missing) {
    super(`UNSUPPORTED ${profile}: ${missing.join(", ")}`);
    this.outcome = "unsupported";
    this.profile = profile;
    this.missing = missing;
  }
}
export function preflightAdapter(profile, required) {
  if (!Array.isArray(required)) throw new Error("Explicit capability list required");
  const supported = capabilities[profile];
  if (!supported) throw new UnsupportedTarget(profile, ["adapter unavailable"]);
  const missing = required.filter((item) => !supported.includes(item));
  if (missing.length) throw new UnsupportedTarget(profile, missing);
  return Object.freeze({ profile, synthetic: false, capabilities: supported, interfaceVersion: 1 });
}
export function openAdapter(profile, required, workspace) {
  const identity = preflightAdapter(profile, required);
  const methods = { identity };
  if (required.includes("project-persistence")) {
    methods.saveProject = (project) => {
      const validated = parseProject(JSON.stringify(project));
      writeFileSync(workspace.path("project.json"), JSON.stringify(validated));
    };
    methods.loadProject = () => parseProject(readFileSync(workspace.path("project.json"), "utf8"));
  }
  if (required.includes("offline-render"))
    methods.render = (fixture) => {
      if (
        fixture.sampleRate !== 48000 ||
        !Number.isInteger(fixture.frames) ||
        fixture.frames < 1 ||
        fixture.frames > 480000 ||
        !Number.isInteger(fixture.eventFrame) ||
        fixture.eventFrame < 0 ||
        fixture.eventFrame >= fixture.frames ||
        !Array.isArray(fixture.pcm) ||
        fixture.pcm.length < 1 ||
        fixture.pcm.length > 480000 ||
        fixture.pcm.some((value) => !Number.isFinite(value) || Math.abs(value) > 1)
      )
        throw new Error("Invalid bounded render fixture");
      const output = workspace.path("capture.wav");
      if (profile === "native") {
        const input = Buffer.alloc(16 + fixture.pcm.length * 2);
        input.write("XMPF");
        input.writeUInt32LE(fixture.frames, 4);
        input.writeUInt32LE(fixture.pcm.length, 8);
        input.writeUInt32LE(fixture.eventFrame, 12);
        fixture.pcm.forEach((value, index) => {
          input.writeInt16LE(Math.round(value * 32767), 16 + index * 2);
        });
        writeFileSync(workspace.path("render.xmpf"), input);
        command(resolve(root, "build/native/xmp_fixture_render"), [
          workspace.path("render.xmpf"),
          output,
        ]);
      } else {
        const samples = new Float32Array(fixture.frames);
        fixture.pcm.forEach((value, index) => {
          if (fixture.eventFrame + index < samples.length)
            samples[fixture.eventFrame + index] = value;
        });
        writeFileSync(output, Buffer.from(encodeWav([samples, samples], 48000)));
      }
      return readFileSync(output);
    };
  return Object.freeze(methods);
}
// Contract-test doubles are never selectable through openAdapter or physical policy.
export function fixtureAdapter(profile, workspace, { synthetic } = {}) {
  if (synthetic !== true) throw new Error("Explicit synthetic evidence opt-in required");
  const extra = {
    desktop: ["simulated-pads"],
    native: [],
    "os-vm": ["os-boot"],
    "usb-lab": ["usb-session", "physical-pad-sensor"],
  }[profile];
  if (!extra) throw new Error("Unknown fixture target");
  const base = openAdapter("desktop", ["offline-render", "project-persistence"], workspace);
  return Object.freeze({
    ...base,
    identity: Object.freeze({
      profile,
      synthetic: true,
      interfaceVersion: 1,
      capabilities: Object.freeze(["offline-render", "project-persistence", ...extra]),
    }),
  });
}
