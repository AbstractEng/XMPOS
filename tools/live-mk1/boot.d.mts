export function newcArchive(stage: string): Promise<Buffer>;
export function testTone(): Buffer;
export function wavRms(bytes: Buffer): number;
export function parseBootLog(log: string): {
  began: boolean;
  ended: boolean;
  files: Record<string, string | null>;
  lists: Record<string, string[]>;
  tests: Record<string, { exit: number; output: string }>;
};
export function bootKernel(): Promise<{ directory: string; report: Record<string, unknown> }>;
export function onsets(bytes: Buffer, threshold?: number, quietSeconds?: number): number[];
export function timingGraph(): Record<string, unknown>;
