import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIdentity, root } from "../../acceptance/lib/workspace.mjs";
import {
  compareParity,
  parityFixtures,
  parityIdentity,
  referenceParity,
  verifyParityOracle,
} from "../../packages/sdk/src/parity.ts";
import { buildImage } from "../os/build.mjs";
import { bootVm, createVmSession, imageIdentity } from "../os/vm.mjs";
import { compileParity, nativeParity } from "./parity-host.mjs";
import { vmCompiler } from "./toolchain.mjs";

export async function runParityVm() {
  const sourceHash = buildIdentity();
  const zig = await vmCompiler();
  await mkdir(join(root, "build/parity-native"), { recursive: true });
  const build = await mkdtemp(join(root, "build/parity-native/build-"));
  const linux = await compileParity(build, { linuxVm: true, zig });
  buildImage("artifacts/os/parity", { parityBinary: linux.binary });
  const image = await imageIdentity(join(root, "artifacts/os/parity"));
  if (image.manifest.sourceHash !== sourceHash) throw new Error("Parity image source differs");
  await mkdir(join(root, "reports/parity-vm"), { recursive: true });
  const directory = await mkdtemp(join(root, "reports/parity-vm/run-"));
  const host = await compileParity(directory),
    session = await createVmSession(join(directory, "session"), image.directory);
  const vm = await bootVm(session),
    results = [];
  let finish;
  let projectPreserved = false;
  let maximumGuestResponseBytes = 0;
  try {
    for (const c of parityFixtures()) {
      const reference = referenceParity(c.plan),
        native = await nativeParity(host.binary, c.plan, directory, c.id);
      verifyParityOracle(c.id, reference);
      verifyParityOracle(c.id, native);
      const hostIdentity = await parityIdentity(reference);
      for (const backend of ["reference", "native"]) {
        const capture = await vm.request({ op: "sdk-parity", plan: c.plan, backend });
        if (backend === "native" && capture.nativeBinarySha256 !== linux.receipt.binarySha256)
          throw new Error("Booted native binary differs");
        maximumGuestResponseBytes = Math.max(
          maximumGuestResponseBytes,
          Buffer.byteLength(JSON.stringify(capture)),
        );
        if (
          !capture.assertedInsideGuest ||
          capture.physicalAccess !== false ||
          capture.backend !== backend ||
          JSON.stringify(capture.referenceIdentity) !== JSON.stringify(hostIdentity)
        )
          throw new Error("Guest reference identity differs from host");
        if (
          backend === "reference" &&
          JSON.stringify(capture.identity) !== JSON.stringify(hostIdentity)
        )
          throw new Error("Guest reference PCM or event hash differs");
        results.push({
          id: c.id,
          backend: `vm-${backend}`,
          comparisonLocation: "guest",
          ...capture.comparison,
          identity: capture.identity,
          referenceIdentity: capture.referenceIdentity,
        });
      }
      results.push({ id: c.id, backend: "host-native", ...compareParity(reference, native) });
    }
    const before = await vm.request({ op: "status" });
    await vm.request({ op: "sdk-parity", plan: { format: "invalid" }, backend: "native" }).then(
      () => {
        throw new Error("Malformed VM plan accepted");
      },
      () => {},
    );
    const after = await vm.request({ op: "status" });
    projectPreserved =
      before.projectHash === after.projectHash && before.enginePid === after.enginePid;
  } finally {
    finish = await vm.finish();
  }
  const report = {
    format: "xmp-booted-native-parity",
    version: 1,
    sourceHash,
    buildId: image.manifest.buildId,
    initramfsSha256: image.manifest.initramfsSha256,
    boot: vm.boot,
    emulator: vm.emulator,
    args: vm.args,
    nativeBuild: linux.receipt,
    hostBuild: host.receipt,
    results,
    passed:
      maximumGuestResponseBytes <= 4096 &&
      projectPreserved &&
      results.length === 15 &&
      results.every((r) => r.passed) &&
      finish.code === 0 &&
      sourceHash === buildIdentity(),
    physicalAccess: false,
    hardwareQualified: false,
    invalidPlanRejected: true,
    projectPreserved,
    maximumGuestResponseBytes,
  };
  await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2));
  await writeFile(
    join(root, "reports/parity-vm/latest.json"),
    JSON.stringify({ directory }, null, 2),
  );
  if (!report.passed) throw new Error(`VM parity failed; ${join(directory, "report.json")}`);
  return { directory, report };
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length !== 2)
    throw new Error("VM parity uses only the fixed generic VM; no device flags");
  const result = await runParityVm();
  console.log(
    JSON.stringify({
      passed: true,
      directory: result.directory,
      comparisons: result.report.results.length,
      hardwareQualified: false,
    }),
  );
}
