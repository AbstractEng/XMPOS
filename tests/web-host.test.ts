import { describe, expect, it } from "vitest";
import worker from "../tools/web-host/worker.mjs";

function assets(body = "preview", type = "text/html") {
  const requests: string[] = [];
  return {
    requests,
    env: {
      ASSETS: {
        fetch: async (r: Request) => {
          requests.push(r.url);
          return new Response(body, { headers: { "Content-Type": type } });
        },
      },
    },
  };
}
describe.each(["https://abstracteng.com", "https://irregularsizes.com"])(
  "hosted Studio subpath at %s",
  (origin) => {
    it("keeps the homepage and similarly named paths outside the XMP worker", async () => {
      const a = assets();
      for (const path of ["/", "/xmpos-other", "/projects"])
        expect((await worker.fetch(new Request(`${origin}${path}`), a.env)).status).toBe(404);
      expect(a.requests).toHaveLength(0);
    });
    it("canonicalizes only the exact application root and preserves its query", async () => {
      const a = assets();
      const response = await worker.fetch(new Request(`${origin}/xmpos?from=phone`), a.env);
      expect(response.status).toBe(308);
      expect(response.headers.get("Location")).toBe(`${origin}/xmpos/?from=phone`);
      expect(a.requests).toHaveLength(0);
    });
    it("does not accept project uploads or expose the local Mac recorder", async () => {
      const a = assets();
      const write = await worker.fetch(
        new Request(`${origin}/xmpos/`, { method: "POST", body: "private project" }),
        a.env,
      );
      expect(write.status).toBe(405);
      expect(write.headers.get("Allow")).toBe("GET, HEAD");
      const recording = await worker.fetch(
        new Request(`${origin}/xmpos/api/recording/status`),
        a.env,
      );
      expect(recording.status).toBe(404);
      expect(await recording.json()).toHaveProperty("error");
      expect(a.requests).toHaveLength(0);
    });
    it("serves subpath assets with browser hardware restrictions and versioned cache policy", async () => {
      const a = assets();
      const html = await worker.fetch(new Request(`${origin}/xmpos/manual/`), a.env);
      expect(await html.text()).toBe("preview");
      expect(html.headers.get("Cache-Control")).toBe("no-cache");
      expect(html.headers.get("Permissions-Policy")).toContain("usb=()");
      expect(html.headers.get("X-Content-Type-Options")).toBe("nosniff");
      const js = await worker.fetch(
        new Request(`${origin}/xmpos/assets/instrument-worklet-original.js`),
        a.env,
      );
      expect(js.headers.get("Cache-Control")).toContain("immutable");
      expect(a.requests).toEqual([
        `${origin}/xmpos/manual/`,
        `${origin}/xmpos/assets/instrument-worklet-original.js`,
      ]);
    });
  },
);
