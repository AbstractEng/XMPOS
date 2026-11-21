export type RootfsObservation = {
  serialSha256: string;
  board: string;
  soc: string;
  rootfsPartition: string;
  capacityBytes: number;
  serialHashes?: string[];
};
export function validateHardwareObservation(
  receipt: unknown,
  report: Uint8Array,
): RootfsObservation & { serialHashes: string[]; source: string };
export function parseRootfsObservation(text: string): RootfsObservation;
export function loadHardwareObservation(
  stateDirectory: string,
  identity: Record<string, string | null>,
): Promise<
  (RootfsObservation & { reportSha256: string; receiptSha256: string; source: string }) | null
>;
