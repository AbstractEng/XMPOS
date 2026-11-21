export interface Mount {
  device: string;
  mount: string;
  fstype: string;
  options: string[];
}
export interface ProbeInfo {
  compatible: string;
  model: string;
  serial: string;
  app: string;
  mounts: Mount[];
}
export const SDK: { url: string; commit: string; remoteSha256: string; dir: string };
export const MIN_VERSION: number[];
export const XMP_FOLDER_PREFIX: string;
export const COMMANDS: Record<string, { drive: boolean; write: boolean }>;
export const DIAG: string[];
export const PROBE: string;
export function parseProbe(text: string): ProbeInfo;
export function parseVersion(app: string): number[] | null;
export function serialHash(serial: string): string;
export function checkIdentity(
  info: ProbeInfo,
  recorded: string | null,
): { hash: string; version: string };
export function checkDrive(mounts: Mount[], wanted: string | null): string;
export function checkPluginSource(dir: string): string;
export function checkInstalledName(name: string): string;
export function parseArgs(argv: string[]): {
  address: string | null;
  command: string | null;
  items: string[];
  drive: string | null;
  outDir: string | null;
  yes: boolean;
  port: number;
};
export function sshArgs(address: string, port: number, policy: string, password: boolean): string[];
export function verifySdk(dir?: string): string;
export function stockVerificationAddress(address: string): string;
export function collectStockInstallProfile(
  address: string,
  options?: {
    ownerReadOnlyConfirmed?: boolean;
    stateDirectory?: string;
    askpass?: string | null;
    transport?: ((script: string) => string) | null;
    record?: (line: string) => void;
  },
): {
  board: string;
  mpcOsVersion: string;
  capacityBytes: number;
  reportSha256: string;
  receiptSha256: string;
  hardwareReadOnly: boolean;
};
