import type { UsageSnapshot } from "../../apps/studio/src/usage-schema.ts";
export const RETENTION_SECONDS: number;
export const UPSERT_SESSION: string;
export function validateSnapshot(value: unknown): value is UsageSnapshot;
export function authorized(request: Request, hash: string | undefined): Promise<boolean>;
export function collectUsage(request: Request, env: unknown, now?: number): Promise<Response>;
export function usageReport(request: Request, env: unknown, now?: number): Promise<Response>;
export function pruneUsage(env: unknown, now?: number): Promise<void>;
