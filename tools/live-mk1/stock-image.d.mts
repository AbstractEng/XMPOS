export function prepareVerifiedStock(
  imagePath: string,
  cacheDirectory: string,
  options?: { maxBytes?: number },
): Promise<{ image: string; sha256: string; label: string; receipt: Record<string, unknown> }>;
export function stockImageFromUpdater(
  app: string,
): Promise<{ image: string; sha256: string; label: string; receipt: Record<string, unknown> }>;
