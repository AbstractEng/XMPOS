export const UBOOT: { version: string; url: string; sha256: string; pinning: string };
export function testBootScript(): Promise<{ directory: string; result: Record<string, unknown> }>;
