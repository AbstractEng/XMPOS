import { spawnSync } from "node:child_process";
import { root } from "../../acceptance/lib/workspace.mjs";
import { checkWorkspace } from "../check-acceptance-plan.mjs";

const mode = process.argv[2] ?? "P12";
if (!/^P12(?:_[1-4])?$/.test(mode) || process.argv.length > 3)
  throw new Error("Select P12 or P12_1..4; Mac/owned VM only");
const scenarios = checkWorkspace(root).scenarios.filter(
  (s) =>
    s.path === "features/12-release.feature" &&
    s.tags.includes("@implemented") &&
    s.tags.includes(`@${mode}`),
);
if (!scenarios.length) throw new Error("No implemented P12 cases selected");
for (const target of ["host", "vm"]) {
  if (!scenarios.some((s) => s.tags.includes(target === "host" ? "@host_only" : "@p12_vm")))
    continue;
  const args =
    target === "host"
      ? ["tools/run-acceptance.mjs", mode === "P12" ? "release" : `release_${mode.at(-1)}`]
      : ["tools/release/run-vm.mjs", mode];
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: "inherit",
    timeout: 1500000,
  });
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
