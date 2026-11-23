import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageSession } from "../apps/studio/src/usage.ts";
import { USAGE_ACTIONS, type UsageSnapshot } from "../apps/studio/src/usage-schema.ts";
import { decodeBase64 } from "../packages/core/src/engine.ts";
import { DEVICE_UI_WASM_BASE64 } from "../packages/core/src/generated/xmp-device-ui-wasm.ts";
import {
  authorized,
  collectUsage,
  pruneUsage,
  usageReport,
  validateSnapshot,
} from "../tools/web-host/analytics.mjs";
import worker from "../tools/web-host/worker.mjs";

const id = "55b8d728-2513-4417-8e1b-3cf782a21f2d";
const token = "Q".repeat(43);
const hash = createHash("sha256").update(token).digest("hex");
const origin = "https://abstracteng.com";
const now = 1800000000;
function snapshot(): UsageSnapshot {
  return {
    version: 1,
    id,
    seq: 1,
    workspace: "device",
    elapsedMs: 30000,
    activeMs: 25000,
    visibleMs: 30000,
    playMs: 12000,
    recordMs: 3000,
    pages: { clips: 20000, sample: 5000 },
    counters: { "feature:sample_arm": 1, "control:rec:sample": 1, "machine:sampler": 1 },
  };
}
function request(value: unknown, extra: RequestInit = {}) {
  return new Request(`${origin}/xmpos/api/analytics/collect`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
    ...extra,
  });
}
function database() {
  const sql = new DatabaseSync(":memory:");
  sql.exec(readFileSync("tools/web-host/migrations/0001_usage.sql", "utf8"));
  const db = {
    prepare(query: string) {
      const statement = sql.prepare(query);
      return {
        bind(...values: SQLInputValue[]) {
          // D1's numbered parameters are positional; node:sqlite uses named
          // bindings for ?N, so normalize the query without changing SQL logic.
          const normalized = sql.prepare(query.replace(/\?\d+/g, "?"));
          const matches = [...query.matchAll(/\?(\d+)/g)];
          const ordered = matches.map((m) => values[Number(m[1]) - 1] ?? null);
          return {
            run: async () => ({ success: true, results: [], meta: normalized.run(...ordered) }),
            all: async () => ({ success: true, results: normalized.all(...ordered) }),
          };
        },
        run: async () => ({ success: true, results: [], meta: statement.run() }),
      };
    },
    async batch(statements: { all(): Promise<{ success: boolean; results: unknown[] }> }[]) {
      return Promise.all(statements.map((s) => s.all()));
    },
  };
  return { sql, env: { ANALYTICS_DB: db, ANALYTICS_KEY_HASH: hash } };
}
afterEach(() => vi.restoreAllMocks());
describe("anonymous usage timing", () => {
  it("counts idle time separately, pauses hidden idle tabs and includes background playback", () => {
    const s = new UsageSession("device", id, 0);
    s.state(0, "clips", false, false, true);
    expect(s.snapshot(120000)).toMatchObject({
      elapsedMs: 120000,
      visibleMs: 120000,
      activeMs: 60000,
      pages: { clips: 60000 },
    });
    s.state(120000, "sample", true, false, false);
    s.state(150000, "sample", true, true, false);
    s.state(160000, "sample", false, false, false);
    const value = s.snapshot(180000);
    expect(value).toMatchObject({
      activeMs: 100000,
      playMs: 40000,
      recordMs: 10000,
      visibleMs: 120000,
      pages: { clips: 60000, sample: 40000 },
    });
    expect(validateSnapshot(value)).toBe(true);
  });
  it("records only fixed control/action vocabulary and rotates expired visits", () => {
    const s = new UsageSession("studio", id, 0);
    s.count(10, "control:save:studio");
    s.count(20, "feature:project_save");
    s.count(30, "feature:my private song");
    s.count(40, "control:password:studio");
    const value = s.snapshot(50);
    expect(value.counters).toEqual({ "control:save:studio": 1, "feature:project_save": 1 });
    expect(s.snapshot(60).seq).toBe(value.seq + 1);
    expect(s.expired(30 * 60000 + 20)).toBe(true);
    expect(s.snapshot(25 * 3600000).elapsedMs).toBe(24 * 3600000);
  });
});
describe("hosted collector and owner report with real SQLite", () => {
  it("deduplicates snapshots and reordering, then reports time, features and buttons", async () => {
    const { sql, env } = database();
    try {
      expect((await collectUsage(request(snapshot()), env, now)).status).toBe(204);
      expect((await collectUsage(request(snapshot()), env, now + 1)).status).toBe(204);
      const later = snapshot();
      later.seq = 2;
      later.activeMs = 28000;
      later.counters["feature:sample_arm"] = 2;
      await collectUsage(request(later), env, now + 2);
      await collectUsage(request(snapshot()), env, now + 3);
      const response = await usageReport(
        new Request(`${origin}/xmpos/api/analytics/report?days=7`, {
          headers: { Authorization: `Bearer ${token}` },
        }),
        env,
        now + 3,
      );
      expect(response.status).toBe(200);
      const report = await response.json();
      expect(report.summary).toMatchObject({
        sessions: 1,
        active_ms: 28000,
        play_ms: 12000,
        record_ms: 3000,
      });
      expect(report.counters).toContainEqual({ name: "feature:sample_arm", count: 2, sessions: 1 });
      expect(report.counters).toContainEqual({ name: "control:rec:sample", count: 1, sessions: 1 });
      expect(JSON.stringify(report)).not.toContain(id);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(sql.prepare("SELECT COUNT(*) AS n FROM usage_sessions").get()?.n).toBe(1);
    } finally {
      sql.close();
    }
  });
  it("rejects personal fields, unknown keys, bad times, large streamed bodies and foreign origins", async () => {
    const { sql, env } = database();
    try {
      for (const value of [
        { ...snapshot(), song: "private" },
        { ...snapshot(), id: "visitor@example.com" },
        { ...snapshot(), activeMs: 40000 },
        { ...snapshot(), pages: { sample: 999999 } },
        { ...snapshot(), counters: { "feature:private name": 1 } },
      ])
        expect((await collectUsage(request(value), env, now)).status).toBe(400);
      expect(
        (
          await collectUsage(
            request(snapshot(), {
              headers: { Origin: "https://elsewhere.test", "Content-Type": "application/json" },
            }),
            env,
            now,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await collectUsage(
            request(snapshot(), { headers: { "Content-Type": "application/json" } }),
            env,
            now,
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await collectUsage(
            request(snapshot(), { headers: { Origin: origin, "Content-Type": "text/plain" } }),
            env,
            now,
          )
        ).status,
      ).toBe(415);
      expect((await collectUsage(request("x".repeat(70000)), env, now)).status).toBe(413);
      expect(sql.prepare("SELECT COUNT(*) AS n FROM usage_sessions").get()?.n).toBe(0);
    } finally {
      sql.close();
    }
  });
  it("requires the private key, enforces rate limits, and removes expired rows", async () => {
    const { sql, env } = database();
    try {
      expect(await authorized(new Request(origin), hash)).toBe(false);
      expect(
        await authorized(
          new Request(origin, { headers: { Authorization: `Bearer ${"R".repeat(43)}` } }),
          hash,
        ),
      ).toBe(false);
      expect(
        (await usageReport(new Request(`${origin}/xmpos/api/analytics/report`), env, now)).status,
      ).toBe(401);
      expect(
        (
          await collectUsage(
            request(snapshot()),
            { ...env, ANALYTICS_LIMIT: { limit: async () => ({ success: false }) } },
            now,
          )
        ).status,
      ).toBe(429);
      await collectUsage(request(snapshot()), env, now - 91 * 86400);
      const current = { ...snapshot(), id: "65b8d728-2513-4417-8e1b-3cf782a21f2d" };
      await collectUsage(request(current), env, now);
      await pruneUsage(env, now);
      expect(sql.prepare("SELECT session_id FROM usage_sessions").all()).toEqual([
        { session_id: current.id },
      ]);
      const response = await worker.fetch(new Request(`${origin}/xmpos/api/analytics/report`), {
        ...env,
        ASSETS: {
          fetch: () => {
            throw Error("Must not serve assets");
          },
        },
      });
      expect(response.status).toBe(401);
    } finally {
      sql.close();
    }
  });
});
it("exposes only fixed native action counters, not action arguments, for the browser adapter", async () => {
  const header = readFileSync("native/include/xmp/live_ui.hpp", "utf8");
  const kinds = /struct Action \{\s*enum Kind[^{]*\{([\s\S]*?)\} kind = stop;/.exec(header)?.[1];
  expect(
    kinds
      ?.replace(/\/\/[^\n]*/g, "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  ).toEqual(USAGE_ACTIONS);
  const { instance } = await WebAssembly.instantiate(decodeBase64(DEVICE_UI_WASM_BASE64), {
    xmp: { read_file: () => 0 },
    wasi_snapshot_preview1: { clock_time_get: () => 0 },
  });
  const d = instance.exports as unknown as {
    memory: WebAssembly.Memory;
    _initialize(): void;
    initialize(n: number): number;
    usage_count(): number;
    usage_counts(): number;
    button(code: number, down: number): void;
  };
  d._initialize();
  expect(d.initialize(0)).toBe(1);
  expect(d.usage_count()).toBe(USAGE_ACTIONS.length);
  d.button(0x51, 1);
  d.button(0x51, 0);
  const counts = new Uint32Array(d.memory.buffer, d.usage_counts(), d.usage_count());
  expect(counts[USAGE_ACTIONS.indexOf("panic")]).toBe(1);
});
