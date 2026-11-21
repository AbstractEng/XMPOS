import { inspectToolchain } from "../acceptance/lib/toolchain.mjs";
import { root } from "../acceptance/lib/workspace.mjs";

const result = inspectToolchain(root);
for (const check of result.checks)
  console.log(`${check.name}: ${check.ok ? "OK" : "MISSING/UNSUPPORTED"} ${check.version ?? ""}`);
console.log("Hardware access: none. Force: protected, passive inventory only.");
process.exitCode = result.ok ? 0 : 1;
