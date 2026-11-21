export function rewrite(
  argv: string[],
  env: Record<string, string | undefined>,
): { args: string[]; command: string };
