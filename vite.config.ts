import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
// @ts-expect-error The factory catalog builder is also used by the Live image builder.
import { factoryKitsPlugin } from "./tools/factory-kits.mjs";
// @ts-expect-error Local development server plugin is executable ESM.
import { recordingPlugin } from "./tools/lib/recording-service.mjs";

export default defineConfig(({ mode }) => ({
  base: mode === "hosted" ? "/xmpos/" : "/",
  root: "apps/studio",
  plugins: [recordingPlugin(), factoryKitsPlugin()],
  server: {
    headers: {
      "Permissions-Policy": "midi=(), usb=(), hid=(), serial=(), microphone=(self), camera=()",
    },
  },
  preview: {
    headers: {
      "Permissions-Policy": "midi=(), usb=(), hid=(), serial=(), microphone=(self), camera=()",
    },
  },
  resolve: {
    alias: {
      "@xmp/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@xmp/sdk": fileURLToPath(new URL("./packages/sdk/src/index.ts", import.meta.url)),
    },
  },
  build: {
    // The hosted /xmpos/ build gets its own folder so local builds and checks
    // (which rebuild dist/ for "/") can never break the hosted preview or deploy.
    outDir: mode === "hosted" ? "../../dist-hosted" : "../../dist",
    emptyOutDir: true,
    rolldownOptions: {
      input: {
        studio: fileURLToPath(new URL("./apps/studio/index.html", import.meta.url)),
        manual: fileURLToPath(new URL("./apps/studio/manual/index.html", import.meta.url)),
        analytics: fileURLToPath(new URL("./apps/studio/analytics/index.html", import.meta.url)),
      },
    },
  },
  // DSP and CLI render contracts share CPU; bound concurrency on Mac and CI.
  // tests/parity compiles the C++ core natively and compares it with the
  // TypeScript at length: its own gate, `npm run parity` (XMP_PARITY=1).
  test: {
    root: ".",
    include: process.env.XMP_PARITY ? ["tests/parity/**/*.test.ts"] : ["tests/**/*.test.ts"],
    exclude: process.env.XMP_PARITY ? [] : ["tests/parity/**", "**/node_modules/**"],
    maxWorkers: 2,
    // Native compiles, large sample libraries and DSP renders can exceed the
    // default five seconds on a busy host. Keep their assertions and a bound.
    testTimeout: 30000,
    // The C++ project core (WebAssembly) does the browser's edits; it loads
    // before any test, as the apps load it before their first edit.
    setupFiles: ["tests/setup-core.ts"],
  },
}));
