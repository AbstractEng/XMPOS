import assert from "node:assert/strict";
import { copyFileSync, cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { After, Before, setDefaultTimeout } from "@cucumber/cucumber";
import { recordEvidence } from "../lib/evidence.mjs";
import { fixtureHash } from "../lib/fixtures.mjs";
import { buildIdentity, root, scenarioWorkspace, sha256 } from "../lib/workspace.mjs";

setDefaultTimeout(360000);
Before(function ({ pickle }) {
  this.workspace = scenarioWorkspace();
  this.additionalWorkspaces = [];
  this.artifacts = [];
  this.finalizers = [];
  this.deviceOperations = [];
  this.scenarioId = `${pickle.uri}:${pickle.name}`;
});
After(async function ({ result }) {
  const output =
    process.env.XMP_EVIDENCE_DIR ?? resolve(root, "reports/acceptance/manual/evidence");
  mkdirSync(output, { recursive: true });
  try {
    for (const finalize of [...this.finalizers].reverse()) await finalize();
    assert.equal(
      this.deviceOperations.length + (this.transportCalls ?? 0),
      0,
      "Physical operations are forbidden in host acceptance",
    );
    const nested = resolve(output, "nested", sha256(this.scenarioId).slice(0, 20));
    if (this.evidenceDirectory && existsSync(this.evidenceDirectory))
      cpSync(this.evidenceDirectory, nested, { recursive: true });
    if (this.contributorReports) {
      mkdirSync(nested, { recursive: true });
      for (const [name, path] of this.contributorReports) copyFileSync(path, resolve(nested, name));
    }
    const record = recordEvidence(
      output,
      {
        scenarioId: this.scenarioId,
        profile: "host-contract",
        buildHash: process.env.XMP_BUILD_HASH ?? buildIdentity(),
        fixtureHash,
        outcome: result.status.toLowerCase(),
        synthetic: false,
      },
      [
        {
          kind: "log",
          data: [{ event: "scenario-finished", outcome: result.status.toLowerCase() }],
        },
        ...this.artifacts,
      ],
    );
    await this.attach(JSON.stringify(record), "application/json");
    if (existsSync(nested))
      await this.attach(
        JSON.stringify({
          relatedReports: `nested/${sha256(this.scenarioId).slice(0, 20)}`,
          scope: "Nested contract evidence; synthetic targets remain marked synthetic",
        }),
        "application/json",
      );
  } finally {
    for (const workspace of [this.workspace, ...this.additionalWorkspaces]) workspace.close();
    writeFileSync(
      resolve(output, "device-io-audit.json"),
      JSON.stringify({
        scope: "No physical adapter supplied; host-only runner",
        operations: this.deviceOperations,
      }),
    );
  }
});
