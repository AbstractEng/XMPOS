import { readFileSync } from "node:fs";

// This is an XMP OS installation baseline, not a restriction on stock recovery
// or the separately authorized MPC plugin development wrapper.
export const MPC_RUNTIME = Object.freeze(
  JSON.parse(
    readFileSync(new URL("../../os/live-mk1/mpc-runtime.lock.json", import.meta.url), "utf8"),
  ),
);
export const COMPATIBILITY = Object.freeze(
  JSON.parse(readFileSync(new URL("../../os/compatibility.json", import.meta.url), "utf8")),
);
if (
  COMPATIBILITY.format !== "xmp-hardware-compatibility" ||
  COMPATIBILITY.version !== 1 ||
  COMPATIBILITY.publicInstallationCleared !== false ||
  Object.entries(COMPATIBILITY.baseline).some(
    ([key, value]) => key !== "updaterFamily" && MPC_RUNTIME[key] !== value,
  )
)
  throw new Error("Compatibility record differs from the reviewed runtime lock or release state");
export function requireSupportedUpdater(imageSha256) {
  if (imageSha256 !== COMPATIBILITY.baseline.updaterImageSha256)
    throw new Error(
      "XMP OS requires the pinned MPC Gen 1 3.10.1 updater; other versions are unsupported",
    );
}
