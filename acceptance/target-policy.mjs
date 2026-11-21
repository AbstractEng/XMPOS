// Host-side policy only. This preview deliberately supplies no physical transport.
// A future USB implementation must also attest the actual peer after connection;
// these untrusted metadata fields alone can never authorize that peer.
export function preflightTarget(request) {
  if (request.profile === "standalone") {
    if (request.device || request.transport) {
      throw new Error("Standalone runs cannot select a physical device or transport");
    }
    return { profile: "standalone", physicalTransport: false };
  }
  if (request.profile === "live-mk1-rootfs") {
    // The owner's device-specific authorization (AGENTS.md): the MPC Live Mk1's
    // rootfs partition only, through fastboot update mode. Never the Force.
    const identity = JSON.stringify(request.device ?? {}).toLowerCase();
    if (request.device?.protected || /force|ada2/.test(identity))
      throw new Error("Protected Force target: passive host inventory only");
    if (!["status", "flash-rootfs", "restore-stock"].includes(request.operation))
      throw new Error(`Operation ${request.operation} is outside the Live Mk1 authorization`);
    return { profile: "live-mk1-rootfs", physicalTransport: true, operation: request.operation };
  }
  if (request.profile === "usb-lab") {
    const model = String(request.device?.model ?? "").toLowerCase();
    if (request.device?.protected || model.includes("force")) {
      throw new Error("Protected Force target: passive host inventory only");
    }
    throw new Error("USB lab adapter is not implemented; no device connection attempted");
  }
  throw new Error("Unknown target profile; no implicit target selection");
}

export async function openTarget(request, transportFactory) {
  const target = preflightTarget(request);
  // Kept as a seam for tests: preflight must precede any physical transport work.
  if (target.physicalTransport) return transportFactory(target);
  return target;
}
