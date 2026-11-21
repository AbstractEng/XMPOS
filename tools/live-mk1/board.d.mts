export type Role = "target" | "protected" | "not-target" | "unknown";
export interface KernelLock {
  target: {
    product: string;
    productCode: string;
    compatible: string;
    boards: { dtb: string; soc: string }[];
  };
  protected: { compatible: string; product: string }[];
  notTarget: { compatible: string; product: string }[];
  source: { archive: string; sha256: string; bytes: number; root: string; kernelVersion: string };
  config: { defconfig: string; fragment: string; required: Record<string, string> };
  builder: { image: string; tag: string; dockerfile: string };
  vm: { machine: string; cpu: string; bootLimitSeconds: number; scope: string };
  outputs: { deployable: boolean; excluded: string[] };
}
export interface BoardDescription {
  model: string | null;
  compatible: string[];
  role: Role;
  product: string | null;
  productCode: string | null;
  soc: string | null;
  display: {
    panel: string | null;
    rotation: number | null;
    boardRotation: number | null;
    touchControllers: string[];
  };
  power: { battery: string[]; mains: boolean };
  usbHub: string[];
  gpioKeys: boolean;
  leds: boolean;
  internalSd: boolean;
  rtc: boolean;
}
export function kernelLock(): KernelLock;
export function classifyCompatible(
  compatible: string[] | Buffer,
  lock?: KernelLock,
): { role: Role; product: string | null };
export function describeBoard(dtb: Uint8Array, lock?: KernelLock): BoardDescription;
export function assertLiveTarget(board: BoardDescription): BoardDescription;
export function parseKernelConfig(text: string): Map<string, string>;
export function auditFragment(
  official: Map<string, string>,
  merged: Map<string, string>,
  required: Record<string, string>,
  explicitlyDisabled?: Set<string>,
): string[];
export function explicitlyDisabled(defconfigText: string): Set<string>;
