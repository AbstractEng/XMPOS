import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditMvp,
  type GateResult,
  loadMvp,
  type MvpManifest,
  summarizeMvp,
} from "../acceptance/lib/mvp.mjs";
import { requirementsBaseline } from "../acceptance/lib/provenance.mjs";

const root = resolve(import.meta.dirname, "..");
const scripts = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).scripts;
const mvp = loadMvp();
const first = (manifest: MvpManifest) => {
  const requirement = manifest.requirements[0];
  if (!requirement) throw new Error("MVP manifest has no requirements");
  return requirement;
};
const gate = (manifest: MvpManifest, name: string) => {
  const found = manifest.gates[name];
  if (!found) throw new Error(`Missing gate ${name}`);
  return found;
};

describe("XMP MVP traceability", () => {
  it("maps every requirement to sources, implemented scenarios and existing gates", () => {
    expect(auditMvp(mvp, scripts)).toEqual([]);
  });

  it("detects a requirement backed by a planned or missing scenario", () => {
    const broken = structuredClone(mvp);
    first(broken).scenarios.push(
      {
        feature: "features/11-usb-hardware.feature",
        name: "Test a deployed Live Mk1 over USB and continue playing after disconnect",
      },
      { feature: "features/18-device-workflow.feature", name: "Does not exist" },
    );
    const problems = auditMvp(broken, scripts);
    expect(problems.some((p) => p.includes("not @implemented"))).toBe(true);
    expect(problems.some((p) => p.includes("missing scenario"))).toBe(true);
  });

  it("rejects unknown sources, non-npm gates and hardware-facing scripts", () => {
    const broken = structuredClone(mvp);
    first(broken).sources = ["S99"];
    gate(broken, "check").command = ["sh", "-c", "true"];
    gate(broken, "device").command = ["npm", "run", "bdd:usb"];
    const problems = auditMvp(broken, scripts);
    expect(problems).toContain("MVP-01: source S99 is not a derived source statement");
    expect(problems.some((p) => p.startsWith("Gate check: only"))).toBe(true);
    expect(problems.some((p) => p.includes("hardware-facing"))).toBe(true);
  });

  it("validates a requirement only when all of its gates and the check gate pass", () => {
    const all: Record<string, GateResult | undefined> = Object.fromEntries(
      Object.keys(mvp.gates).map((g) => [g, "passed" as const]),
    );
    expect(summarizeMvp(mvp, all).validated).toBe(true);
    const partial = summarizeMvp(mvp, { ...all, "device-vm": undefined });
    expect(partial.validated).toBe(false);
    expect(partial.failed).toBe(false);
    expect(partial.requirements.find((r) => r.id === "MVP-08")?.status).toBe("not-run");
    const failed = summarizeMvp(mvp, { ...all, check: "failed" });
    expect(failed.failed).toBe(true);
    expect(failed.requirements.every((r) => r.status === "failed")).toBe(true);
  });

  it("keeps external specifications explicitly pending and hardware out of scope", () => {
    expect(mvp.sources.externalSpecification).toBe("pending");
    expect(mvp.excluded.some((item: string) => /Force/.test(item))).toBe(true);
    const baseline = requirementsBaseline();
    expect(baseline.externalSpecification.status).toBe("pending");
    expect(baseline.mvp.requirements).toHaveLength(mvp.requirements.length);
    expect(baseline.sources.map((s: { path: string }) => s.path)).toContain(
      "acceptance/sources/project-requirements.txt",
    );
  });

  it("keeps personal details out of the versioned requirement source", () => {
    const text = readFileSync(resolve(root, mvp.sources.requirements), "utf8");
    expect(text).not.toMatch(
      /https?:\/\/[^\s]*\/share\/|(?:^|\n)(?:User|Assistant):|\/(?:Users|home)\/[^/\s]+/i,
    );
  });
});
