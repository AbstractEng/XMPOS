export const MAX_PROJECT_BYTES = 24 * 1024 * 1024;
export const MAX_SONG_BYTES = 96 * 1024 * 1024;
export const MAX_LOOP_SAMPLE_FRAMES = 1536000;
export const MAX_LOOP_PROJECT_FRAMES = 8000000;
export function extendedSampleProfile(project: unknown): boolean {
  if (!project || typeof project !== "object" || !("extensions" in project)) return false;
  const extensions = project.extensions;
  if (!extensions || typeof extensions !== "object" || !("xmp.extended-samples" in extensions))
    return false;
  const e = extensions["xmp.extended-samples"];
  return (
    !!e &&
    typeof e === "object" &&
    "version" in e &&
    e.version === 1 &&
    "required" in e &&
    e.required === true &&
    "data" in e &&
    !!e.data &&
    typeof e.data === "object" &&
    !Array.isArray(e.data) &&
    Object.keys(e.data).length === 0
  );
}
export const MAX_SAMPLE_FRAMES = 2000000;
// A project's sample pool (format 7: the project's pads and every track's kit).
export const MAX_SAMPLES = 256;
export const MAX_IMPORT_RSS_BYTES = 512 * 1024 * 1024;
// Reject structural amplification before JSON.parse or schema issue allocation.
export function preflightProjectText(text: string, extended = false): void {
  const max = extended ? MAX_SONG_BYTES : MAX_PROJECT_BYTES;
  if (text.length > max)
    throw new Error(`${extended ? "Song" : "Project"} exceeds ${extended ? 96 : 24} MiB`);
  let quoted = false,
    escaped = false,
    stringLength = 0,
    depth = 0,
    objects = 0,
    arrays = 0,
    separators = 0,
    properties = 0,
    word = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (++stringLength > 1024) throw new Error("Project string budget exceeded");
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      stringLength = 0;
      word = 0;
      continue;
    }
    if (char === "{" || char === "[") {
      depth++;
      if (char === "{") objects++;
      else arrays++;
    }
    if (char === "}" || char === "]") depth--;
    if (char === ",") separators++;
    if (char === ":") properties++;
    word = /[0-9a-zA-Z.+-]/.test(char ?? "") ? word + 1 : 0;
    if (
      depth > 32 ||
      objects > 150000 ||
      arrays > 1024 ||
      separators > MAX_SAMPLE_FRAMES + 1000000 ||
      properties > 800000 ||
      word > 128
    )
      throw new Error("Project structure exceeds import budget");
  }
  if (new TextEncoder().encode(text).length > max)
    throw new Error(`${extended ? "Song" : "Project"} exceeds ${extended ? 96 : 24} MiB`);
}
