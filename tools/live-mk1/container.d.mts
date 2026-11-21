export const WORK_VOLUME: string;
export interface WorkVolume {
  source: string;
  target: string;
}
export function sha256File(path: string): Promise<string>;
export function dockerCreateArgs(options: {
  image: string;
  volumes?: WorkVolume[];
  command: string;
}): string[];
export const BUILDER_LAYERS: readonly { tag: string; dockerfile: string }[];
export function builderPlan(tag: string): { tag: string; dockerfile: string }[];
export function inspectDocker(
  probe?: (
    command: string,
    args: string[],
    options: { timeout: number; encoding: string; maxBuffer: number },
  ) => { error?: { code?: string }; status: number | null; stdout?: string },
): { ready: boolean; reason?: string; os?: string };
export function ensureBuilder(
  lock: { builder: { tag: string; dockerfile: string } },
  options?: { noCache?: boolean },
): string;
export function runContainer(options: {
  image: string;
  volumes?: WorkVolume[];
  copyIn: { from: string; to: string }[];
  command: string;
  out: string;
  timeout: number;
}): Promise<string>;
