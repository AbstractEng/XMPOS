// Render the guide's conceptual diagram from editable Mermaid source.
// All rendering is local. This authoring dependency is cached outside source control.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { fontCSS } from "./identity.mjs";

const root = resolve(import.meta.dirname, "../..");
const work = resolve(root, "artifacts/tutorials/diagram");
const output = resolve(root, "apps/studio/public/manual-media");
await mkdir(work, { recursive: true });
const library = `${work}/mermaid-10.9.3.min.js`;
let code;
try {
  code = await readFile(library);
} catch {
  const response = await fetch("https://cdn.jsdelivr.net/npm/mermaid@10.9.3/dist/mermaid.min.js", {
    signal: AbortSignal.timeout(30000),
  });
  assert.ok(response.ok);
  code = Buffer.from(await response.arrayBuffer());
  assert.ok(code.length < 6000000);
  await writeFile(library, code);
}
assert.equal(
  createHash("sha256").update(code).digest("hex"),
  "5a8ec91820bd55afef049068489369910e5d6ce70c8103952f27e29d3e76e8bc",
);
const source = await readFile(resolve(root, "docs/tutorials/project-relationships.mmd"), "utf8");
const browser = await chromium.launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1200 },
    deviceScaleFactor: 1.5,
  });
  await page.setContent(
    `<style>${fontCSS}</style><main id="diagram" style="display:inline-block;padding:24px;background:#F2EFE9"></main>`,
  );
  await page.evaluate(() => document.fonts.load("20px Manrope"));
  await page.addScriptTag({ path: library });
  const svg = await page.evaluate(
    async ({ source, fontCSS }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "base",
        themeVariables: {
          fontFamily: "Manrope, sans-serif",
          fontSize: "20px",
          titleColor: "#35473E",
          clusterTextColor: "#35473E",
          primaryColor: "#F2EFE9",
          primaryTextColor: "#35473E",
          primaryBorderColor: "#35473E",
          lineColor: "#35473E",
          edgeLabelBackground: "#F2EFE9",
          clusterBkg: "#F2EFE9",
          clusterBorder: "#35473E",
        },
        flowchart: {
          htmlLabels: false,
          curve: "basis",
          nodeSpacing: 30,
          rankSpacing: 48,
          padding: 18,
        },
      });
      const result = await mermaid.render("xmpRelationships", source);
      const target = document.getElementById("diagram");
      target.innerHTML = result.svg;
      const element = target.querySelector("svg");
      element.setAttribute(
        "aria-label",
        "Everything lives inside a project. Tracks own clips and use instruments. Scenes select clips across tracks. A song chain orders scenes. Sampler and kit pads reference the project sample pool.",
      );
      element.setAttribute("role", "img");
      const size = element.viewBox.baseVal;
      element.style.width = `${size.width}px`;
      element.style.maxWidth = "none";
      const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
      style.textContent = fontCSS;
      element.prepend(style);
      return element.outerHTML;
    },
    { source, fontCSS },
  );
  await mkdir(output, { recursive: true });
  await writeFile(`${output}/project-relationships.svg`, svg);
  await page.locator("#diagram").screenshot({ path: `${output}/project-relationships.png` });
  console.log(await page.locator("#diagram svg").boundingBox());
} finally {
  await browser.close();
}
