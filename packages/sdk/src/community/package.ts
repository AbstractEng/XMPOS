import { z } from "zod";
import { CommunityManifest, negotiateModule } from "./contract.ts";
import { type ProgramSchema, validateProgram } from "./program.ts";
export const MAX_PACKAGE_BYTES = 1048576;
export const canonical = (value: unknown): string =>
  JSON.stringify(
    value && typeof value === "object"
      ? Array.isArray(value)
        ? value.map((v) => JSON.parse(canonical(v)))
        : Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([k, v]) => [k, JSON.parse(canonical(v))]),
          )
      : value,
  );
export async function digest(text: string) {
  const bytes = new TextEncoder().encode(text);
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const files = ["manifest.json", "program.json", "LICENSE", "PARAMETERS.md"] as const;
export const PackageSchema = z
  .object({
    format: z.literal("xmp-package"),
    version: z.literal(1),
    files: z
      .array(
        z
          .object({ path: z.enum(files), content: z.string().min(1).max(262144), sha256: sha })
          .strict(),
      )
      .length(4),
    sha256: sha,
  })
  .strict();
export type CommunityPackage = z.infer<typeof PackageSchema>;
export const mathLibrary = Object.freeze({
  id: "xmp-math",
  version: "1.0.0",
  content: '{"format":"xmp-math","version":"1.0.0","operations":["sine","triangle","one-pole"]}',
});
export async function libraryCatalog() {
  return [{ ...mathLibrary, sha256: await digest(mathLibrary.content) }];
}
export function parameterDocumentation(m: CommunityManifest) {
  return `# ${m.name} parameters\n\nAPI ${m.apiVersion}, DSP ABI ${m.dspAbi}, state ${m.stateVersion}.\n\n${m.parameters.map((p) => `${p.id}: ${p.name}; ${p.unit}; ${p.min}..${p.max}; default ${p.default}`).join("\n")}\n`;
}
export async function validateDependencies(
  m: CommunityManifest,
  program: z.infer<typeof ProgramSchema>,
) {
  const catalog = await libraryCatalog();
  if (program.requires.length !== m.dependencies.length)
    throw new Error("DSP dependency declarations differ from program requirements");
  if (new Set(program.requires.map((d) => d.id)).size !== program.requires.length)
    throw new Error("Duplicate DSP dependency");
  for (const required of program.requires) {
    const declared = m.dependencies.find(
        (d) => d.id === required.id && d.version === required.version,
      ),
      installed = catalog.find((d) => d.id === required.id && d.version === required.version);
    if (!declared || !installed || declared.sha256 !== installed.sha256)
      throw new Error(
        `Unresolved DSP dependency ${required.id}@${required.version}; host catalog only, no global fallback`,
      );
  }
  for (const d of m.dependencies)
    if (!program.requires.some((r) => r.id === d.id && r.version === d.version))
      throw new Error(`Unreferenced DSP dependency ${d.id}@${d.version}`);
}
export async function validatePackage(input: unknown) {
  const pkg = PackageSchema.parse(input);
  if (new TextEncoder().encode(JSON.stringify(pkg)).length > MAX_PACKAGE_BYTES)
    throw new Error("Package exceeds 1 MiB");
  if (new Set(pkg.files.map((f) => f.path)).size !== 4)
    throw new Error("Missing or duplicate package file");
  for (const file of pkg.files)
    if ((await digest(file.content)) !== file.sha256)
      throw new Error(`Integrity mismatch: ${file.path}`);
  const sorted = [...pkg.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if ((await digest(canonical(sorted))) !== pkg.sha256)
    throw new Error("Package integrity mismatch");
  const content = (name: (typeof files)[number]) => {
    const found = pkg.files.find((f) => f.path === name);
    if (!found) throw new Error(`Missing ${name}`);
    return found.content;
  };
  const manifest = negotiateModule(JSON.parse(content("manifest.json"))).manifest,
    program = validateProgram(manifest, JSON.parse(content("program.json")));
  if (!content("LICENSE").includes(manifest.license) || content("LICENSE").length < 64)
    throw new Error("Missing or mismatched licence notice");
  if (content("PARAMETERS.md") !== parameterDocumentation(manifest))
    throw new Error("Parameter documentation differs from manifest");
  await validateDependencies(manifest, program);
  return { pkg, manifest, program };
}
export async function parsePackage(text: string) {
  if (new TextEncoder().encode(text).length > MAX_PACKAGE_BYTES)
    throw new Error("Package exceeds 1 MiB");
  return validatePackage(JSON.parse(text));
}
export async function buildPackage(manifest: unknown, program: unknown, license: string) {
  const m = CommunityManifest.parse(manifest),
    p = validateProgram(m, program);
  await validateDependencies(m, p);
  const contents = {
    "manifest.json": canonical(m),
    "program.json": canonical(p),
    LICENSE: license,
    "PARAMETERS.md": parameterDocumentation(m),
  };
  const entries = await Promise.all(
    files.map(async (path) => ({
      path,
      content: contents[path],
      sha256: await digest(contents[path]),
    })),
  );
  const pkg: CommunityPackage = {
    format: "xmp-package",
    version: 1,
    files: entries,
    sha256: await digest(
      canonical([...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
    ),
  };
  return (await validatePackage(pkg)).pkg;
}
