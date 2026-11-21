// The existing homepage has its own Worker. Only the XMP subpath is served here.
import mediaSizes from "./media-sizes.json" with { type: "json" };

// Error reports from the web client (apps/studio/src/error-log.ts), written to
// Workers Logs. Same-origin POSTs only, bounded, stored nowhere else. The client
// sends error messages, contexts and short stacks; no project or audio data.
const reportLimit = 64 * 1024; // 20 entries at their longest fit
const field = (value, max) => (typeof value === "string" ? value.slice(0, max) : undefined);

// The assets binding can return the complete media file for a Range request.
// Browsers need a 206 response to seek before the whole lesson is buffered.
export async function mediaRange(request, asset) {
  const path = new URL(request.url).pathname;
  if (
    request.method !== "GET" ||
    asset.status !== 200 ||
    !/^\/xmpos\/manual-media\/.*\.(mp4|webm|wav)$/.test(path) ||
    (asset.headers.get("Content-Encoding") ?? "identity") !== "identity"
  )
    return asset;
  // ASSETS omits Content-Length, even on HEAD. Packaging records exact sizes.
  const size = Number(asset.headers.get("Content-Length") ?? mediaSizes[path]);
  if (!Number.isSafeInteger(size) || size <= 0 || !asset.body) return asset;
  const headers = new Headers(asset.headers);
  headers.set("Accept-Ranges", "bytes");
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("Range") ?? "");
  const ifRange = request.headers.get("If-Range");
  if (
    !range ||
    (!range[1] && !range[2]) ||
    (ifRange &&
      ifRange !== asset.headers.get("ETag") &&
      ifRange !== asset.headers.get("Last-Modified"))
  )
    return new Response(asset.body, { status: 200, headers });
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
    await asset.body.cancel();
    headers.set("Content-Range", `bytes */${size}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  const reader = asset.body.getReader();
  let offset = 0;
  const body = new ReadableStream({
    async pull(controller) {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        const from = Math.max(0, start - offset);
        const to = Math.min(value.byteLength, end + 1 - offset);
        offset += value.byteLength;
        if (to > from) controller.enqueue(value.subarray(from, to));
        if (offset > end) {
          controller.close();
          await reader.cancel();
          return;
        }
        if (to > from) return;
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
  headers.set("Content-Length", String(end - start + 1));
  return new Response(body, { status: 206, headers });
}

export async function clientErrors(request) {
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405, headers: { Allow: "POST" } });
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return new Response("Forbidden", { status: 403 });
  if (Number(request.headers.get("Content-Length") ?? 0) > reportLimit)
    return new Response("Report too large", { status: 413 });
  const text = await request.text();
  if (text.length > reportLimit) return new Response("Report too large", { status: 413 });
  let report;
  try {
    report = JSON.parse(text);
  } catch {
    return new Response("Invalid report", { status: 400 });
  }
  const entries = Array.isArray(report?.entries) ? report.entries.slice(0, 20) : [];
  if (!entries.length) return new Response("Invalid report", { status: 400 });
  for (const entry of entries)
    console.error(
      JSON.stringify({
        type: "xmp-client-error",
        page: field(report.page, 200),
        build: field(report.build, 80),
        userAgent: field(request.headers.get("User-Agent"), 300),
        time: field(entry?.time, 40),
        context: field(entry?.context, 80),
        message: field(entry?.message, 400),
        detail: field(entry?.detail, 1200),
      }),
    );
  return new Response(null, { status: 204 });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/xmpos" && !url.pathname.startsWith("/xmpos/"))
      return new Response("Not found", { status: 404 });
    if (url.pathname === "/xmpos/api/client-errors") return clientErrors(request);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    if (url.pathname === "/xmpos") {
      url.pathname = "/xmpos/";
      return Response.redirect(url.href, 308);
    }
    if (url.pathname.startsWith("/xmpos/api/"))
      return Response.json(
        { error: "Native Mac recording is available only on the local development server" },
        { status: 404 },
      );
    const asset = await mediaRange(request, await env.ASSETS.fetch(request));
    const response = new Response(asset.body, asset);
    response.headers.set("X-Content-Type-Options", "nosniff");
    response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    response.headers.set(
      "Permissions-Policy",
      "midi=(), usb=(), hid=(), serial=(), microphone=(self), camera=()",
    );
    response.headers.set(
      "Cache-Control",
      response.ok && url.pathname.startsWith("/xmpos/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    );
    return response;
  },
};
