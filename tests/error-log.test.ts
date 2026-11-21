// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cc0Kits, loadBundledDrumKit } from "../apps/studio/src/bundled-drum-kits.ts";
import {
  clearErrorLog,
  errorLog,
  errorReport,
  installErrorLogging,
  logError,
  reportErrorsTo,
} from "../apps/studio/src/error-log.ts";

afterEach(() => {
  clearErrorLog();
  vi.restoreAllMocks();
});

it("records failures with their context, keeps them on this browser and reports them", () => {
  // Handled failures are warnings; uncaught ones are errors (next test).
  const console = vi.spyOn(globalThis.console, "warn").mockImplementation(() => {});
  expect(logError("Kit load failed", new Error("Kit file missing"))).toBe("Kit file missing");
  expect(logError("Preview failed", { odd: true })).toBe("Preview failed");
  expect(errorLog().map((e) => [e.context, e.message])).toEqual([
    ["Kit load failed", "Kit file missing"],
    ["Preview failed", "Unknown error"],
  ]);
  expect(JSON.parse(localStorage.getItem("xmp-error-log") ?? "[]")).toHaveLength(2);
  expect(errorReport()).toContain("Kit load failed · Kit file missing");
  expect(console).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 60; i++) logError("Repeated", new Error(String(i)));
  expect(errorLog()).toHaveLength(50);
  clearErrorLog();
  expect(errorLog()).toHaveLength(0);
  expect(localStorage.getItem("xmp-error-log")).toBeNull();
});

it("logs uncaught errors and rejected promises", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  installErrorLogging();
  window.dispatchEvent(new ErrorEvent("error", { error: new Error("boom"), message: "boom" }));
  const rejected = new Event("unhandledrejection") as Event & { reason: unknown };
  rejected.reason = new Error("lost promise");
  window.dispatchEvent(rejected);
  expect(errorLog().map((e) => e.message)).toEqual(["boom", "lost promise"]);
});

it("names a kit file missing from the server instead of blaming the connection", async () => {
  const entry = cc0Kits[0];
  if (!entry) throw new Error("No kit");
  const missing = async () => {
    const response = new Response("Not found", { status: 404 });
    Object.defineProperty(response, "url", { value: "https://example.test/xmpos/kits/a.wav" });
    return response;
  };
  await expect(loadBundledDrumKit(entry.id, "/xmpos/", missing)).rejects.toThrow(
    "Kit file missing on the server (HTTP 404): /xmpos/kits/a.wav",
  );
  await expect(
    loadBundledDrumKit(entry.id, "/xmpos/", async () => new Response("", { status: 503 })),
  ).rejects.toThrow("Kit sound unavailable (HTTP 503); retry when online");
});

it("sends logged errors to the report endpoint in bounded batches", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const fetch = vi.fn(
    async (_url: string, _init?: RequestInit) => new Response(null, { status: 204 }),
  );
  vi.stubGlobal("fetch", fetch);
  reportErrorsTo("/xmpos/api/client-errors");
  for (let i = 0; i < 70; i++) logError("Kit load failed", new Error(`missing ${i}`));
  await vi.advanceTimersByTimeAsync(10000);
  const batches = fetch.mock.calls.map(
    (call) => JSON.parse(String(call[1]?.body)).entries as { context: string; message: string }[],
  );
  expect(batches.map((b) => b.length)).toEqual([20, 20, 20]); // 60 a page load at most
  expect(batches[0]?.[0]).toMatchObject({ context: "Kit load failed", message: "missing 0" });
  expect(fetch.mock.calls[0]?.[0]).toBe("/xmpos/api/client-errors");
  reportErrorsTo(undefined);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
