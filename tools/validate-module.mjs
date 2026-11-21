import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const server = await createServer({ server: { middlewareMode: true }, appType: "custom" });
try {
  const { ModuleManifest, CommunityManifest, negotiateModule } = await server.ssrLoadModule(
    fileURLToPath(new URL("../packages/sdk/src/index.ts", import.meta.url)),
  );
  const input = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const manifest =
    input.apiVersion === 2
      ? negotiateModule(CommunityManifest.parse(input)).manifest
      : ModuleManifest.parse(input);
  console.log(
    `${manifest.id} v${manifest.version}: valid API v${manifest.apiVersion}; no device permissions`,
  );
} finally {
  await server.close();
}
