import { relative, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { build, preview } from "vite";
import { buildIdentity, root, sha256, writeJson } from "./workspace.mjs";

const width = 1280;
const height = 800;
const navigation =
  "#play, #stop, #enable, #view-nav [data-view]:not([data-view=all]), .tracks [data-track]";
const workspaceTargets = {
  play: "#kit-picker summary, #pads button",
  sounds: "#machine-type, #sample-browser",
  pattern: "#import, #length, #clear, #steps button",
  perform: "#perf-actions [data-primary]",
  mix: "#mute, #master, #track-gain",
};

export async function auditStudioLayout(directory) {
  const outDir = resolve(directory, "studio-layout-build");
  const sourceHash = buildIdentity();
  await build({ build: { outDir } });
  const server = await preview({ build: { outDir }, preview: { host: "127.0.0.1", port: 0 } });
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ args: ["--disable-audio-output", "--mute-audio"] });
    const page = await browser.newPage({ viewport: { width, height }, permissions: [] });
    await page.route("**/*", (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
    );
    await page.goto(`${origin}/?view=studio`);
    const views = [];
    for (const [name, selectors] of Object.entries(workspaceTargets)) {
      await page.locator(`#view-nav [data-view="${name}"]`).click();
      await page.evaluate(() => scrollTo(0, 0));
      const controls = await page.locator(`${navigation}, ${selectors}`).evaluateAll((elements) =>
        elements.map((el) => {
          const { left, top, right, bottom, width, height } = el.getBoundingClientRect();
          return {
            id: el.id || el.getAttribute("aria-label") || el.textContent.trim(),
            visible: width > 0 && height > 0 && getComputedStyle(el).visibility === "visible",
            focusable: el.tabIndex >= 0 && !el.disabled,
            width,
            height,
            left,
            top,
            right,
            bottom,
          };
        }),
      );
      const path = resolve(directory, `studio-${name}.png`);
      const bytes = await page.screenshot({ path, animations: "disabled" });
      views.push({
        name,
        controls,
        screenshot: relative(root, path),
        screenshotHash: sha256(bytes),
      });
    }
    const result = {
      width,
      height,
      sourceHash,
      views,
      physicalDisplayQualified: false,
      hardwareControlsQualified: false,
    };
    writeJson(resolve(directory, "layout.json"), result);
    return result;
  } finally {
    await browser?.close();
    await server.close();
  }
}
