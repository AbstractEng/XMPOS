import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { json, root, sha256 } from "./workspace.mjs";

const mvpManifest = () => json(resolve(root, "acceptance/mvp.json"));
export function requirementsBaseline() {
  const plan = json(resolve(root, "acceptance/plan.json"));
  const sources = [
    "acceptance/sources/development-scope.txt",
    "acceptance/sources/project-requirements.txt",
    "docs/requirements.md",
    "acceptance/mvp.json",
    "docs/instrument-design.md",
    "references/design-sources.json",
    "acceptance/plan.json",
  ].map((path) => ({
    path,
    sha256: sha256(readFileSync(resolve(root, path))),
    kind: "versioned project requirement",
  }));
  return {
    version: 1,
    status: "versioned community development baseline",
    externalSpecification: {
      status: "pending",
      sha256: null,
      reason: "Only the versioned requirements in this repository are acceptance inputs",
      retrieval: "No external specification is included in this distribution",
    },
    mvp: {
      id: mvpManifest().id,
      promise: mvpManifest().promise,
      requirements: mvpManifest().requirements.map(({ id, title, sources, scenarios }) => ({
        id,
        title,
        sources,
        scenarios: scenarios.map(({ feature, name }) => ({ feature, name })),
      })),
      excluded: mvpManifest().excluded,
    },
    sources,
    requirements: plan.stages.flatMap((stage) =>
      stage.substeps.map((task) => ({
        id: `REQ-${task.id}`,
        owner: "XMP maintainer",
        scope: "V1",
        description: task.deliverable,
        source: "acceptance/plan.json",
        designPrinciples: task.designPrinciples ?? [],
        acceptance: { feature: stage.feature, tag: `@${task.id.replace(".", "_")}` },
      })),
    ),
    decisions: [
      "embedded audio stack",
      "script runtime",
      "UI host",
      "native plugin ABI",
      "hardware driver strategy",
      "installer and recovery route",
      "External specification reconciliation",
    ].map((subject, index) => ({
      id: `ADR-${String(index + 1).padStart(3, "0")}`,
      subject,
      status: "open",
      owner: "XMP maintainer",
    })),
  };
}
export function observeReference(previous, url, observation) {
  if (observation.error)
    return {
      state: { ...previous, error: "Upstream unavailable", checkedAt: observation.checkedAt },
      changes: previous?.error ? [] : [{ url, status: "unavailable", qualified: false }],
    };
  const changes = [];
  if (previous?.refs)
    for (const ref of new Set([...Object.keys(previous.refs), ...Object.keys(observation.refs)]))
      if (previous.refs[ref] !== observation.refs[ref])
        changes.push({
          url,
          ref,
          before: previous.refs[ref] ?? null,
          after: observation.refs[ref] ?? null,
          reviewRequired: true,
          hardwareImpact: "Unassessed: inspect hardware, boot and driver changes before use",
          licenceImpact:
            "Unassessed: review licence texts and redistribution obligations before use",
          qualified: false,
        });
  if (previous?.error) changes.push({ url, status: "available-again", qualified: false });
  return { state: { refs: observation.refs, checkedAt: observation.checkedAt }, changes };
}
export async function verifyArchive(path, expected) {
  if (!existsSync(path)) return { status: "unavailable", qualified: false };
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
    size += chunk.length;
  }
  const actual = hash.digest("hex");
  return {
    status: actual === expected.sha256 && size === expected.size ? "verified" : "unverified",
    sha256: actual,
    size,
    qualified: false,
    reason: "Reference-only; not an application dependency or redistribution approval",
  };
}
export function licenceLedger() {
  const lock = json(resolve(root, "package-lock.json"));
  const components = Object.entries(lock.packages)
    .filter(([path, item]) => path && item.version && !item.link)
    .map(([path, item]) => ({
      path,
      version: item.version,
      integrity: item.integrity ?? null,
      declaredLicence: item.license ?? "UNKNOWN",
      review: item.license ? "declared-metadata-only" : "review-required",
      role: item.dev ? "development" : "runtime",
    }));
  const references = json(resolve(root, "references/lock.json")).repositories.map((repo) => ({
    ...repo,
    licenceEvidence: (repo.licenseFiles ?? []).map((path) => {
      const local = resolve(root, "references/repos", repo.name, path);
      return { path, sha256: existsSync(local) ? sha256(readFileSync(local)) : null };
    }),
    role: "research-only",
    qualifiedBuildInput: false,
    redistributionReview:
      "pending component-level review; repository licence does not cover every bundled component",
  }));
  return {
    version: 1,
    components,
    references,
    policy:
      "No reference repository, firmware or archive is linked into the application. Monitor changes never alter package-lock.json or references/lock.json.",
  };
}
