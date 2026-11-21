export const PEAK_LIMIT: number;
export const PAD_SCRIPT: string;
export function SEQ_SCRIPT(): string;
export const EXPECTED_STARTUP: string;
export function feedbackBytesAllowed(sent: { public: string; private: string }): boolean;
export function hardware(): any;
export function canvasToRaw(x: number, y: number, hw?: unknown): [number, number];
export function canvasToFb(x: number, y: number, hw?: unknown): [number, number];
export function analyseWav(bytes: Buffer): {
  channels: number;
  rate: number;
  frames: number;
  peak: number;
  peaks: number[];
  loudSeconds: number;
};
export function onsets(bytes: Buffer, on?: number): number[];
export function parsePpm(bytes: Buffer): {
  width: number;
  height: number;
  pixel: (x: number, y: number) => [number, number, number];
};
export function sentBytes(received: string): { public: string; private: string };
export function testSessionInVm(options?: {
  icount?: string | null;
  only?: string[] | null;
  sessionDirectory?: string | null;
}): Promise<{ directory: string; result: Record<string, unknown> }>;
export function liveDtb(run: string, hw: unknown): Promise<string>;
export function liveLikeDevices(hw: unknown, stick: string, wav: string): string[];
export function deviceLayout(): any;
export function TRACKS_SCRIPT(layout?: unknown): string;
