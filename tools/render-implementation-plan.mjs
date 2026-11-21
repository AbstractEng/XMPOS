import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkWorkspace } from "./check-acceptance-plan.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const plan = JSON.parse(readFileSync(resolve(root, "acceptance/plan.json"), "utf8"));
const report = checkWorkspace(root);
if (report.errors.length) throw new Error(report.errors.join("\n"));
function excerpt(scenario) {
  const lines = readFileSync(resolve(root, scenario.path), "utf8").split("\n");
  let start = scenario.line - 1;
  while (start > 0 && lines[start - 1].trim().startsWith("@")) start--;
  let end = scenario.line;
  while (end < lines.length && !/^ {2}(?:@|Scenario(?: Outline)?:|Rule:)/.test(lines[end])) end++;
  const result = lines
    .slice(start, end)
    .join("\n")
    .trimEnd()
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");
  if (
    !/^Scenario(?: Outline)?:/m.test(result) ||
    !/\bGiven\b/.test(result) ||
    !/\bWhen\b/.test(result) ||
    !/\bThen\b/.test(result)
  )
    throw new Error(`Incomplete Gherkin excerpt for ${scenario.name}`);
  return result;
}
const text = [
  "# XMP OS implementation and acceptance plan",
  "",
  "This plan takes the current desktop preview to an independently bootable music workstation and a measured Live Mk1 hardware release. It contains twelve stages and forty-eight substeps. Every stage has an end-to-end acceptance journey; every substep has a successful flow and a failure flow in Gherkin. The canonical feature files and dependency manifest generate this document, so the prose and tests can be kept in sync.",
  "",
  "P12 adds seven Mac and five VM development reliability contracts: measured sampler timing/overload, actual save power cuts, corrupt-generation recovery, signed VM snapshot updates and scoped release evidence. ADR-P12-001 keeps eight-hour final-workload, performance, hardware, UI/native parity and public-release qualification open; see reliability-release.md. P11 adds thirteen Mac host lab contracts for exact-unit prerequisites, typed adapters, mutual TLS sessions, bounded fixtures, native virtual playback after control loss, peer-swap/replay rejection and honest measurement analysis. Its physical stage and seven exact-unit/hardware journeys stay planned under ADR-P11-001; see hardware-lab.md. P10 adds ten executable generic console-OS contracts in a dedicated QEMU lane, including reproducible binary assembly, cold-reboot song persistence, virtual HDA playback, service recovery and diagnostic privacy. ADR-P10-001 keeps graphical UI, continuous native real-time playback, redistribution and hardware gates open; see standalone-os.md. P09 adds eleven Mac SDK workbench, package/expression and failure-recovery journeys. Six deployed/native-loader journeys remain planned. ADR-P09-001 permits this increment against P04/P08 Mac software evidence. P08 adds twelve Mac mix/effects/exchange and virtual MIDI contracts. The original physical stage journey and two external MIDI cases remain planned. ADR-P08-001 permits development against P07 Mac software evidence without physical output. P07 adds ten Mac performance/focus contracts and a separately invoked real-browser viewport audit. Three deployed display/control journeys remain planned. ADR-P07-001 permits development against P06 Mac software evidence. P06 adds thirteen executable Mac sequencing/automation contracts, including a production worklet/offline comparison and a native virtual groove probe. ADR-P06-001 permits Mac development against P05 software evidence; complete native/OS/USB qualification remains pending. P05 adds thirteen executable Mac instrument/machine contracts; its native live, OS and USB deployment gates remain pending. ADR-P05-001 permits development against P04 software evidence without closing the deferred physical gates. P01/P02 have eighteen executable host scenarios, P03 has nine Mac project contracts, and P04 adds six original engine contracts plus four explicitly separate development checks. " +
    report.plannedDefinitions +
    " V1 scenario definitions remain planned, including the final P04 workload journey and physical P04.4 tests. Sixteen additional regression cases cover core behavior and access boundaries. Run `npm run bdd:implemented` and `npm run bdd:qualify:implemented` for current-build Mac evidence. P04 software checks do not close its full phase: physical qualification was explicitly deferred by the owner, and the final V1 synth/effect workload belongs to later increments. Shared OS/USB requirements remain separately applicable. The external specification review remains pending.",
  "",
  "[The instrument design charter](instrument-design.md) records Roger Linn primary-source research, LD01–LD08 decisions and implemented versus planned behavior. Nine additional implemented musical-display/help cases run with `npm run bdd:design`. Their host UI tests mock audio; they do not qualify sensors or a deployed device. New future contracts remain explicitly planned.",
  "",
  "The optional [MacBook acoustic check](acoustic-audio.md) has separate host analysis contracts (`bdd:acoustic`) and a local physical Gherkin journey (`audio:acoustic`). Built-in speaker/microphone playback cannot close the calibrated P04 loopback gates, and the physical journey is excluded from CI.",
  "",
  "## How to execute the plan",
  "",
  "1. Reproduce the P01/P02 host foundation using the commands below. Keep source and fixture hashes together and require the stage gates before downstream work. External specification reconciliation and embedded architecture decisions remain open.",
  "2. Implement P03 through P08 in playable increments. Each substep delivers code, real step bindings, fixtures and evidence before its gate is closed. Keep the app usable after every increment.",
  "3. Stabilize the community SDK in P09, then qualify a self-contained Linux image in P10. A generic VM image must boot and make music without Vite, a host application or network access.",
  "4. Begin P11.1 source/documentation research early alongside P01, and prototype the generic image pipeline after P04 to expose boot/build risks early. Full P10 and P11 qualification still depend on the accepted preceding stages. Do not defer feasibility discovery until all music features are built.",
  "5. Perform Live Mk1 deployment and hardware testing only after the exact device, firmware, recovery route, USB capabilities and concrete authorization are recorded. The Force remains passive inventory only. No device operation is authorized merely by appearing in a scenario.",
  "6. Close P12 only when the same candidate has the required standalone and physical evidence. Undefined, pending, skipped, unsupported or inconclusive required tests block qualification. A desktop preview may ship under its own explicitly narrower label.",
  "",
  "A substep is complete when its positive and failure contracts pass on every required target, regression tests remain green and evidence identifies the accepted build. A stage additionally needs its own journey below. Dependencies are gates, not estimated calendar dates. Stop and record an architectural/product decision if an interface, resource budget or hardware assumption fails; do not weaken an assertion to declare completion.",
  "",
  "## Test targets and budgets",
  "",
  "Use separate host-contract, desktop UI, native standalone, booted-OS VM and authenticated USB-lab adapters. Shared tags mean the same contract is required separately on each applicable target, not that one target can stand in for another. Physical audio and controls require independent capture or human evidence. See [testing strategy](testing-strategy.md), [USB lab design](usb-testing.md) and [proposed qualification profiles](../acceptance/qualification-targets.json).",
  "",
  "The initial proposed workload is eight tracks, sixteen scenes, thirty-two qualified voices, two insert slots per track, two sends and an eight-hour soak at 48 kHz with a 256-frame buffer. Proposed timing limits include p95 analog round trip of 20 ms and p95 MIDI clock interval jitter of 2 ms. These are product targets to approve and measure, not claims about the MPC. Freeze exact fixture hashes, effect settings, thermal limits and measurement methods before qualification.",
  "",
  "## Current verification commands",
  "",
  "```sh\nnpm run bdd:plan   # Parse every feature and verify plan coverage\nnpm run bdd:test   # Execute implemented standalone contracts\nnpm run bdd:foundation # Execute P01/P02 on the Mac\nnpm run bdd:p03 # Execute P03 project contracts on the Mac\nnpm run bdd:p04 # Execute P04 software contracts\nnpm run bdd:p06 # Execute P06 Mac sequencing contracts\nnpm run bdd:p07 # Execute P07 Mac performance contracts\nnpm run bdd:p08 # Execute P08 Mac mix and virtual MIDI exchange contracts\nnpm run bdd:p09 # Execute P09 Mac SDK and package contracts\nnpm run os:build # Assemble the pinned generic Linux guest\nnpm run bdd:p10 # Boot and test all four P10 substeps and the song journey\nnpm run bdd:p11 # Mac-only P11 host lab contracts; no hardware connection\nnpm run release:images # Build both owned generic VM variants\nnpm run bdd:p12 # Mac and VM development reliability contracts\nnpm run release:inspect # Inspect scoped development evidence; never publishes\nnpm run lab:demo # Authenticated local lab process and native virtual audio\nnpm run bdd:qualify:p10 # Check current-source guest evidence\nnpm run bdd:layout # Verify an independently captured current-source CUA viewport audit\nnpm run native:sanitize # Separate native memory-safety checks\nnpm run bdd:implemented # Execute all implemented Mac contracts\nnpm run bdd:qualify:implemented # Require current-build Mac evidence through P03\nnpm run check     # Existing formatting, types, unit tests and build\n```",
  "",
  "`bdd:planned` deliberately exposes undefined future host-only behavior with a failing exit status. `bdd:usb` deliberately refuses to connect until the future adapter exists. Neither command deploys code. Read the [strategy](testing-strategy.md) before promoting scenarios or adding target adapters.",
  "",
];
for (const stage of plan.stages) {
  const covered = report.coverage.find((item) => item.id === stage.id);
  text.push(
    `## ${stage.id} ${stage.title}`,
    "",
    `**Depends on:** ${stage.dependsOn.length ? stage.dependsOn.join(", ") : "No preceding stage"}.`,
    "",
    `**Outcome:** ${stage.outcome}`,
    "",
    `[Canonical Gherkin](../${stage.feature}) · Stage gate tag: \`@${stage.id} and @stage_gate\`.`,
    "",
    "### Stage acceptance journey",
    "",
    "```gherkin",
    excerpt(covered.gate),
    "```",
    "",
  );
  for (const task of stage.substeps) {
    const taskCoverage = covered.substeps.find((item) => item.id === task.id);
    text.push(
      `### ${task.id} ${task.title}`,
      "",
      `**Implement:** ${task.deliverable}`,
      "",
      ...(task.designPrinciples?.length
        ? [
            `**Design principles:** ${task.designPrinciples.map((id) => `[${id}](instrument-design.md#decisions-and-acceptance-traceability)`).join(", ")}.`,
            "",
          ]
        : []),
      `**Acceptance selector:** \`@${task.id.replace(".", "_")}\`. Both flows below are required; target applicability is declared in the canonical feature and the testing strategy.`,
      "",
    );
    for (const scenario of taskCoverage.scenarios)
      text.push("```gherkin", excerpt(scenario), "```", "");
  }
}
text.push(
  "## Maintaining the plan",
  "",
  "Edit `acceptance/plan.json` and the canonical `.feature` files, run `npm run bdd:plan`, then regenerate this document with `npm run bdd:docs`. The plan auditor checks syntax, unique IDs, dependency cycles and success/failure/gate traceability. It never converts a planned scenario into passing implementation evidence.",
  "",
);
const output = `${text.join("\n").trimEnd()}\n`;
const path = resolve(root, "docs/implementation-plan.md");
if (process.argv.includes("--check")) {
  if (readFileSync(path, "utf8") !== output)
    throw new Error("Implementation plan is stale; run npm run bdd:docs");
  console.log("Implementation plan matches the canonical features and task manifest.");
} else {
  writeFileSync(path, output);
  console.log(
    `Wrote docs/implementation-plan.md with ${report.stageCount} gates and ${report.substepCount} substeps.`,
  );
}
