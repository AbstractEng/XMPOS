export function loaderScript(source: string, ramdiskBytes: number): string;
export function buildHostLoader(
  app: string,
  options?: { expectedUpdaterImageSha256?: string },
): Promise<{ directory: string; manifest: Record<string, unknown> }>;
