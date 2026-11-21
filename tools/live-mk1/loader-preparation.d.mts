export function requirePreparationSpace(
  directory: string,
  requiredBytes: number,
  measure?: (directory: string) => Promise<{ bavail: number | bigint; bsize: number | bigint }>,
): Promise<number>;
export function reusableHostLoader(
  root: string,
  expected: {
    updaterSha256: string;
    stockSha256: string;
    initSha256: string;
    toolsSha256: string;
    stockBytes: number;
    files: Record<string, Buffer>;
  },
): Promise<{ directory: string; manifest: Record<string, unknown>; reused: true } | null>;
