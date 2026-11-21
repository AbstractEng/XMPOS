import { z } from "zod";
import { type Project, ProjectSchema } from "../../../core/src/index.ts";
import { type CommunityManifest, TakeSchema, validateTake } from "./contract.ts";
import { type CommunityPackage, canonical, validatePackage } from "./package.ts";
import { migrateState, validateState } from "./program.ts";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
export const CommunityProjectSchema = z
  .object({
    format: z.literal("xmp-community-project"),
    version: z.literal(1),
    project: ProjectSchema,
    bindings: z
      .array(
        z
          .object({
            trackId: id,
            moduleId: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
            packageVersion: z.string().max(24),
            packageHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(8),
    takes: z
      .array(
        z
          .object({ trackId: id, source: z.array(z.string().max(32)).max(8), events: TakeSchema })
          .strict(),
      )
      .max(8),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      new Set(p.bindings.map((b) => b.trackId)).size !== p.bindings.length ||
      new Set(p.takes.map((t) => t.trackId)).size !== p.takes.length
    )
      ctx.addIssue({ code: "custom", message: "Duplicate community track binding/take" });
    for (const b of p.bindings) {
      const track = p.project.tracks.find((t) => t.id === b.trackId);
      if (!track?.machine || track.machine.id !== `community.${b.moduleId}`)
        ctx.addIssue({ code: "custom", message: "Missing or incompatible community track" });
    }
    for (const t of p.takes)
      if (!p.bindings.some((b) => b.trackId === t.trackId))
        ctx.addIssue({ code: "custom", message: "Take references missing community binding" });
  });
export type CommunityProject = z.infer<typeof CommunityProjectSchema>;
export async function bindCommunity(project: Project, trackId: string, pkg: CommunityPackage) {
  const { manifest: m } = await validatePackage(pkg);
  if (m.kind !== "instrument") throw new Error("Track bindings require an instrument package");
  const next = structuredClone(project),
    track = next.tracks.find((t) => t.id === trackId);
  if (!track) throw new Error("Missing track");
  track.machine = {
    id: `community.${m.id}`,
    base: "audio",
    version: m.stateVersion,
    state: Object.fromEntries(m.parameters.map((p) => [p.id, p.default])),
  };
  return CommunityProjectSchema.parse({
    format: "xmp-community-project",
    version: 1,
    project: next,
    bindings: [{ trackId, moduleId: m.id, packageVersion: m.version, packageHash: pkg.sha256 }],
    takes: [],
  });
}
export async function validateCommunityProject(input: unknown, packages: CommunityPackage[]) {
  const project = CommunityProjectSchema.parse(input),
    validated = await Promise.all(packages.map(validatePackage));
  for (const b of project.bindings) {
    const p = validated.find(
        (p) =>
          p.pkg.sha256 === b.packageHash &&
          p.manifest.id === b.moduleId &&
          p.manifest.version === b.packageVersion,
      ),
      track = project.project.tracks.find((t) => t.id === b.trackId);
    if (
      !p ||
      !track?.machine ||
      p.manifest.kind !== "instrument" ||
      track.machine.version !== p.manifest.stateVersion
    )
      throw new Error("Project package/state version unavailable");
    validateState(p.manifest, track.machine.state);
    for (const take of project.takes.filter((t) => t.trackId === b.trackId))
      validateTake(take.events, take.source, p.manifest.capabilities);
  }
  return project;
}
export async function upgradeCommunity(project: CommunityProject, pkg: CommunityPackage) {
  const { manifest: m, program } = await validatePackage(pkg),
    next = structuredClone(project);
  for (const b of next.bindings.filter((b) => b.moduleId === m.id)) {
    const track = next.project.tracks.find((t) => t.id === b.trackId);
    if (!track?.machine) throw new Error("Missing community track");
    const previous = track.machine.version;
    track.machine.state = migrateState(m, program, previous, track.machine.state);
    track.machine.version = m.stateVersion;
    // Existing machine automation cannot silently bind to changed state identities.
    const prefix = `track.${track.id}.machine.community.${m.id}.v${previous}.`;
    if (previous !== m.stateVersion) {
      const mapping = (name: string) => {
        let result = name;
        for (let v = previous; v < m.stateVersion; v++) {
          const migration = program.migrations.find((x) => x.from === v);
          if (!migration) throw new Error("Missing migration");
          result = migration.renames[result] ?? result;
        }
        return result;
      };
      const rename = (id: string) =>
        id.startsWith(prefix)
          ? `track.${track.id}.machine.community.${m.id}.v${m.stateVersion}.${mapping(id.slice(prefix.length))}`
          : id;
      for (const p of next.project.parameters) p.id = rename(p.id);
      for (const c of track.clips)
        for (const p of [
          ...(c.sequence?.lanes ?? []),
          ...(c.sequence?.locks ?? []),
          ...(c.sequence?.modulations ?? []),
        ])
          p.parameter = rename(p.parameter);
      for (const macro of next.project.performance?.macros ?? [])
        for (const a of macro.assignments) a.parameter = rename(a.parameter);
    }
    b.packageVersion = m.version;
    b.packageHash = pkg.sha256;
  }
  return CommunityProjectSchema.parse(next);
}
export function sameParameterContract(before: CommunityManifest, after: CommunityManifest) {
  return (
    canonical(
      before.parameters.map((p) => ({ id: p.id, min: p.min, max: p.max, unit: p.unit })),
    ) ===
    canonical(after.parameters.map((p) => ({ id: p.id, min: p.min, max: p.max, unit: p.unit })))
  );
}
