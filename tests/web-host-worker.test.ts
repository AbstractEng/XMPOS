import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import mediaSizes from "../tools/web-host/media-sizes.json";
import worker, { mediaRange } from "../tools/web-host/worker.mjs";

const env = { ASSETS: { fetch: vi.fn(async () => new Response("asset")) } };
const post = (body: string, headers: Record<string, string> = {}) =>
  worker.fetch(
    new Request("https://abstracteng.com/xmpos/api/client-errors", {
      method: "POST",
      body,
      headers: { Origin: "https://abstracteng.com", "User-Agent": "test", ...headers },
    }),
    env,
  );
afterEach(() => vi.restoreAllMocks());

it("writes each client error to the Worker log, bounded, and keeps nothing else", async () => {
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const entries = Array.from({ length: 25 }, (_, i) => ({
    time: "2026-11-18T00:00:00Z",
    context: "Kit load failed",
    message: `x${i}`.padEnd(900, "!"),
    detail: "at loadKit",
  }));
  const response = await post(JSON.stringify({ page: "/xmpos/", build: "hosted", entries }));
  expect(response.status).toBe(204);
  expect(log).toHaveBeenCalledTimes(20);
  const first = JSON.parse(String(log.mock.calls[0]?.[0]));
  expect(first).toMatchObject({
    type: "xmp-client-error",
    page: "/xmpos/",
    context: "Kit load failed",
    userAgent: "test",
  });
  expect(first.message).toHaveLength(400);
  expect(env.ASSETS.fetch).not.toHaveBeenCalled();
});

it("refuses other origins, other methods, oversized and malformed reports", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const ok = JSON.stringify({ entries: [{ message: "m" }] });
  expect((await post(ok, { Origin: "https://example.com" })).status).toBe(403);
  expect((await post("x".repeat(70000))).status).toBe(413);
  expect((await post("{not json")).status).toBe(400);
  expect((await post(JSON.stringify({ entries: [] }))).status).toBe(400);
  const get = await worker.fetch(
    new Request("https://abstracteng.com/xmpos/api/client-errors"),
    env,
  );
  expect(get.status).toBe(405);
  expect(console.error).not.toHaveBeenCalled();
});

const mediaRequest = (range?: string, extra: Record<string, string> = {}) =>
  new Request("https://abstracteng.com/xmpos/manual-media/01-navigation.webm", {
    headers: { ...(range ? { Range: range } : {}), ...extra },
  });
const mediaAsset = () =>
  new Response("0123456789", {
    headers: { "Content-Length": "10", "Content-Type": "video/webm", ETag: '"lesson"' },
  });

it("serves seek ranges when the asset binding ignores Range, preserving response policies", async () => {
  const assets = { ASSETS: { fetch: vi.fn(async () => mediaAsset()) } };
  for (const [range, body, contentRange] of [
    ["bytes=3-6", "3456", "bytes 3-6/10"],
    ["bytes=7-", "789", "bytes 7-9/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-99", "89", "bytes 8-9/10"],
  ] as const) {
    const response = await worker.fetch(mediaRequest(range), assets);
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(contentRange);
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    expect(response.headers.get("Content-Length")).toBe(String(body.length));
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Permissions-Policy")).toContain("usb=()");
    expect(await response.text()).toBe(body);
  }
});

it("streams a range across chunks and cancels the remainder", async () => {
  const cancel = vi.fn();
  let next = 0;
  const source = new ReadableStream({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(["012", "345", "678", "9"][next++]));
    },
    cancel,
  });
  const response = await mediaRange(
    mediaRequest("bytes=2-6"),
    new Response(source, { headers: { "Content-Length": "10" } }),
  );
  expect(await response.text()).toBe("23456");
  expect(cancel).toHaveBeenCalledOnce();
});

it("seeks packaged original audio when ASSETS omits Content-Length", async () => {
  const file = readFileSync("apps/studio/public/manual-media/first-groove.wav");
  const response = await mediaRange(
    new Request("https://abstracteng.com/xmpos/manual-media/first-groove.wav", {
      headers: { Range: "bytes=-1024" },
    }),
    new Response(file, { headers: { "Content-Type": "audio/wav" } }),
  );
  expect(response.status).toBe(206);
  expect(response.headers.get("Content-Range")).toBe(
    `bytes ${file.length - 1024}-${file.length - 1}/${file.length}`,
  );
  expect(Buffer.from(await response.arrayBuffer())).toEqual(file.subarray(-1024));
});

it("keeps packaged range metadata exact and complete for every published media file", () => {
  const root = resolve("apps/studio/public/manual-media");
  const actual = Object.fromEntries(
    readdirSync(root, { recursive: true, encoding: "utf8" })
      .filter((name) => /\.(mp4|webm|wav)$/.test(name))
      .map((name) => [`/xmpos/manual-media/${name}`, statSync(resolve(root, name)).size]),
  );
  expect(mediaSizes).toEqual(actual);
});

it("handles unsatisfiable, malformed and conditional ranges without corrupting the asset", async () => {
  for (const range of ["bytes=10-", "bytes=-0", "bytes=8-3"]) {
    const response = await mediaRange(mediaRequest(range), mediaAsset());
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe("bytes */10");
    expect(await response.text()).toBe("");
  }
  for (const range of ["bytes=1-2,4-5", "nonsense"]) {
    const response = await mediaRange(mediaRequest(range), mediaAsset());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
  }
  const stale = await mediaRange(mediaRequest("bytes=1-2", { "If-Range": '"old"' }), mediaAsset());
  expect(stale.status).toBe(200);
  expect(await stale.text()).toBe("0123456789");
  const matching = await mediaRange(
    mediaRequest("bytes=1-2", { "If-Range": '"lesson"' }),
    mediaAsset(),
  );
  expect(matching.status).toBe(206);
  expect(await matching.text()).toBe("12");
  const alreadyPartial = new Response("12", { status: 206 });
  expect(await mediaRange(mediaRequest("bytes=1-2"), alreadyPartial)).toBe(alreadyPartial);
  const html = new Response("page");
  expect(await mediaRange(new Request("https://abstracteng.com/xmpos/manual/"), html)).toBe(html);
});
