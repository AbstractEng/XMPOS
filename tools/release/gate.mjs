import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const evidence = z
  .object({
    kind: z.enum(["host-contract", "os-vm", "reliability-vm", "sampler-soak"]),
    sourceHash: digest,
    imageBuildId: digest.nullable(),
    evidenceHash: digest,
    checksPassed: z.boolean(),
  })
  .strict();
export function releaseDecision(input) {
  const candidate = z
    .object({
      sourceHash: digest,
      imageBuildId: digest.nullable(),
      evidence: z.array(evidence).max(4),
      observedSoakOverruns: z.number().int().min(0).nullable(),
    })
    .strict()
    .parse(input);
  const missing = [];
  if (!candidate.imageBuildId) missing.push("booted image identity missing");
  for (const kind of ["host-contract", "os-vm", "reliability-vm", "sampler-soak"]) {
    const records = candidate.evidence.filter((e) => e.kind === kind);
    if (
      records.length !== 1 ||
      !records[0].checksPassed ||
      records[0].sourceHash !== candidate.sourceHash ||
      (["os-vm", "reliability-vm"].includes(kind) &&
        records[0].imageBuildId !== candidate.imageBuildId)
    )
      missing.push(`${kind}: missing, failed, stale or mismatched evidence`);
  }
  return {
    format: "xmp-development-candidate",
    version: 1,
    sourceHash: candidate.sourceHash,
    imageBuildId: candidate.imageBuildId,
    developmentPreviewReady: !missing.length,
    missingDevelopmentEvidence: missing,
    supportedTargets: [
      {
        profile: "p10-qemu-x86_64-v1",
        scope:
          "Generic VM console, offline rendering, project recovery and owned VM update transactions",
      },
    ],
    supportedHardware: [],
    hardwareReady: false,
    fullPhaseQualified: false,
    publicRedistributionApproved: false,
    observedSoakOverruns: candidate.observedSoakOverruns,
    performanceStatus:
      candidate.observedSoakOverruns === null
        ? "unmeasured"
        : candidate.observedSoakOverruns
          ? "development timing budget failed"
          : "short sampler check only; V1 qualification pending",
    pendingReleaseGates: [
      "exact Live Mk1 authorization, drivers, recovery and physical USB evidence",
      "calibrated audio/MIDI/control and battery/thermal measurements",
      "eight-hour final synth/effect workload and zero-xrun qualification",
      "graphical UI and complete native real-time parity",
      "reviewed corresponding source, notices and redistribution rights",
      "reviewed hardware signing, installation and rollback workflow",
    ],
    evidence: candidate.evidence,
  };
}
