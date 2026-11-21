import { defineConfig } from "vite";
import { buildIdentity } from "../../acceptance/lib/workspace.mjs";
export default defineConfig({
  define: { __XMP_BUNDLED__: "true", __XMP_SDK_SOURCE_HASH__: JSON.stringify(buildIdentity()) },
  build: {
    outDir: "build/sdk-bundle",
    emptyOutDir: true,
    target: "node24",
    ssr: true,
    minify: false,
    rollupOptions: {
      input: { cli: "tools/sdk/supported-cli.mjs", index: "packages/sdk/src/index.ts" },
      external: (id) => id.startsWith("node:"),
      output: {
        format: "es",
        entryFileNames: "[name].mjs",
        chunkFileNames: "chunks/[name]-[hash].mjs",
      },
    },
  },
  ssr: { noExternal: true },
});
