import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyTemplate } from "../tools/live-mk1/assemble-image.mjs";
import { MPC_RUNTIME } from "../tools/live-mk1/compatibility.mjs";
import { dynamicBuildRecipe } from "../tools/live-mk1/dynamic-image.mjs";
import { makeExt4, newArtifactDirectory } from "../tools/live-mk1/image-artifacts.mjs";

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
let directory: string;
beforeEach(() => {
  mkdirSync("artifacts", { recursive: true });
  directory = mkdtempSync(resolve("artifacts/dynamic-template-test-"));
  const result = spawnSync("python3", ["-I", "tests/fixtures/public-filesystem.py"]);
  if (result.status !== 0) throw new Error(String(result.stderr));
  writeFileSync(join(directory, "system.img"), result.stdout);
  writeFileSync(
    join(directory, "manifest.json"),
    JSON.stringify({
      format: "xmp-live-mk1-session-image",
      version: 1,
      sourceHash: "a".repeat(64),
      runtimeMode: "owner-local-3.10.1",
      runtimeLibrariesIncluded: false,
      mpcOsVersion: "3.10.1",
      containsProprietaryAkaiAssets: false,
      runtimeLockSha256: sha(readFileSync("os/live-mk1/mpc-runtime.lock.json")),
      updaterImageSha256: MPC_RUNTIME.updaterImageSha256,
      files: { "system.img": { sha256: sha(result.stdout), bytes: result.stdout.length } },
    }),
  );
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

describe("dynamic public template preflight", () => {
  it("audits actual ELF contents and separates a public template from the owner image", async () => {
    const template = await verifyTemplate(directory);
    expect(Object.keys(template.audit.binaries)).toHaveLength(3);
    expect(template.audit.runtimeLibrariesIncluded).toBe(false);
    expect(template.audit.abiExecutionTested).toBe(false);
  });
  it("rejects substituted images, symlinks and runtime-bearing manifests", async () => {
    const image = join(directory, "system.img");
    const original = readFileSync(image);
    writeFileSync(image, "changed");
    await expect(verifyTemplate(directory)).rejects.toThrow(/differs/);
    writeFileSync(image, original);
    const path = join(directory, "manifest.json"),
      manifest = JSON.parse(readFileSync(path, "utf8"));
    writeFileSync(path, JSON.stringify({ ...manifest, runtimeLibrariesIncluded: true }));
    await expect(verifyTemplate(directory)).rejects.toThrow(/profile/);
    writeFileSync(path, JSON.stringify(manifest));
    rmSync(image);
    symlinkSync(path, image);
    await expect(verifyTemplate(directory)).rejects.toThrow(/regular file/);
  });
  it("refuses wrong firmware and changed runtime locks", async () => {
    const path = join(directory, "manifest.json"),
      manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const patch of [
      { mpcOsVersion: "3.10.0" },
      { runtimeLockSha256: "0".repeat(64) },
      { updaterImageSha256: "0".repeat(64) },
    ]) {
      writeFileSync(path, JSON.stringify({ ...manifest, ...patch }));
      await expect(verifyTemplate(directory)).rejects.toThrow();
    }
  });
  it("never overwrites an image or creates directories through symlink parents", async () => {
    const output = join(directory, "new output");
    await newArtifactDirectory(output);
    await expect(newArtifactDirectory(output)).rejects.toThrow();
    const target = join(directory, "outside");
    mkdirSync(target);
    symlinkSync(target, join(directory, "link"));
    await expect(
      newArtifactDirectory(join(directory, "link", "never-created", "out")),
    ).rejects.toThrow(/Symlink/);
    expect(existsSync(join(target, "never-created"))).toBe(false);
    const image = join(directory, "system.img"),
      before = readFileSync(image);
    await expect(makeExt4(directory, image)).rejects.toThrow();
    expect(readFileSync(image)).toEqual(before);
  });
  it("retains relink evidence and never links cross-toolchain runtime archives", () => {
    const recipe = dynamicBuildRecipe("a".repeat(64));
    expect(recipe).toContain("-nodefaultlibs");
    expect(recipe).toContain("-l:libasound.so.2 -l:libstdc++.so.6");
    expect(recipe).toContain("-l:libgcc_s.so.1");
    expect(recipe).not.toMatch(/(?:\s-static\b|libasound\.a|libstdc\+\+\.a|libgcc\.a)/);
    expect(recipe).toContain("/out/objects");
    expect(recipe).toContain("/out/link-maps");
    expect(recipe).toContain("source:Package");
    expect(() => dynamicBuildRecipe("$(unsafe)")).toThrow();
  });
});
