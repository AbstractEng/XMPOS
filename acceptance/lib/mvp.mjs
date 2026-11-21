import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";
import { json, root, sha256 } from "./workspace.mjs";

export const MVP_TIERS = ["core", "browser", "vm"];

export function loadMvp(path = resolve(root, "acceptance/mvp.json")) {
  return json(path);
}

// Scenario names with their effective tags (feature + rule + scenario).
export function featureScenarios(path) {
  const source = readFileSync(resolve(root, path), "utf8");
  const envelopes = generateMessages(source, path, SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN, {
    includeGherkinDocument: true,
    includePickles: false,
    newId: IdGenerator.incrementing(),
  });
  const parseError = envelopes.find((envelope) => envelope.parseError);
  if (parseError) throw new Error(`${path}: ${parseError.parseError.message}`);
  const feature = envelopes.find((envelope) => envelope.gherkinDocument)?.gherkinDocument.feature;
  const scenarios = new Map();
  if (!feature) return scenarios;
  const walk = (children, tags) => {
    for (const child of children) {
      if (child.rule) walk(child.rule.children, [...tags, ...child.rule.tags.map((t) => t.name)]);
      if (child.scenario)
        scenarios.set(child.scenario.name, [
          ...tags,
          ...child.scenario.tags.map((t) => t.name),
          ...child.scenario.examples.flatMap((example) => example.tags.map((t) => t.name)),
        ]);
    }
  };
  walk(
    feature.children,
    feature.tags.map((t) => t.name),
  );
  return scenarios;
}

// Returns a list of traceability problems; an empty list means the manifest is sound.
export function auditMvp(mvp, scripts) {
  const problems = [];
  const sourceText = readFileSync(resolve(root, mvp.sources.requirements), "utf8");
  const ids = new Set();
  const cache = new Map();
  for (const requirement of mvp.requirements) {
    if (ids.has(requirement.id)) problems.push(`Duplicate requirement ${requirement.id}`);
    ids.add(requirement.id);
    if (!requirement.sources.length) problems.push(`${requirement.id}: no source statement`);
    for (const source of requirement.sources)
      if (!sourceText.includes(`\n${source} `))
        problems.push(`${requirement.id}: source ${source} is not a derived source statement`);
    if (!requirement.scenarios.length) problems.push(`${requirement.id}: no acceptance scenario`);
    for (const { feature, name } of requirement.scenarios) {
      if (!cache.has(feature)) cache.set(feature, featureScenarios(feature));
      const tags = cache.get(feature).get(name);
      if (!tags) problems.push(`${requirement.id}: missing scenario "${name}" in ${feature}`);
      else if (!tags.includes("@implemented"))
        problems.push(`${requirement.id}: scenario "${name}" is not @implemented`);
      else if (tags.includes("@planned"))
        problems.push(`${requirement.id}: scenario "${name}" is still @planned`);
    }
    if (!requirement.gates.length) problems.push(`${requirement.id}: no verification gate`);
    for (const gate of requirement.gates)
      if (!mvp.gates[gate]) problems.push(`${requirement.id}: unknown gate ${gate}`);
  }
  for (const [name, gate] of Object.entries(mvp.gates)) {
    if (!MVP_TIERS.includes(gate.tier)) problems.push(`Gate ${name}: unknown tier ${gate.tier}`);
    const [program, verb, script] = gate.command;
    if (program !== "npm" || verb !== "run" || gate.command.length !== 3)
      problems.push(`Gate ${name}: only "npm run <script>" commands are allowed`);
    else if (!scripts[script]) problems.push(`Gate ${name}: npm script ${script} does not exist`);
    else if (/usb|deploy|flash|install|lab:demo/i.test(`${script} ${scripts[script]}`))
      problems.push(`Gate ${name}: hardware-facing scripts cannot be MVP gates`);
  }
  const used = new Set(mvp.requirements.flatMap((requirement) => requirement.gates));
  for (const name of Object.keys(mvp.gates))
    if (name !== "check" && !used.has(name)) problems.push(`Gate ${name} verifies no requirement`);
  return problems;
}

// Each requirement is validated only when every one of its gates ran and passed.
export function summarizeMvp(mvp, results) {
  const requirements = mvp.requirements.map((requirement) => {
    const gates = [...requirement.gates, "check"].map((gate) => results[gate] ?? "not-run");
    const status = gates.includes("failed")
      ? "failed"
      : gates.includes("not-run")
        ? "not-run"
        : "validated";
    return { id: requirement.id, title: requirement.title, status };
  });
  const gateStates = Object.keys(mvp.gates).map((gate) => results[gate] ?? "not-run");
  return {
    validated: requirements.every((requirement) => requirement.status === "validated"),
    failed: gateStates.includes("failed"),
    requirements,
  };
}

export function mvpSourceHashes(mvp) {
  return [mvp.sources.requirements, mvp.sources.scope, "acceptance/mvp.json"].map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
  }));
}
