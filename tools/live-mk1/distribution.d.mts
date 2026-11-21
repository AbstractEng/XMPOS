export const INSTALL_STEPS: readonly string[];
export const PUBLIC_FILES: readonly string[];
export function verifyInstallation(
  reviewDirectory: string,
  expected: {
    target: string;
    sourceHash: string;
    publicTemplateSha256: string;
    templateManifestSha256: string;
    updaterImageSha256: string;
  },
): Promise<{
  sha256: string;
  ownerEvidenceBindingsVerified: boolean;
  independentlyWitnessed: boolean;
}>;
export function planDistribution(
  sessionDirectory: string,
  reviewDirectory: string,
): Promise<{
  record: Record<string, unknown>;
  installation: Record<string, unknown>;
  inputs: Record<string, string>;
  sourceHash: string;
  publicFiles: readonly string[];
  published: boolean;
}>;
export function packDistribution(
  sessionDirectory: string,
  reviewDirectory: string,
  destination: string,
): Promise<Record<string, unknown>>;
