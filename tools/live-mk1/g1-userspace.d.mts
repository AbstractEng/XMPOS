export const G1_COMPONENTS: {
  id: string;
  archive: string;
  directory: string;
  license: string;
  tools?: string[];
}[];
export function verifyG1Archives(catalog?: {
  downloaded: { localPath: string; sha256: string; path: string }[];
}): Promise<{ id: string; archive: string; path: string; sha256: string; officialPath: string }[]>;
export function buildG1Userspace(): Promise<{
  directory: string;
  manifest: Record<string, unknown>;
}>;
