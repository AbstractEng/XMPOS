export const IMAGE_BYTES: number;
export const lockFile: string;
export function runtimeLockHash(): Promise<string>;
export function hashBytes(bytes: Uint8Array): string;
export function regularFile(
  path: string,
  maximum?: number,
): Promise<{ sha256: string; bytes: number }>;
export function readJson(path: string): Promise<Record<string, unknown>>;
export function inputDirectory(path: string): Promise<string>;
export function newArtifactDirectory(path: string): Promise<string>;
export function temporaryArtifact(prefix: string): Promise<string>;
export function publishArtifactPointer(name: string, value: unknown): Promise<void>;
export function pythonRuntime(args: string[]): Record<string, unknown>;
export function makeExt4(tree: string, output: string): Promise<Record<string, unknown>>;
export function writeManifest(path: string, manifest: unknown): Promise<void>;
