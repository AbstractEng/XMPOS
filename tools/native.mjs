import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureFonts } from "./fonts.mjs";

const mode = process.argv[2] ?? "test";
if (!["test", "render", "sanitize"].includes(mode) || process.argv.length > 3)
  throw new Error("Select test, render or sanitize only");
const buildDirectory = mode === "sanitize" ? "build/native-sanitize" : "build/native";
const root = fileURLToPath(new URL("../", import.meta.url));
const bin = (name) =>
  existsSync(resolve(root, `.venv/bin/${name}`)) ? resolve(root, `.venv/bin/${name}`) : name;
const run = (program, args) => execFileSync(program, args, { cwd: root, stdio: "inherit" });
// The Live interface draws with the font atlas (tools/fonts.mjs).
await ensureFonts();
run(bin("cmake"), [
  "-S",
  "native",
  "-B",
  buildDirectory,
  "-G",
  "Ninja",
  `-DCMAKE_MAKE_PROGRAM=${bin("ninja")}`,
  "-DCMAKE_BUILD_TYPE=Debug",
  `-DXMP_SANITIZE=${mode === "sanitize" ? "ON" : "OFF"}`,
]);
run(bin("cmake"), ["--build", buildDirectory]);
if (mode === "render") {
  // Fixed Mac workspace destination; no arbitrary output path / device flags.
  mkdirSync(resolve(root, "artifacts"), { recursive: true });
  run(resolve(root, "build/native/xmp_render"), [resolve(root, "artifacts/native-demo.wav")]);
} else run(bin("ctest"), ["--test-dir", buildDirectory, "--output-on-failure"]);

if (mode !== "sanitize") run(process.execPath, ["tools/check-rt-symbols.mjs"]);
