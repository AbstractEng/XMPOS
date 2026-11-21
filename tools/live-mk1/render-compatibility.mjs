import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COMPATIBILITY as record } from "./compatibility.mjs";

const escapeHtml = (text) =>
  String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
export function compatibilityMarkdown() {
  const rows = [
    ["Model", "Board", "Status", "Starting firmware"],
    ...record.models.map((model) => [
      model.name,
      model.board ?? "Unverified",
      model.status,
      model.firmware,
    ]),
  ];
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  const line = (row) => `| ${row.map((cell, column) => cell.padEnd(widths[column])).join(" | ")} |`;
  return [
    "Public hardware installation is not yet cleared. Live Mk1 is the tested candidate; One models are planned ports.",
    "",
    line(rows[0]),
    line(widths.map((width) => "-".repeat(width))),
    ...rows.slice(1).map(line),
    "",
    record.stopInstruction,
  ].join("\n");
}
export function compatibilityHtml() {
  return `<p>Public hardware installation is not yet cleared. Live Mk1 is the tested candidate; One models are planned ports.</p>
<div class="table-scroll"><table><caption>XMP OS hardware compatibility</caption><thead><tr><th scope="col">Model</th><th scope="col">Board</th><th scope="col">Status</th><th scope="col">Starting firmware</th></tr></thead><tbody>
${record.models.map((model) => `<tr><th scope="row">${escapeHtml(model.name)}</th><td>${escapeHtml(model.board ?? "Unverified")}</td><td>${escapeHtml(model.status)}</td><td>${escapeHtml(model.firmware)}</td></tr>`).join("\n")}
</tbody></table></div>
<p>${escapeHtml(record.stopInstruction)}</p>`;
}
export const generatedTargets = [
  ["README.md", "markdown"],
  ["docs/compatibility.md", "markdown"],
  ["docs/launch/release-notes-draft.md", "markdown"],
  ["docs/launch/product-compatibility.html", "html"],
  ["apps/studio/manual/index.html", "html"],
];
export function renderCompatibility(check = false) {
  for (const [path, kind] of generatedTargets) {
    const url = new URL(`../../${path}`, import.meta.url);
    const source = readFileSync(url, "utf8");
    const begin = "<!-- BEGIN GENERATED COMPATIBILITY -->",
      end = "<!-- END GENERATED COMPATIBILITY -->";
    if (source.split(begin).length !== 2 || source.split(end).length !== 2)
      throw new Error(`Missing/duplicate compatibility markers: ${path}`);
    const content = kind === "html" ? compatibilityHtml() : compatibilityMarkdown();
    const generated = `${source.slice(0, source.indexOf(begin) + begin.length)}\n${content}\n${source.slice(source.indexOf(end))}`;
    if (source !== generated) {
      if (check)
        throw new Error(`Stale compatibility copy: ${path}; run npm run compatibility:docs`);
      writeFileSync(url, generated);
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).some((arg) => arg !== "--check"))
    throw new Error("Only --check is accepted");
  renderCompatibility(process.argv.includes("--check"));
}
