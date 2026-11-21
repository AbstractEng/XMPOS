export interface WorkVolume {
  source: string;
  target: string;
}
export function dockerCreateArgs(options: {
  image: string;
  volumes?: WorkVolume[];
  command: string;
}): string[];
export function kernelInputsHash(): Promise<string>;
export function verifySource(
  lock?: import("./board.mjs").KernelLock,
): Promise<{ archive: string; sha256: string; bytes: number }>;
export function parseBootLog(log: string): {
  began: boolean;
  ended: boolean;
  files: Record<string, string | null>;
  lists: Record<string, string[]>;
  tests: Record<string, { exit: number; output: string }>;
};
export function buildKernel(): Promise<{ directory: string; manifest: Record<string, unknown> }>;
export function bootKernel(): Promise<{ directory: string; report: Record<string, unknown> }>;
