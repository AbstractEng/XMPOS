import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { verifyArchive } from "../../acceptance/lib/provenance.mjs";
import { root, sha256 } from "../../acceptance/lib/workspace.mjs";

export async function auditResearch() {
  const catalog = JSON.parse(readFileSync(resolve(root, "hardware/reference-catalog.json")));
  const repositories = JSON.parse(readFileSync(resolve(root, "references/lock.json"))).repositories;
  const official = JSON.parse(readFileSync(resolve(root, "references/official-g1-sources.json")));
  const sources = [];
  for (const source of catalog.sources) {
    const repo = repositories.find(
      (r) => r.url === source.repository && r.commit === source.commit,
    );
    if (
      !repo ||
      !/^[a-f0-9]{40}$/.test(source.commit) ||
      !/^[a-f0-9]{64}$/.test(source.sha256) ||
      source.path.includes("..") ||
      source.hardwareQualified !== false
    )
      throw new Error("Unpinned research evidence");
    if (source.id === "official-g1") {
      const item = official.catalog.find(
        (c) => c.path === source.path && c.sha256 === source.sha256 && c.size === source.bytes,
      );
      if (!item) throw new Error("Official archive catalog mismatch");
      const checked = await verifyArchive(
        resolve(root, "references/archives/akai-mpc-g1-3.10", basename(source.path)),
        { sha256: source.sha256, size: source.bytes },
      );
      sources.push({ id: source.id, content: checked.status, hardwareQualified: false });
    } else {
      const path = resolve(root, "references/repos", repo.name, source.path);
      const content = !existsSync(path)
        ? "unavailable"
        : sha256(readFileSync(path)) === source.sha256
          ? "verified"
          : "unverified";
      sources.push({ id: source.id, content, hardwareQualified: false });
    }
  }
  return {
    format: "xmp-research-audit",
    sources,
    exactUnitEvidence: false,
    recoveryVerified: false,
    usbTopologyVerified: false,
    payloadsBundled: false,
    metadataPinned: true,
  };
}
if (process.argv[1] === import.meta.filename) {
  if (process.argv.length > 2)
    throw new Error("Audits pinned local research only; no device arguments");
  console.log(JSON.stringify(await auditResearch(), null, 2));
}
