export type MvpTier = "core" | "browser" | "vm";
export type GateResult = "passed" | "failed" | "not-run";

export interface MvpScenarioRef {
  feature: string;
  name: string;
}
export interface MvpRequirement {
  id: string;
  title: string;
  sources: string[];
  need: string;
  scenarios: MvpScenarioRef[];
  gates: string[];
}
export interface MvpGate {
  command: string[];
  tier: MvpTier;
}
export interface MvpManifest {
  version: number;
  id: string;
  title: string;
  promise: string;
  sources: { requirements: string; scope: string; externalSpecification: string };
  requirements: MvpRequirement[];
  excluded: string[];
  gates: Record<string, MvpGate>;
}
export interface MvpSummary {
  validated: boolean;
  failed: boolean;
  requirements: { id: string; title: string; status: GateResult | "validated" }[];
}

export const MVP_TIERS: MvpTier[];
export function loadMvp(path?: string): MvpManifest;
export function featureScenarios(path: string): Map<string, string[]>;
export function auditMvp(mvp: MvpManifest, scripts: Record<string, string>): string[];
export function summarizeMvp(
  mvp: MvpManifest,
  results: Record<string, GateResult | undefined>,
): MvpSummary;
export function mvpSourceHashes(mvp: MvpManifest): { path: string; sha256: string }[];
