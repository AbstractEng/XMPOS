import { bindings, defineConfig, triggers } from "cf/config";
import * as entrypoint from "./worker.mjs" with { type: "cf-worker" };

export default defineConfig({
  accountId: "33783d5d3a3b8ffb3a59e099d3c332fa",
  worker: {
    name: "xmp-studio-web",
    compatibilityDate: "2026-11-09",
    entrypoint,
    workersDev: false,
    previewUrls: false,
    assets: {
      runWorkerFirst: true,
      htmlHandling: "force-trailing-slash",
      notFoundHandling: "none",
    },
    env: {
      ASSETS: bindings.assets(),
      ANALYTICS_DB: bindings.d1({ name: "xmp-web-analytics" }),
      ANALYTICS_KEY_HASH: bindings.secret(),
      ANALYTICS_LIMIT: bindings.rateLimit({
        namespace: "1001731",
        simple: { limit: 120, period: 60 },
      }),
    },
    triggers: [
      triggers.scheduled({ schedule: "23 5 * * *" }),
      triggers.fetch({
        pattern: "abstracteng.com/xmpos",
        zone: "3188b3de92c182ddf24b840b85bce0e5",
      }),
      triggers.fetch({
        pattern: "abstracteng.com/xmpos/*",
        zone: "3188b3de92c182ddf24b840b85bce0e5",
      }),
      triggers.fetch({
        pattern: "irregularsizes.com/xmpos",
        zone: "4ae9d57bfe30dbac7b290abd02208cfc",
      }),
      triggers.fetch({
        pattern: "irregularsizes.com/xmpos/*",
        zone: "4ae9d57bfe30dbac7b290abd02208cfc",
      }),
    ],
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
