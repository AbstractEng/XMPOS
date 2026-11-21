export function prunable(
  names: string[],
  options?: { pointed?: Set<string>; cited?: Set<string>; age?: (name: string) => number },
): string[];
export function prune(options?: { dry?: boolean; log?: (line: string) => void }): string[];
