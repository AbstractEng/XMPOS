export function preflightTarget(request: {
  profile: string;
  device?: Record<string, unknown>;
  transport?: unknown;
  operation?: string;
}): { profile: string; physicalTransport: boolean; operation?: string };
export function openTarget(
  request: Parameters<typeof preflightTarget>[0],
  transportFactory: (target: unknown) => unknown,
): Promise<unknown>;
