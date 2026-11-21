import type { ParityPlan, ParityResult } from "../../packages/sdk/src/parity.ts";
export const nativeRoot: string;
export function compileParity(
  directory: string,
  options?: { linuxVm?: boolean; zig?: string },
): Promise<{ binary: string; receipt: { binarySha256: string; [key: string]: unknown } }>;
export function encodePlan(input: unknown): Buffer;
export function decodeResult(bytes: Buffer): ParityResult;
export function nativeParity(
  binary: string,
  plan: ParityPlan,
  directory: string,
  name?: string,
): Promise<ParityResult>;
