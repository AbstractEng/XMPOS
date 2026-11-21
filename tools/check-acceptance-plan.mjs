import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMessages } from "@cucumber/gherkin";
import { IdGenerator, SourceMediaType } from "@cucumber/messages";

export function analyzePlan(plan, files) {
  const errors = [];
  const scenarios = [];
  const names = new Set();
  let expandedScenarios = 0;
  const stageIds = new Set(plan.stages.map((stage) => stage.id));
  if (stageIds.size !== plan.stages.length) errors.push("Stage IDs must be unique");
  const taskIds = new Set();
  for (const stage of plan.stages) {
    for (const dependency of stage.dependsOn)
      if (!stageIds.has(dependency)) errors.push(`${stage.id}: unknown dependency ${dependency}`);
    for (const task of stage.substeps) {
      if (taskIds.has(task.id)) errors.push(`Duplicate substep ${task.id}`);
      if (!task.id.startsWith(`${stage.id}.`)) errors.push(`${task.id}: wrong parent stage`);
      taskIds.add(task.id);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) {
      errors.push(`Dependency cycle at ${id}`);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of plan.stages.find((stage) => stage.id === id)?.dependsOn ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const stage of plan.stages) visit(stage.id);
  for (const [path, source] of Object.entries(files)) {
    const envelopes = generateMessages(
      source,
      path,
      SourceMediaType.TEXT_X_CUCUMBER_GHERKIN_PLAIN,
      {
        includeGherkinDocument: true,
        includePickles: true,
        newId: IdGenerator.incrementing(),
      },
    );
    for (const envelope of envelopes) {
      if (envelope.parseError) errors.push(`${path}: ${envelope.parseError.message}`);
      if (envelope.pickle) expandedScenarios++;
    }
    const feature = envelopes.find((envelope) => envelope.gherkinDocument)?.gherkinDocument.feature;
    if (!feature) continue;
    const inherited = feature.tags.map((tag) => tag.name);
    function walk(children, tags, backgroundSteps = []) {
      let background = backgroundSteps;
      for (const child of children) {
        if (child.background) background = [...backgroundSteps, ...child.background.steps];
        if (child.rule)
          walk(
            child.rule.children,
            [...tags, ...child.rule.tags.map((tag) => tag.name)],
            background,
          );
        if (!child.scenario) continue;
        const scenario = child.scenario;
        const effective = [...tags, ...scenario.tags.map((tag) => tag.name)];
        if (names.has(scenario.name)) errors.push(`Duplicate scenario name: ${scenario.name}`);
        names.add(scenario.name);
        const steps = [...background, ...scenario.steps];
        const keywords = steps.map((step) => step.keyword.trim());
        if (!keywords.includes("Given") || !keywords.includes("When") || !keywords.includes("Then"))
          errors.push(`${path}:${scenario.location.line}: scenario needs Given, When and Then`);
        if (effective.includes("@implemented") === effective.includes("@planned"))
          errors.push(
            `${path}:${scenario.location.line}: exactly one of @implemented or @planned is required`,
          );
        const profiles = ["@standalone", "@host_only", "@desktop", "@native", "@os_vm", "@usb_lab"];
        if (!profiles.some((profile) => effective.includes(profile)))
          errors.push(`${path}:${scenario.location.line}: no target profile`);
        if (
          effective.includes("@host_only") &&
          (effective.includes("@usb_lab") || effective.includes("@hardware_only"))
        )
          errors.push(
            `${path}:${scenario.location.line}: host-only scenarios cannot require device contact`,
          );
        for (const tag of effective.filter((tag) => /^@P\d\d_\d+$/.test(tag))) {
          if (!taskIds.has(tag.slice(1).replace("_", ".")))
            errors.push(`${path}:${scenario.location.line}: unknown task ${tag}`);
        }
        if (effective.includes("@hardware_only") && !effective.includes("@usb_lab"))
          errors.push(
            `${path}:${scenario.location.line}: hardware-only scenario must require the USB lab`,
          );
        scenarios.push({
          path,
          name: scenario.name,
          line: scenario.location.line,
          tags: effective,
          stepCount: steps.length,
        });
      }
    }
    walk(feature.children, inherited);
  }
  const coverage = plan.stages.map((stage) => {
    const gates = scenarios.filter(
      (scenario) =>
        scenario.path === stage.feature &&
        scenario.tags.includes("@stage_gate") &&
        scenario.tags.includes(`@${stage.id}`),
    );
    if (gates.length !== 1)
      errors.push(`${stage.id}: expected exactly one end-to-end stage gate in ${stage.feature}`);
    return {
      id: stage.id,
      gate: gates[0] ?? null,
      substeps: stage.substeps.map((task) => {
        const tag = `@${task.id.replace(".", "_")}`;
        const cases = scenarios.filter(
          (scenario) => scenario.path === stage.feature && scenario.tags.includes(tag),
        );
        if (!cases.some((scenario) => scenario.tags.includes("@positive")))
          errors.push(`${task.id}: missing planned positive scenario`);
        if (!cases.some((scenario) => scenario.tags.includes("@negative")))
          errors.push(`${task.id}: missing planned failure scenario`);
        return { id: task.id, scenarios: cases };
      }),
    };
  });
  return {
    errors,
    stageCount: plan.stages.length,
    substepCount: taskIds.size,
    scenarioCount: scenarios.length,
    scenarios,
    expandedScenarios,
    implementedDefinitions: scenarios.filter((scenario) => scenario.tags.includes("@implemented"))
      .length,
    plannedDefinitions: scenarios.filter((scenario) => scenario.tags.includes("@planned")).length,
    coverage,
  };
}

export function checkWorkspace(root) {
  const plan = JSON.parse(readFileSync(resolve(root, "acceptance/plan.json"), "utf8"));
  const files = Object.fromEntries(
    readdirSync(resolve(root, "features"))
      .filter((path) => path.endsWith(".feature"))
      .sort()
      .map((path) => [`features/${path}`, readFileSync(resolve(root, "features", path), "utf8")]),
  );
  return analyzePlan(plan, files);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const report = checkWorkspace(root);
  mkdirSync(resolve(root, "reports/acceptance"), { recursive: true });
  writeFileSync(
    resolve(root, "reports/acceptance/plan-coverage.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  if (report.errors.length) {
    console.error(report.errors.join("\n"));
    process.exitCode = 1;
  } else
    console.log(
      `${report.stageCount} stages, ${report.substepCount} substeps, ${report.scenarioCount} scenario definitions (${report.expandedScenarios} expanded cases): syntax and traceability valid. ${report.plannedDefinitions} planned definitions have NOT been executed or qualified.`,
    );
}
