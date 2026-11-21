// Optional hosting example. Set your own account and routes before deploying.
import { bindings, defineConfig } from "cf/config";
import * as entrypoint from "./worker.mjs" with { type: "cf-worker" };

export default defineConfig({
  worker: {
    name: "xmp-community-example",
    compatibilityDate: "2026-11-09",
    entrypoint,
    workersDev: false,
    previewUrls: false,
    assets: {
      runWorkerFirst: true,
      htmlHandling: "force-trailing-slash",
      notFoundHandling: "none",
    },
    env: { ASSETS: bindings.assets() },
    observability: {
      enabled: true,
      redactQueryString: true,
      headSamplingRate: 0.1,
      // Every client error report is kept; requests aren't logged one by one.
      logs: { enabled: true, headSamplingRate: 1, invocationLogs: false },
      traces: { enabled: true, headSamplingRate: 0.1 },
    },
  },
});
