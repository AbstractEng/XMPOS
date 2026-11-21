// Child-process fixture only: no fake-host flag is exposed by the real doctor CLI.
import { inspectToolchain } from "./toolchain.mjs";
import { root } from "./workspace.mjs";

const probes = [];
const result = inspectToolchain(root, (bin, args) => {
  probes.push({ bin, args });
  if (bin === process.execPath) return { status: 0, stdout: "v20.0.0" };
  if (bin === "python3") return { status: 0, stdout: "Python 3.11.4" };
  if (bin === "openssl") return { status: 0, stdout: "OpenSSL 3.0.0" };
  if (bin.endsWith("cmake")) return { status: 0, stdout: "cmake version 4.4.4" };
  if (bin.endsWith("ninja")) return { status: 0, stdout: "1.13.2" };
  return { status: 1, stdout: "" };
});
console.log(JSON.stringify({ ...result, probes, syntheticHost: true }));
process.exitCode = result.ok ? 0 : 1;
