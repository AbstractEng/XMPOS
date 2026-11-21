import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
export default defineConfig({
  root: fileURLToPath(new URL("../", import.meta.url)),
  build: {
    outDir:
      process.env.XMP_LIVE_BUILD === "1"
        ? "build/live-app"
        : process.env.XMP_DEVICE_BUILD === "1"
          ? "build/device-app"
          : "build/os-app",
    emptyOutDir: true,
    target: "node24",
    ssr: true,
    minify: false,
    rollupOptions: {
      // XMP_LIVE_BUILD: the app service for the owner's MPC Live (phase 3).
      input:
        process.env.XMP_LIVE_BUILD === "1"
          ? "os/guest/live.ts"
          : process.env.XMP_DEVICE_BUILD === "1"
            ? "os/guest/device.ts"
            : "os/guest/main.ts",
      external: (id) => id.startsWith("node:"),
      output: {
        format: "es",
        entryFileNames: process.env.XMP_LIVE_BUILD === "1" ? "live.mjs" : "guest.mjs",
      },
    },
  },
  ssr: { noExternal: true },
});
