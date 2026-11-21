import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateGate } from "../acceptance/lib/evidence.mjs";
import { fixtureHash } from "../acceptance/lib/fixtures.mjs";
import { buildIdentity, json, root, writeJson } from "../acceptance/lib/workspace.mjs";
import { checkWorkspace } from "./check-acceptance-plan.mjs";

const mode = process.argv[2] ?? "foundation";
const requireP04 = process.argv[3] === "--require-p04";
if (!["foundation", "implemented"].includes(mode) || process.argv.length > (requireP04 ? 4 : 3))
  throw new Error("Select foundation or implemented Mac scope only");
const metadata = json(resolve(root, `reports/acceptance/${mode}/run-metadata.json`));
const plan = checkWorkspace(root);
if (plan.errors.length) throw new Error(plan.errors.join("\n"));
const evidenceDirectory = resolve(root, metadata.evidenceDirectory);
const records = readdirSync(evidenceDirectory)
  .filter((path) => path.endsWith(".json") && path !== "device-io-audit.json")
  .map((path) => json(resolve(evidenceDirectory, path)));
const stages = [];
for (const id of mode === "implemented" ? ["P01", "P02", "P03"] : ["P01", "P02"]) {
  const stage = plan.coverage.find((stage) => stage.id === id);
  const scenarios = [stage.gate, ...stage.substeps.flatMap((task) => task.scenarios)];
  const required = scenarios.map((scenario) => ({
    scenarioId: `${scenario.path}:${scenario.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((record) =>
      required.some((item) => item.scenarioId === record.scenarioId),
    ),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  if (scenarios.some((scenario) => !scenario.tags.includes("@implemented"))) {
    gate.complete = false;
    gate.failures.push("Unimplemented scenario remains");
  }
  if (metadata.exitCode !== 0) {
    gate.complete = false;
    gate.failures.push("Acceptance process did not exit successfully");
  }
  if (stages.some((stage) => !stage.complete)) {
    gate.complete = false;
    gate.failures.push("Preceding Mac stage dependency incomplete");
  }
  stages.push({
    id,
    ...gate,
    outcome: gate.complete ? "passed" : "blocked",
    scope:
      id === "P03"
        ? "Mac project contracts and native offline library; full native application, OS VM and USB qualification pending"
        : "Mac host foundation; not OS or hardware qualification",
    releaseQualified: false,
    ...(id === "P03"
      ? {
          requiredDeploymentProfiles: {
            native: "pending full native host",
            "os-vm": "unsupported; adapter unavailable",
            "usb-lab": "unsupported; adapter unavailable",
          },
          projectVersion: 6,
          parameterVersion: 1,
        }
      : {}),
  });
}
let p04Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter(
    (scenario) =>
      scenario.path.startsWith("features/04-") && scenario.tags.includes("@implemented"),
  );
  const required = scenarios.map((scenario) => ({
    scenarioId: `${scenario.path}:${scenario.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((record) =>
      required.some((item) => item.scenarioId === record.scenarioId),
    ),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p04Software = {
    ...gate,
    complete: false,
    softwareChecksPassed:
      gate.complete && stages.every((stage) => stage.complete) && metadata.exitCode === 0,
    profile: "p04-mac-development-v1",
    physicalAudioQualified: false,
    phaseQualified: false,
    pending: plan.scenarios
      .filter(
        (scenario) =>
          scenario.path === "features/04-audio-engine.feature" &&
          scenario.tags.includes("@planned"),
      )
      .map((scenario) => ({
        scenarioId: `${scenario.path}:${scenario.name}`,
        reason: scenario.tags.includes("@physical_measurement")
          ? "Physical fixture intentionally deferred by owner"
          : "Final V1 workload depends on later instrument/effect implementation",
      })),
  };
}
let p05Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter((s) => s.path === "features/05-instruments.feature");
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p05Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    softwareChecksPassed:
      gate.complete && p04Software?.softwareChecksPassed === true && metadata.exitCode === 0,
    scope:
      "P05 Mac core/Studio instruments and virtual MIDI; shared OS/USB and native live instrument parity pending",
    projectVersion: 6,
    formalLoopbackQualified: false,
    requiredDeploymentProfiles: {
      native: "pending advanced live instrument port",
      "os-vm": "pending",
      "usb-lab": "pending",
    },
    dependency: "ADR-P05-001: P04 software required; full P04 remains pending",
  };
}
let p06Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter((s) => s.path === "features/06-sequencer.feature");
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p06Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    softwareChecksPassed:
      gate.complete && p05Software?.softwareChecksPassed === true && metadata.exitCode === 0,
    scope:
      "P06 Mac core/Studio sequencing, expression and automation; native virtual groove boundary verified separately",
    projectVersion: 6,
    formalLoopbackQualified: false,
    requiredDeploymentProfiles: {
      native: "pending complete sequencer/instrument/automation port",
      "os-vm": "pending",
      "usb-lab": "pending",
    },
    dependency: "ADR-P06-001: P05 Mac software required; native/OS/USB gates remain pending",
  };
}
let p07Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter(
    (s) =>
      s.path === "features/07-performance.feature" &&
      s.tags.includes("@implemented") &&
      !s.tags.includes("@manual_layout"),
  );
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p07Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    softwareChecksPassed:
      gate.complete && p06Software?.softwareChecksPassed === true && metadata.exitCode === 0,
    scope:
      "P07 Mac scenes/clip playheads, song chains, controls, shared preview delay and virtual control/focus flows",
    projectVersion: 6,
    physicalAudioQualified: false,
    manualViewportAudit: "separate bdd:layout evidence required; not inferred from CI",
    pending: plan.scenarios
      .filter((s) => s.path === "features/07-performance.feature" && s.tags.includes("@planned"))
      .map((s) => s.name),
    requiredDeploymentProfiles: {
      native: "pending complete performance/instrument port",
      "os-vm": "pending",
      "usb-lab": "pending deployed display and hardware control evidence",
    },
    dependency:
      "ADR-P07-001: P06 Mac software required; hardware and formal loopback gates remain pending",
  };
}
let p08Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter(
    (s) => s.path === "features/08-mix-midi-export.feature" && s.tags.includes("@implemented"),
  );
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p08Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    softwareChecksPassed:
      gate.complete && p07Software?.softwareChecksPassed === true && metadata.exitCode === 0,
    scope:
      "P08 Mac stereo graph, original effects, virtual MIDI fixture and bounded WAV/SMF exchange",
    projectVersion: 6,
    physicalMidiQualified: false,
    formalLoopbackQualified: false,
    pending: plan.scenarios
      .filter(
        (s) => s.path === "features/08-mix-midi-export.feature" && s.tags.includes("@planned"),
      )
      .map((s) => s.name),
    requiredDeploymentProfiles: {
      native: "pending stereo effects and exchange port",
      "os-vm": "pending",
      "usb-lab":
        "pending device-specific authorization, approved MIDI fixture and independent timing capture",
    },
    dependency:
      "ADR-P08-001: P07 Mac software required; physical MIDI, native/OS/USB and formal loopback remain pending",
  };
}
let p09Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter(
    (s) => s.path === "features/09-sdk.feature" && s.tags.includes("@implemented"),
  );
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p09Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    softwareChecksPassed:
      gate.complete &&
      p08Software?.softwareChecksPassed === true &&
      p04Software?.softwareChecksPassed === true &&
      metadata.exitCode === 0,
    scope:
      "P09 Mac SDK workbench, declarative packages, expression, transactions and real process failure probes",
    sdkApiVersion: 2,
    dspAbi: 1,
    importedExecutableCode: false,
    physicalAudioQualified: false,
    pending: plan.scenarios
      .filter((s) => s.path === "features/09-sdk.feature" && s.tags.includes("@planned"))
      .map((s) => s.name),
    requiredDeploymentProfiles: {
      native:
        "musical ABI fixture only; dynamic native/VST hosting and full engine integration pending",
      "os-vm": "pending booted application/package environment",
      "usb-lab": "pending device-specific authorization and deployment adapter",
    },
    dependency:
      "ADR-P09-001: P04/P08 Mac software permits SDK workbench; deployed SDK and OS sandbox gates remain open",
  };
}
let p11Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter(
    (s) =>
      s.path === "features/11-usb-hardware.feature" &&
      s.tags.includes("@implemented") &&
      s.tags.includes("@host_only"),
  );
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p11Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    hardwareQualified: false,
    hostSoftwareChecksPassed:
      gate.complete && p09Software?.softwareChecksPassed === true && metadata.exitCode === 0,
    scope:
      "P11 Mac prerequisites, typed fixture adapters, mutually authenticated Unix-socket lab prototype and independent native virtual-audio witness",
    deployedAgentAvailable: false,
    physicalUsbAdapterAvailable: false,
    physicalAudioQualified: false,
    pending: plan.scenarios
      .filter((s) => s.path === "features/11-usb-hardware.feature" && s.tags.includes("@planned"))
      .map((s) => s.name),
    requiredDeploymentProfiles: {
      "os-vm": "P10 generic evidence is a separate CI gate; no deployed lab agent inferred",
      "usb-lab":
        "requires exact-unit evidence, recovery and USB topology, separate owner authorization and a reviewed deployment adapter",
    },
    dependency:
      "ADR-P11-001: P01/P02/P10 enable Mac lab development only; full hardware phase remains pending",
  };
}
let p12Software;
if (mode === "implemented") {
  const scenarios = plan.scenarios.filter(
    (s) =>
      s.path === "features/12-release.feature" &&
      s.tags.includes("@implemented") &&
      s.tags.includes("@host_only"),
  );
  const required = scenarios.map((s) => ({
    scenarioId: `${s.path}:${s.name}`,
    profile: "host-contract",
  }));
  const gate = evaluateGate({
    required,
    records: records.filter((r) => required.some((s) => s.scenarioId === r.scenarioId)),
    buildHash: buildIdentity(),
    fixtureHash,
    directory: evidenceDirectory,
  });
  p12Software = {
    ...gate,
    complete: false,
    phaseQualified: false,
    hardwareQualified: false,
    hostSoftwareChecksPassed:
      gate.complete && p11Software?.hostSoftwareChecksPassed === true && metadata.exitCode === 0,
    scope:
      "P12 Mac sampler measurements, overload refusal, signature preflight and scoped development release policy; booted recovery/update evidence is a separate CI gate",
    performanceQualified: false,
    performanceStatus:
      "Inspect the measured sampler report; functional measurement checks do not imply timing qualification",
    eightHourV1Qualified: false,
    publicRedistributionApproved: false,
    pending: plan.scenarios
      .filter((s) => s.path === "features/12-release.feature" && s.tags.includes("@planned"))
      .map((s) => s.name),
    dependency:
      "ADR-P12-001 permits development evidence; full P10/P11 and hardware release gates remain open",
  };
}
writeJson(resolve(root, `reports/acceptance/${mode}/stage-gates.json`), {
  stages,
  sourceHash: buildIdentity(),
  hardwareQualification: false,
  ...(p04Software ? { P04: p04Software } : {}),
  ...(p05Software ? { P05: p05Software } : {}),
  ...(p06Software ? { P06: p06Software } : {}),
  ...(p07Software ? { P07: p07Software } : {}),
  ...(p08Software ? { P08: p08Software } : {}),
  ...(p09Software ? { P09: p09Software } : {}),
  ...(p11Software ? { P11: p11Software } : {}),
  ...(p12Software ? { P12: p12Software } : {}),
});
for (const stage of stages)
  console.log(
    `${stage.id}: ${stage.complete ? "COMPLETE (Mac host scope)" : "BLOCKED"}${stage.failures.length ? `\n${stage.failures.join("\n")}` : ""}`,
  );
if (p04Software)
  console.log(
    `P04: ${p04Software.softwareChecksPassed ? "SOFTWARE CHECKS PASSED" : "SOFTWARE CHECKS FAILED"}; full phase and physical qualification PENDING`,
  );
if (p05Software)
  console.log(
    `P05: ${p05Software.softwareChecksPassed ? "MAC SOFTWARE CHECKS PASSED" : "SOFTWARE CHECKS FAILED"}; OS/USB and full phase qualification PENDING`,
  );
if (p06Software)
  console.log(
    `P06: ${p06Software.softwareChecksPassed ? "MAC SOFTWARE CHECKS PASSED" : "SOFTWARE CHECKS FAILED"}; full native/OS/USB qualification PENDING`,
  );
if (p07Software)
  console.log(
    `P07: ${p07Software.softwareChecksPassed ? "MAC SOFTWARE CHECKS PASSED" : "SOFTWARE CHECKS FAILED"}; native/OS/USB and hardware layout qualification PENDING`,
  );
if (p08Software)
  console.log(
    `P08: ${p08Software.softwareChecksPassed ? "MAC SOFTWARE CHECKS PASSED" : "SOFTWARE CHECKS FAILED"}; physical MIDI, native/OS/USB and formal loopback qualification PENDING`,
  );
if (p09Software)
  console.log(
    `P09: ${p09Software.softwareChecksPassed ? "MAC SOFTWARE CHECKS PASSED" : "SOFTWARE CHECKS FAILED"}; deployed SDK, native/VST hosting and OS/USB qualification PENDING`,
  );
if (p11Software)
  console.log(
    `P11: ${p11Software.hostSoftwareChecksPassed ? "HOST LAB CHECKS PASSED" : "HOST LAB CHECKS FAILED"}; deployed USB and physical qualification PENDING`,
  );
if (p12Software)
  console.log(
    `P12: ${p12Software.hostSoftwareChecksPassed ? "HOST DEVELOPMENT CHECKS PASSED" : "HOST DEVELOPMENT CHECKS FAILED"}; VM, timing, hardware and full release qualification separate or PENDING`,
  );
process.exitCode =
  stages.every((stage) => stage.complete) &&
  (!p04Software || p04Software.softwareChecksPassed) &&
  (!p05Software || p05Software.softwareChecksPassed) &&
  (!p06Software || p06Software.softwareChecksPassed) &&
  (!p07Software || p07Software.softwareChecksPassed) &&
  (!p08Software || p08Software.softwareChecksPassed) &&
  (!p09Software || p09Software.softwareChecksPassed) &&
  (!p11Software || p11Software.hostSoftwareChecksPassed) &&
  (!p12Software || p12Software.hostSoftwareChecksPassed)
    ? requireP04
      ? 2
      : 0
    : 1;
