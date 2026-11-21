export const BRIDGE_ID: { vendor: number; product: number; name: string };
export const CABLE_ID: { vendor: number; product: number; name: string };
export const CABLE_BAUD: number;
export function parseIoreg(
  text: string,
): { name: string; vendor: number | null; product: number | null; callouts: string[] }[];
export function chooseBridge(devices: ReturnType<typeof parseIoreg>): string;
export function chooseLink(devices: ReturnType<typeof parseIoreg>): {
  kind: "cable" | "gadget";
  port: string;
};
export function frame(payload: string | Buffer): Buffer;
export class FrameReader {
  push(chunk: Buffer): void;
  next(timeoutMs?: number): Promise<Buffer>;
}
export function screenshotPng(
  raw: Buffer,
  info: { width: number; height: number; red?: number; green?: number; blue?: number },
  rotation?: number,
): Buffer;
export function openBridge(options?: {
  socket?: string | null;
  token?: string | null;
  log?: string | null;
}): Promise<any>;
export function bridgeCommand(
  bridge: any,
  command: string,
  args: string[],
  outDir: string,
): Promise<any>;
export function prepareStick(): Promise<{ ok: boolean; stick: string }>;
export function readToken(file?: string): string;
export function unpackRle(packed: Buffer, size: number): Buffer;
export function packSparse(bytes: Buffer, block?: number): Buffer;
