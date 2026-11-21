export const DYNAMIC_BINARIES: readonly string[];
export function dynamicBuildRecipe(sourceHash: string): string;
export function buildDynamicTemplate(
  runtimeDirectory: string,
  options?: { builder?: "docker" | "host" },
): Promise<{ directory: string; manifest: Record<string, unknown> }>;
