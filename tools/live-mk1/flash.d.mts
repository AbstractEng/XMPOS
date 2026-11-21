export const FLASH_CONFIRMATION: "XMPOS";
export const UNLOCK: string;
export function fastbootArgs(step: string, image?: string): string[];
export function getvarValue(output: string, name: string): string | null;
export type Fastboot = (args: string[]) => { status: number; output: string };
export function systemFastboot(args: string[]): { status: number; output: string };
export function verifiedSystemFastboot(
  args: string[],
  pin: { executable: string; sha256: string },
): { status: number; output: string };
export function readIdentity(
  fastboot: Fastboot,
  record?: (line: string) => void | Promise<void>,
  onUnimplemented?: (name: string) => void,
): Promise<Record<string, string | null>>;
export function verifiedXmpImage(
  directory: string,
): Promise<{ image: string; sha256: string; label: string }>;
export function stockImageFromUpdater(
  app: string,
): Promise<{ image: string; sha256: string; label: string }>;
export function runFlash(options: {
  operation: "status" | "flash-rootfs" | "restore-stock";
  source?: string;
  dryRun?: boolean;
  fastboot?: Fastboot;
  expectedImageSha256?: string;
  expectedHardwareObservationSha256?: string | null;
  expectedIdentity?: Record<string, string | null>;
  answers?: { identity?: string; flash?: string };
  log?: (line: string) => void;
  stateDirectory?: string;
}): Promise<Record<string, unknown>>;
