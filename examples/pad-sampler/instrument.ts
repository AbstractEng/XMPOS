import { defineInstrument, ModuleManifest } from "../../packages/sdk/src/index.ts";
import manifest from "./module.json";
export default defineInstrument({
  manifest: ModuleManifest.parse(manifest),
  onControl(event, host) {
    if (event.type === "pad") host.triggerPad(event.pad, event.velocity);
  },
});
