export const MPC_RUNTIME: Readonly<{
  mpcOsVersion: "3.10.1";
  updaterImageSha256: string;
  rootfsSha256: string;
  files: { source: string; destination: string; sha256: string; bytes: number }[];
}>;
export function requireSupportedUpdater(imageSha256: string): void;
export const COMPATIBILITY: Readonly<{
  baseline: { mpcOsVersion: string; updaterImageSha256: string; rootfsSha256: string };
  publicInstallationCleared: false;
  models: {
    id: string;
    name: string;
    board: string | null;
    status: string;
    ownerRehearsalTarget: boolean;
    firmware: string;
    platform: string;
    audio: string;
    bootloader?: string;
    testedSoc?: string;
  }[];
  host: {
    platform: string;
    arch: string;
    osVersion: string;
    nodeMajor: number;
    observed: string;
    scope: string;
  };
  storage: {
    filesystem: string;
    labels: string[];
    observedCapacityBytes: number;
    minimumCapacityBytes: number;
    minimumFreeBytes: number;
    minimumWorkspaceFreeBytes: number;
    budgetStatus: string;
    scope: string;
  };
  openEvidence: string[];
  plannedPortWork: string[];
  stopInstruction: string;
}>;
