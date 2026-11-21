export function installPreflight(
  input: unknown,
  host: { platform: string; arch: string; osVersion: string; nodeMajor: number },
): {
  format: string;
  version: number;
  compatibilitySha256: string;
  observationsSatisfyProfile: boolean;
  publicInstallationAllowed: false;
  stops: { code: string; instruction: string }[];
  remainingReleaseEvidence: string[];
  plannedPortWork: string[];
  scope: string;
};
