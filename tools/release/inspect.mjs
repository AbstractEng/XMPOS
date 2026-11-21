import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";
import { evaluateGate } from "../../acceptance/lib/evidence.mjs";
import { fixtureHash } from "../../acceptance/lib/fixtures.mjs";
import { buildIdentity, root, sha256 } from "../../acceptance/lib/workspace.mjs";
import { implemented } from "../../cucumber.mjs";
import { qualify } from "../os/qualify.mjs";
import { imageIdentity } from "../os/vm.mjs";
import { releaseDecision } from "./gate.mjs";
import { qualifyReleaseVm } from "./qualify-vm.mjs";
import { soakMeasurementsComplete } from "./soak.mjs";

function bytes(path, maximum = 1048576) {
  const actual = realpathSync(path),
    info = lstatSync(path);
  if (
    !actual.startsWith(`${realpathSync(root)}/`) ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > maximum
  )
    throw new Error("Owned bounded release evidence required");
  return readFileSync(actual);
}
const json = (path) => JSON.parse(bytes(path).toString("utf8"));
function latest(path) {
  const directory = resolve(json(path).directory);
  if (!directory.startsWith(`${resolve(root, "reports/acceptance")}/`))
    throw new Error("Evidence directory outside owned reports");
  return directory;
}
export async function inspectRelease() {
  const sourceHash = buildIdentity(),
    evidence = [],
    notes = [];
  let imageBuildId = null,
    observedSoakOverruns = null;
  try {
    imageBuildId = (await imageIdentity(resolve(root, "artifacts/os/p10"))).manifest.buildId;
  } catch {
    notes.push("Current generic image unavailable");
  }
  try {
    const directory = resolve(root, "reports/acceptance/implemented"),
      meta = json(resolve(directory, "run-metadata.json")),
      gates = json(resolve(directory, "stage-gates.json"));
    const owned = resolve(root, meta.evidenceDirectory);
    if (!owned.startsWith(`${directory}/`)) throw new Error("Host evidence escaped run namespace");
    const records = readdirSync(owned)
      .filter((p) => p.endsWith(".json") && p !== "device-io-audit.json")
      .map((p) => json(resolve(owned, p)));
    // Count compiled examples: outline names can legitimately repeat across examples.
    const expected = new Set(),
      expectedCases = [];
    for (const path of implemented.paths) {
      const messages = generateMessages(
        bytes(resolve(root, path)).toString(),
        path,
        SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
        { includePickles: true, newId: IdGenerator.incrementing() },
      );
      for (const { pickle } of messages) {
        if (!pickle) continue;
        const tags = pickle.tags.map((t) => t.name);
        if (
          !tags.includes("@implemented") ||
          tags.some((t) => ["@acoustic_mac", "@manual_layout", "@p12_vm"].includes(t))
        )
          continue;
        const id = `${path}:${pickle.name}`;
        expected.add(id);
        expectedCases.push(JSON.stringify([path, pickle.name, pickle.steps.map((s) => s.text)]));
      }
    }
    const cucumber = JSON.parse(bytes(resolve(directory, "cucumber.json"), 16777216));
    const actualCases = cucumber.flatMap((feature) =>
      feature.elements.map((element) => {
        if (element.steps.some((s) => s.result?.status !== "passed"))
          throw new Error("A compiled host example did not pass");
        return JSON.stringify([
          feature.uri,
          element.name,
          element.steps.filter((s) => !s.hidden).map((s) => s.name),
        ]);
      }),
    );
    const complete =
      JSON.stringify(actualCases.sort()) === JSON.stringify(expectedCases.sort()) &&
      records.length === expected.size &&
      [...expected].every((id) => records.filter((r) => r.scenarioId === id).length === 1) &&
      records.every(
        (record) =>
          evaluateGate({
            required: [{ scenarioId: record.scenarioId, profile: "host-contract" }],
            records: [record],
            buildHash: sourceHash,
            fixtureHash,
            directory: owned,
          }).complete,
      );
    evidence.push({
      kind: "host-contract",
      sourceHash: meta.sourceHash,
      imageBuildId: null,
      evidenceHash: sha256(
        Buffer.concat([
          bytes(resolve(directory, "stage-gates.json")),
          bytes(resolve(directory, "cucumber.json"), 16777216),
        ]),
      ),
      checksPassed:
        complete &&
        meta.mode === "implemented" &&
        meta.exitCode === 0 &&
        gates.sourceHash === sourceHash &&
        gates.P12?.hostSoftwareChecksPassed === true,
    });
  } catch {
    notes.push("Complete current-source host evidence unavailable or corrupt");
  }
  try {
    const directory = latest(resolve(root, "reports/acceptance/P10/latest.json")),
      result = await qualify(directory);
    evidence.push({
      kind: "os-vm",
      sourceHash: result.sourceHash,
      imageBuildId: result.buildId,
      evidenceHash: sha256(bytes(resolve(directory, "qualification.json"))),
      checksPassed: result.checksPassed && result.genericVmSoftwarePassed,
    });
  } catch {
    notes.push("Complete current-source OS VM evidence unavailable or corrupt");
  }
  try {
    const directory = latest(resolve(root, "reports/acceptance/P12-vm/latest.json")),
      meta = json(resolve(directory, "run-metadata.json")),
      result = await qualifyReleaseVm(directory);
    evidence.push({
      kind: "reliability-vm",
      sourceHash: result.sourceHash,
      imageBuildId: result.buildId,
      evidenceHash: sha256(bytes(resolve(directory, "qualification.json"))),
      checksPassed: result.checksPassed && meta.mode === "P12",
    });
  } catch {
    notes.push("Complete current-source recovery/update VM evidence unavailable or corrupt");
  }
  try {
    const reportPath = resolve(root, "reports/release-soak/report.json"),
      report = json(reportPath),
      capture = bytes(resolve(root, "reports/release-soak/capture.wav"), 384044);
    observedSoakOverruns = report.native.overruns;
    const localBinary = resolve(root, "build/native/xmp_engine_host"),
      binaryMatches =
        !existsSync(localBinary) ||
        sha256(bytes(localBinary, 134217728)) === report.nativeBinaryHash;
    evidence.push({
      kind: "sampler-soak",
      sourceHash: report.sourceHash,
      imageBuildId: null,
      evidenceHash: sha256(bytes(reportPath)),
      checksPassed:
        soakMeasurementsComplete(report) &&
        report.requestedSeconds >= 60 &&
        report.native.auditFaults === 0 &&
        sha256(capture) === report.captureHash &&
        binaryMatches,
    });
  } catch {
    notes.push("Measured current-source sampler evidence unavailable or corrupt");
  }
  const report = {
    ...releaseDecision({ sourceHash, imageBuildId, evidence, observedSoakOverruns }),
    collectionNotes: notes,
  };
  return report;
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length > 2)
    throw new Error("Inspects local development evidence; no publish or device flags");
  const report = await inspectRelease(),
    output = resolve(root, "reports/release");
  mkdirSync(output, { recursive: true });
  writeFileSync(resolve(output, "development-candidate.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.developmentPreviewReady ? 0 : 2;
}
