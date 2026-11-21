import { preflightTarget } from "../acceptance/target-policy.mjs";

// Intentionally not a device runner. It never enumerates devices or opens a link.
try {
  preflightTarget({ profile: "usb-lab" });
} catch (error) {
  console.error(error.message);
  console.error(
    "See docs/usb-testing.md for the planned authenticated hardware qualification flow.",
  );
  process.exitCode = 2;
}
