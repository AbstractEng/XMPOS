export interface VerifiedTemplate {
  directory: string;
  manifest: Record<string, unknown>;
  image: { sha256: string; bytes: number };
  audit: {
    binaries: Record<string, unknown>;
    runtimeLibrariesIncluded: false;
    abiExecutionTested: false;
    fileHashes: Record<string, string>;
  };
  manifestFile: { sha256: string; bytes: number };
}
export function verifyTemplate(directory: string): Promise<VerifiedTemplate>;
export function assembleOwnerImage(
  templateDirectory: string,
  runtimeDirectory: string,
  destination: string,
  options?: { emulator?: boolean },
): Promise<{ directory: string; manifest: Record<string, unknown> }>;
