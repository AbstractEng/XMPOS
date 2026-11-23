import { isUsageCounter, isUsagePage, USAGE_MAX_MS } from "../../apps/studio/src/usage-schema.ts";

export const RETENTION_SECONDS = 90 * 86400;
const limit = 64 * 1024;
const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
    },
  });
const integer = (v, max) => Number.isSafeInteger(v) && v >= 0 && v <= max;
export function validateSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const fields = [
    "version",
    "id",
    "seq",
    "workspace",
    "elapsedMs",
    "activeMs",
    "visibleMs",
    "playMs",
    "recordMs",
    "pages",
    "counters",
  ];
  if (
    Object.keys(value).length !== fields.length ||
    Object.keys(value).some((k) => !fields.includes(k))
  )
    return false;
  if (
    value.version !== 1 ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) ||
    !integer(value.seq, 1000000) ||
    value.seq === 0 ||
    !["device", "studio"].includes(value.workspace)
  )
    return false;
  for (const key of ["elapsedMs", "activeMs", "visibleMs", "playMs", "recordMs"])
    if (!integer(value[key], USAGE_MAX_MS)) return false;
  if (
    [value.activeMs, value.visibleMs, value.playMs, value.recordMs].some((n) => n > value.elapsedMs)
  )
    return false;
  for (const field of ["pages", "counters"])
    if (!value[field] || typeof value[field] !== "object" || Array.isArray(value[field]))
      return false;
  if (
    Object.keys(value.pages).length > 12 ||
    Object.entries(value.pages).some(([key, n]) => !isUsagePage(key) || !integer(n, value.activeMs))
  )
    return false;
  if (Object.values(value.pages).reduce((a, b) => a + b, 0) > value.activeMs) return false;
  if (
    Object.keys(value.counters).length > 800 ||
    Object.entries(value.counters).some(([key, n]) => !isUsageCounter(key) || !integer(n, 1000000))
  )
    return false;
  return true;
}
async function boundedJson(request) {
  if (Number(request.headers.get("Content-Length")) > limit) throw new RangeError();
  if (!request.body) throw new SyntaxError();
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      throw new RangeError();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(all));
}
async function rateLimit(request, env, kind) {
  // The address is used transiently by Cloudflare's rate limiter, never stored
  // in the analytics database or returned in dashboard results.
  return (
    !env.ANALYTICS_LIMIT ||
    (
      await env.ANALYTICS_LIMIT.limit({
        key: `${kind}:${request.headers.get("CF-Connecting-IP") ?? "local"}`,
      })
    ).success
  );
}
export const UPSERT_SESSION = `INSERT INTO usage_sessions
(session_id,seq,site,workspace,first_seen,last_seen,elapsed_ms,active_ms,visible_ms,play_ms,record_ms,pages,counters)
VALUES (?1,?2,?3,?4,?5,?5,?6,?7,?8,?9,?10,?11,?12)
ON CONFLICT(session_id) DO UPDATE SET
seq=excluded.seq,last_seen=excluded.last_seen,
elapsed_ms=MAX(elapsed_ms,excluded.elapsed_ms),active_ms=MAX(active_ms,excluded.active_ms),
visible_ms=MAX(visible_ms,excluded.visible_ms),play_ms=MAX(play_ms,excluded.play_ms),record_ms=MAX(record_ms,excluded.record_ms),
pages=excluded.pages,counters=excluded.counters
WHERE excluded.seq > usage_sessions.seq AND excluded.site = usage_sessions.site AND excluded.workspace = usage_sessions.workspace`;
export async function collectUsage(request, env, now = Math.floor(Date.now() / 1000)) {
  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const url = new URL(request.url);
  if (
    request.headers.get("Origin") !== url.origin ||
    ["cross-site", "same-site"].includes(request.headers.get("Sec-Fetch-Site"))
  )
    return json({ error: "Forbidden" }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().startsWith("application/json"))
    return json({ error: "JSON required" }, 415);
  if (!(await rateLimit(request, env, "collect"))) return json({ error: "Too many requests" }, 429);
  let value;
  try {
    value = await boundedJson(request);
  } catch (e) {
    return json(
      { error: e instanceof RangeError ? "Report too large" : "Invalid report" },
      e instanceof RangeError ? 413 : 400,
    );
  }
  if (!validateSnapshot(value)) return json({ error: "Invalid report" }, 400);
  if (!env.ANALYTICS_DB) return json({ error: "Analytics unavailable" }, 503);
  try {
    await env.ANALYTICS_DB.prepare(UPSERT_SESSION)
      .bind(
        value.id,
        value.seq,
        url.hostname,
        value.workspace,
        now,
        value.elapsedMs,
        value.activeMs,
        value.visibleMs,
        value.playMs,
        value.recordMs,
        JSON.stringify(value.pages),
        JSON.stringify(value.counters),
      )
      .run();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error(JSON.stringify({ type: "xmp-analytics-write-failed" }));
    return json({ error: "Analytics unavailable" }, 503);
  }
}
export async function authorized(request, hash) {
  if (!/^[a-f0-9]{64}$/.test(hash ?? "")) return false;
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("Authorization") ?? "",
  )?.[1];
  if (!token) return false;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  // Always compare all digest bytes. The original 256-bit key is never stored
  // in the Worker, a URL, a cookie or a static dashboard bundle.
  let difference = 0;
  for (let i = 0; i < 32; ++i)
    difference |= digest[i] ^ Number.parseInt(hash.slice(i * 2, i * 2 + 2), 16);
  return difference === 0;
}
export function reportStatements(db, since) {
  const where = "first_seen >= ?1";
  return [
    db
      .prepare(
        `SELECT COUNT(*) AS sessions,COALESCE(SUM(active_ms),0) AS active_ms,COALESCE(SUM(visible_ms),0) AS visible_ms,COALESCE(SUM(play_ms),0) AS play_ms,COALESCE(SUM(record_ms),0) AS record_ms,COALESCE(AVG(active_ms),0) AS average_active_ms FROM usage_sessions WHERE ${where}`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT date(first_seen,'unixepoch') AS day,COUNT(*) AS sessions,SUM(active_ms) AS active_ms,SUM(play_ms) AS play_ms,SUM(record_ms) AS record_ms FROM usage_sessions WHERE ${where} GROUP BY day ORDER BY day`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT j.key AS name,SUM(j.value) AS count,COUNT(*) AS sessions FROM usage_sessions,json_each(counters) AS j WHERE ${where} GROUP BY j.key ORDER BY count DESC LIMIT 800`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT j.key AS name,SUM(j.value) AS active_ms,COUNT(*) AS sessions FROM usage_sessions,json_each(pages) AS j WHERE ${where} GROUP BY j.key ORDER BY active_ms DESC`,
      )
      .bind(since),
    db
      .prepare(
        `SELECT workspace,site,COUNT(*) AS sessions,SUM(active_ms) AS active_ms FROM usage_sessions WHERE ${where} GROUP BY workspace,site`,
      )
      .bind(since),
  ];
}
export async function usageReport(request, env, now = Math.floor(Date.now() / 1000)) {
  if (request.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!(await rateLimit(request, env, "report"))) return json({ error: "Too many requests" }, 429);
  if (!(await authorized(request, env.ANALYTICS_KEY_HASH)))
    return json({ error: "Dashboard key required" }, 401);
  const days = Number(new URL(request.url).searchParams.get("days") ?? 7);
  if (![1, 7, 30, 90].includes(days)) return json({ error: "Choose 1, 7, 30 or 90 days" }, 400);
  const since = Math.floor(now / 86400) * 86400 - (days - 1) * 86400;
  if (!env.ANALYTICS_DB) return json({ error: "Analytics unavailable" }, 503);
  try {
    const results = await env.ANALYTICS_DB.batch(reportStatements(env.ANALYTICS_DB, since));
    return json({
      version: 1,
      days,
      since: new Date(since * 1000).toISOString(),
      generatedAt: new Date(now * 1000).toISOString(),
      summary: results[0].results[0],
      daily: results[1].results,
      counters: results[2].results,
      pages: results[3].results,
      workspaces: results[4].results,
    });
  } catch {
    console.error(JSON.stringify({ type: "xmp-analytics-report-failed" }));
    return json({ error: "Analytics unavailable" }, 503);
  }
}
export async function pruneUsage(env, now = Math.floor(Date.now() / 1000)) {
  await env.ANALYTICS_DB.prepare("DELETE FROM usage_sessions WHERE last_seen < ?1")
    .bind(now - RETENTION_SECONDS)
    .run();
}
