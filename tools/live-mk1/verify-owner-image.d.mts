export function verifyOwnerImage(image: string): Promise<{
  bytes: Buffer;
  sha256: string;
  manifest: { target: string; mpcOsVersion: string; sourceHash: string };
  manifestSha256: string;
}>;
