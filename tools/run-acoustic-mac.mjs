import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { buildIdentity, command, root, sha256, writeJson } from "../acceptance/lib/workspace.mjs";
import { acousticProfile } from "../packages/core/src/acoustic.ts";

if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--inspect"))
  throw new Error("Use audio:acoustic, or audio:acoustic -- --inspect; no device overrides");
if (process.platform !== "darwin" || process.env.CI || process.env.GITHUB_ACTIONS === "true")
  throw new Error("Built-in acoustic check is Mac-only and disabled in CI");
// Build/test the helper and the XMP renderer; these native tests open no audio devices.
command(process.execPath, ["tools/native.mjs", "test"]);
const inspectOnly = process.argv[2] === "--inspect";
if (inspectOnly) {
  process.stdout.write(command(resolve(root, "build/native/xmp_acoustic_capture"), ["--inspect"]));
  process.exit(0);
}
const parent = resolve(root, "reports/acoustic");
mkdirSync(parent, { recursive: true });
const directory = mkdtempSync(resolve(parent, "run-"));
chmodSync(directory, 0o700);
const metadata = {
  profile: acousticProfile.id,
  startedAt: new Date().toISOString(),
  sourceHash: buildIdentity(),
  profileHash: sha256(JSON.stringify(acousticProfile)),
  nativeHelperHash: sha256(readFileSync(resolve(root, "build/native/xmp_acoustic_capture"))),
  synthetic: false,
  formalLoopbackQualified: false,
  physicalAudioQualified: false,
  evidenceDirectory: relative(root, directory),
};
writeJson(resolve(directory, "run-metadata.json"), metadata);
console.log(
  "Running a six-second local built-in speaker/microphone check. macOS may request microphone permission. No input monitoring or default-device fallback.",
);
const result = spawnSync(
  process.execPath,
  [
    "node_modules/@cucumber/cucumber/bin/cucumber.js",
    "--profile",
    "acousticMac",
    "--format",
    "progress",
    "--format",
    `json:${directory}/cucumber.json`,
    "--format",
    `junit:${directory}/cucumber.xml`,
    "--format",
    `html:${directory}/cucumber.html`,
  ],
  {
    cwd: root,
    stdio: "inherit",
    timeout: 150000,
    env: { ...process.env, XMP_ACOUSTIC_DIR: directory },
  },
);
metadata.finishedAt = new Date().toISOString();
metadata.exitCode = result.status ?? 2;
if (buildIdentity() !== metadata.sourceHash) {
  metadata.exitCode = 2;
  metadata.reason = "Source changed during acoustic run";
}
writeJson(resolve(directory, "run-metadata.json"), metadata);
writeJson(resolve(parent, "latest.json"), metadata);
console.log(`Local acoustic evidence: ${directory}`);
process.exitCode = metadata.exitCode;
