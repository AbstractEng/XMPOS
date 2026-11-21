export const EXPECTED_CHANGES: { changed: string[]; added: string[]; removed: string[] };
export function checkUpdater(app: string): { path: string; image: string };
export function diffLedgers(
  before: string,
  after: string,
): { changed: string[]; added: string[]; removed: string[] };
export function buildProbeImage(
  app: string,
  options?: { kind?: "probe" | "loader"; expectedUpdaterImageSha256?: string; host?: boolean },
): Promise<{ directory: string; manifest: Record<string, unknown> }>;
